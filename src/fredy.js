/*
 * Alles, was mit Fredy spricht.
 *
 * - Passwortprüfung über Fredys eigenen Login (POST /api/login). Die Bridge speichert kein Passwort.
 * - Handeln „als Benutzer X“ über Fredys Reverse-Proxy-Anmeldung: Die Bridge setzt den
 *   Benutzernamen-Header und das gemeinsame Geheimnis. Fredy akzeptiert das nur von der
 *   eingetragenen IP der Bridge und wendet dann seine eigenen Regeln an (eigene/geteilte Jobs,
 *   Admin-Prüfung, Demo-Modus). Die Bridge baut keine dieser Prüfungen nach.
 * - Durchreichen von Fredys eigenem MCP-Server mit dem MCP-Token des jeweiligen Benutzers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getSetting } from './db.js';
import { log } from './log.js';
import { VERSION } from './version.js';

const SESSION_COOKIE = 'fredy-admin-session';
const IDENTITY_TTL_MS = 60 * 1000;
const LANGUAGE_TTL_MS = 60 * 1000;
const TOOLS_TTL_MS = 60 * 1000;

export class FredyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function sessionCookieFrom(response) {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0];
    if (pair.startsWith(`${SESSION_COOKIE}=`)) return pair;
  }
  return null;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class FredyClient {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    // Pro Benutzername eine Fredy-Sitzung wiederverwenden, statt bei jedem Aufruf eine neue
    // anzulegen (sonst landet jeder Tool-Aufruf als eigener Login in Fredys Log).
    this.cookieJar = new Map();
    this.identityCache = new Map();
    this.languageCache = new Map();
  }

  url(path) {
    return `${this.config.fredyUrl}${path}`;
  }

  /**
   * Prüft Benutzername und Passwort bei Fredy. Gibt bei Erfolg die Fredy-Identität zurück.
   * Die dabei entstandene Fredy-Sitzung wird sofort wieder abgemeldet.
   */
  async checkPassword(username, password) {
    const response = await fetch(this.url('/api/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (response.status === 429) return { ok: false, reason: 'rate_limited' };
    if (response.status !== 200) return { ok: false, reason: 'invalid' };

    const cookie = sessionCookieFrom(response);
    if (!cookie) throw new FredyError('Fredy did not return a session after sign-in.', 502);
    try {
      const me = await fetch(this.url('/api/login/user'), { headers: { cookie } }).then(readBody);
      if (!me?.userId) throw new FredyError('Fredy did not return the signed-in user.', 502);
      // Sprache aus dem Fredy-Profil; ohne Eintrag zeigt Fredy Englisch.
      const settings = await fetch(this.url('/api/user/settings'), { headers: { cookie } })
        .then(readBody)
        .catch(() => null);
      return {
        ok: true,
        user: { userId: String(me.userId), username: me.username, isAdmin: !!me.isAdmin },
        language: typeof settings?.language === 'string' ? settings.language : null,
      };
    } finally {
      await fetch(this.url('/api/login/logout'), { method: 'POST', headers: { cookie } }).catch(() => {});
    }
  }

  /** Eine Anfrage an Fredys REST-API im Namen eines Benutzers (Reverse-Proxy-Anmeldung). */
  async asUser(username, method, path, body) {
    const send = async () => {
      const headers = {
        [this.config.proxyUserHeader]: username,
        [this.config.proxySecretHeader]: this.config.proxySecret,
      };
      const cookie = this.cookieJar.get(username);
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const fresh = sessionCookieFrom(response);
      if (fresh) this.cookieJar.set(username, fresh);
      return response;
    };

    let response = await send();
    if (response.status === 401 && this.cookieJar.has(username)) {
      // Gespeicherte Sitzung ungültig (z. B. Fredy neu gestartet) – ohne Cookie neu versuchen,
      // dann meldet Fredy uns über den Proxy-Header frisch an.
      this.cookieJar.delete(username);
      response = await send();
    }
    return { status: response.status, data: await readBody(response) };
  }

  /**
   * Wer ist dieser Benutzer laut Fredy – und funktioniert die Proxy-Anmeldung?
   * Gibt null zurück, wenn Fredy den Benutzer nicht (mehr) kennt oder die Proxy-Anmeldung
   * nicht eingerichtet ist.
   */
  async whoIs(username, { fresh = false } = {}) {
    const cached = this.identityCache.get(username);
    if (!fresh && cached && cached.expires > Date.now()) return cached.identity;

    const { status, data } = await this.asUser(username, 'GET', '/api/login/user');
    if (status !== 200) throw new FredyError(`Fredy answered with status ${status}.`, status);
    const identity = data?.userId
      ? { userId: String(data.userId), username: data.username, isAdmin: !!data.isAdmin }
      : null;
    // Ein Benutzer gilt nur als „er selbst“, wenn Fredy genau diesen Namen bestätigt.
    const confirmed = identity && identity.username === username ? identity : null;
    this.identityCache.set(username, { identity: confirmed, expires: Date.now() + IDENTITY_TTL_MS });
    return confirmed;
  }

  forgetIdentity(username) {
    this.identityCache.delete(username);
    this.languageCache.delete(username);
  }

  /** Sprache aus dem Fredy-Profil des Benutzers (oder null, wenn keine gewählt ist). */
  async languageOf(username) {
    const cached = this.languageCache.get(username);
    if (cached && cached.expires > Date.now()) return cached.language;
    const { status, data } = await this.asUser(username, 'GET', '/api/user/settings');
    if (status !== 200) throw new FredyError(`Fredy answered with status ${status}.`, status);
    const language = typeof data?.language === 'string' ? data.language : null;
    this.languageCache.set(username, { language, expires: Date.now() + LANGUAGE_TTL_MS });
    return language;
  }

  /** Welcher Fredy-Admin darf die MCP-Tokens anderer Benutzer abholen? */
  tokenAdminFor(identity) {
    if (identity.isAdmin) return identity.username;
    return this.config.adminUsername || getSetting(this.db, 'token_admin_username');
  }

  async fetchMcpToken(identity) {
    const admin = this.tokenAdminFor(identity);
    if (!admin) {
      throw new FredyError(
        'The bridge does not know a Fredy admin yet. An admin has to sign in to the bridge once ' +
          '(or set FREDY_ADMIN_USERNAME) so that the users\' MCP tokens can be fetched.',
        503,
      );
    }
    const { status, data } = await this.asUser(
      admin,
      'GET',
      `/api/admin/users/${encodeURIComponent(identity.userId)}/mcp-token`,
    );
    if (status !== 200 || !data?.mcpToken) {
      throw new FredyError(`Could not fetch the MCP token for ${identity.username} (status ${status}).`, status);
    }
    return data.mcpToken;
  }
}

/**
 * Nur Fehler, bei denen Fredy den Aufruf sicher nicht ausgeführt hat, lösen einen zweiten Versuch
 * aus: unbekannte/abgelaufene MCP-Sitzung (404), abgelehntes Token (401) oder gar keine Verbindung.
 * So wird ein Schreib-Tool nie doppelt ausgeführt.
 */
function isConnectionError(error) {
  if (error?.code === 401 || error?.code === 404) return true;
  const cause = error?.cause?.code || error?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause);
}

/**
 * Hält pro Fredy-Benutzer eine MCP-Client-Verbindung zu Fredys eigenem /api/mcp.
 */
export class UpstreamPool {
  constructor(fredy, config) {
    this.fredy = fredy;
    this.config = config;
    this.connections = new Map();
    // Fredys eigene Anleitung für Clients („instructions“ aus initialize). Sie ist für alle
    // Benutzer gleich und wird an die Clients der Bridge weitergereicht.
    this.instructions = null;
  }

  async connect(identity) {
    const token = await this.fredy.fetchMcpToken(identity);
    const client = new Client({ name: 'fredy-mcp-bridge', version: VERSION.version });
    const transport = new StreamableHTTPClientTransport(new URL(`${this.config.fredyUrl}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    this.instructions = client.getInstructions() || this.instructions;
    return { client, tools: null, toolsExpires: 0 };
  }

  async connection(identity) {
    let entry = this.connections.get(identity.userId);
    if (!entry) {
      entry = this.connect(identity);
      this.connections.set(identity.userId, entry);
      entry.catch(() => this.connections.delete(identity.userId));
    }
    return entry;
  }

  async drop(identity) {
    const entry = this.connections.get(identity.userId);
    this.connections.delete(identity.userId);
    if (entry) {
      try {
        (await entry).client.close();
      } catch {
        /* egal */
      }
    }
  }

  async withRetry(identity, fn) {
    try {
      return await fn(await this.connection(identity));
    } catch (error) {
      if (error instanceof FredyError || !isConnectionError(error)) throw error;
      // Fredy neu gestartet, Sitzung abgelaufen, Token geändert: einmal frisch verbinden.
      log.warn(`Reconnecting to Fredy's MCP for ${identity.username}: ${error.message}`);
      await this.drop(identity);
      return fn(await this.connection(identity));
    }
  }

  async listTools(identity) {
    return this.withRetry(identity, async (conn) => {
      if (conn.tools && conn.toolsExpires > Date.now()) return conn.tools;
      const tools = [];
      let cursor;
      do {
        const page = await conn.client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      conn.tools = tools;
      conn.toolsExpires = Date.now() + TOOLS_TTL_MS;
      return tools;
    });
  }

  async callTool(identity, name, args) {
    return this.withRetry(identity, (conn) => conn.client.callTool({ name, arguments: args ?? {} }));
  }
}
