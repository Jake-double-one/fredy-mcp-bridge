/*
 * Der MCP-Endpunkt der Bridge (/mcp). Zustandslos: pro HTTP-Anfrage ein frischer Server, damit
 * ein Neustart der Bridge keine Verbindung kaputt macht.
 *
 * Die Tool-Liste wird bei jeder Anfrage neu aus den aktuellen Rechten gebaut, und jeder Aufruf
 * wird noch einmal geprüft – Clients halten Tool-Listen gern eine Weile zwischengespeichert.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { effectivePermissions, permissionForFredyTool } from './permissions.js';
import { translator } from './i18n.js';
import { BRIDGE_TOOLS } from './tools.js';
import { now } from './db.js';
import { log } from './log.js';

// Meldungen an das Sprachmodell bleiben Englisch.
const en = translator('en');

function denied(config, permission, toolName) {
  return {
    content: [
      {
        type: 'text',
        text:
          `This connection is not allowed to use "${toolName}" (permission "${en.t(`perm.${permission}.label`)}" is off). ` +
          `The user can enable it at ${config.publicUrl}.`,
      },
    ],
    isError: true,
  };
}

export function createMcpHandler({ db, fredy, upstream, config }) {
  const touch = db.prepare('UPDATE grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)');

  return async function handleMcp(req, res) {
    const grant = db.prepare('SELECT * FROM grants WHERE id = ?').get(req.auth?.extra?.grantId);
    if (!grant) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Connection was revoked.' });
      return;
    }
    const t = now();
    touch.run(t, grant.id, t - 60);

    // Die Identität wird erst geholt, wenn ein Tool sie braucht – „initialize“ klappt so auch,
    // wenn Fredy gerade neu startet.
    let context;
    const resolve = async () => {
      if (context) return context;
      let identity;
      try {
        identity = await fredy.whoIs(grant.username);
      } catch (error) {
        log.error(`Fredy not reachable: ${error.message}`);
        throw new McpError(ErrorCode.InternalError, `Fredy is not reachable right now (${error.message}).`);
      }
      if (!identity) {
        throw new McpError(
          ErrorCode.InternalError,
          'Fredy did not confirm this user via the reverse-proxy sign-in. Either the user no longer exists in Fredy, ' +
            'or the reverse-proxy sign-in in Fredy is not set up for the bridge.',
        );
      }
      if (identity.userId !== grant.user_id) {
        throw new McpError(ErrorCode.InvalidRequest, 'The Fredy account behind this connection has changed. Please reconnect.');
      }
      const fresh = db.prepare('SELECT * FROM grants WHERE id = ?').get(grant.id);
      const permissions = effectivePermissions(db, fresh, identity);
      const blocked = new Set(JSON.parse(fresh.blocked_tools || '[]'));
      let upstreamTools = [];
      let upstreamError = null;
      try {
        upstreamTools = await upstream.listTools(identity);
      } catch (error) {
        upstreamError = error;
        log.error(`Could not list Fredy's MCP tools for ${identity.username}: ${error.message}`);
      }
      context = { identity, permissions, blocked, upstreamTools, upstreamError };
      return context;
    };

    const server = new Server(
      { name: 'fredy-mcp-bridge', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions:
          'Fredy real-estate search (via fredy-mcp-bridge). To delete listings use hide_listings: hidden listings do not come back with ' +
          'future searches and can be restored. Only use delete_listings_permanently when the user explicitly wants permanent deletion.',
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const { permissions, blocked, upstreamTools } = await resolve();
      const upstreamNames = new Set(upstreamTools.map((t) => t.name));
      const tools = [
        ...upstreamTools.filter((t) => permissions.has(permissionForFredyTool(t)) && !blocked.has(t.name)),
        ...BRIDGE_TOOLS.filter((t) => permissions.has(t.permission) && !upstreamNames.has(t.name)).map((t) => ({
          name: t.name,
          ...t.definition,
        })),
      ];
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const { identity, permissions, blocked, upstreamTools, upstreamError } = await resolve();
      const fromFredy = upstreamTools.find((t) => t.name === name);

      if (fromFredy) {
        const permission = permissionForFredyTool(fromFredy);
        if (!permissions.has(permission)) return denied(config, permission, name);
        if (blocked.has(name)) {
          return {
            content: [{ type: 'text', text: `The tool "${name}" is blocked for this connection. The user can unblock it at ${config.publicUrl}.` }],
            isError: true,
          };
        }
        log.info(`${identity.username} → Fredy tool ${name}`);
        return upstream.callTool(identity, name, args);
      }

      const own = BRIDGE_TOOLS.find((t) => t.name === name);
      if (own) {
        if (!permissions.has(own.permission)) return denied(config, own.permission, name);
        log.info(`${identity.username} → bridge tool ${name}`);
        try {
          return await own.run(fredy, identity.username, args ?? {});
        } catch (error) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
      }

      if (upstreamError) {
        return { content: [{ type: 'text', text: `Fredy's own tools are unavailable right now: ${upstreamError.message}` }], isError: true };
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
