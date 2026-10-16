import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from './config.js';
import { openDatabase, sweep } from './db.js';
import { FredyClient, UpstreamPool } from './fredy.js';
import { BridgeOAuthProvider, OAUTH_SCOPE } from './oauth.js';
import { createMcpHandler } from './mcpServer.js';
import { createWebRouter } from './web.js';
import { logSelfTest, isHealthy, selfTestState } from './selftest.js';
import { log, setLogLevel } from './log.js';

export function createApp(config, db) {
  const fredy = new FredyClient(config, db);
  const upstream = new UpstreamPool(fredy, config);
  const oauth = new BridgeOAuthProvider(db, config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // Für den Docker-Healthcheck: 503, sobald der Selbsttest eine Prüfung als fehlgeschlagen meldet
  // (Fredy nicht erreichbar, API geändert, Proxy-Anmeldung kaputt). Portainer zeigt dann „unhealthy“.
  app.get('/healthz', (req, res) => {
    const failing = selfTestState.checks.filter((c) => c.state === 'bad').map((c) => c.name.replace(/^check\./, ''));
    res.status(isHealthy() ? 200 : 503).json({ ok: isHealthy(), failing });
  });

  const issuerUrl = new URL(config.publicUrl);
  const mcpUrl = new URL(config.mcpUrl);
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [OAUTH_SCOPE],
      resourceName: 'Fredy',
    }),
  );
  // Manche Clients fragen die Metadaten ohne Pfad-Suffix ab.
  const resourceMetadata = {
    resource: mcpUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: 'Fredy',
  };
  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json(resourceMetadata));

  const bearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  const handleMcp = createMcpHandler({ db, fredy, upstream, config });
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    try {
      await handleMcp(req, res);
    } catch (error) {
      log.error('MCP request failed', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });
  // Zustandsloser Server: kein SSE-Stream, keine Sitzungen zum Beenden.
  app.all('/mcp', bearer, (req, res) => {
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  app.use(createWebRouter({ db, fredy, upstream, oauth, config }));

  return { app, fredy, upstream, oauth };
}

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const db = openDatabase(config.dataDir);
  const { app, fredy } = createApp(config, db);

  sweep(db);
  setInterval(() => sweep(db), 60 * 60 * 1000).unref();

  app.listen(config.port, () => {
    log.info(`Fredy MCP Bridge listening on port ${config.port} – public: ${config.publicUrl}, Fredy: ${config.fredyUrl}`);
  });

  // Alle 5 Minuten prüfen; nach einem Fehler schon nach 30 Sekunden erneut, damit ein kurzer
  // Aussetzer (z. B. Fredy startet langsamer als die Bridge) nicht minutenlang „unhealthy“ bleibt.
  const selfTest = async () => {
    await logSelfTest({ fredy, config, db }).catch((error) => log.error('Self-test failed', error));
    setTimeout(selfTest, isHealthy() ? 5 * 60 * 1000 : 30 * 1000).unref();
  };
  setTimeout(selfTest, 3000).unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log.error(error);
    process.exit(1);
  });
}
