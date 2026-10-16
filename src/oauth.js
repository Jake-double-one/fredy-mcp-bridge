/*
 * OAuth 2.1 Authorization Server für Remote-Connectoren (Claude.ai, ChatGPT, …).
 *
 * Die Protokoll-Endpunkte (/register, /authorize, /token, /revoke, Metadaten) stellt das
 * offizielle MCP-SDK bereit; hier steckt nur die Speicherung. Die Berechtigungen hängen nicht an
 * OAuth-Scopes, sondern an der Verbindung (Grant) in der Bridge-Datenbank – so wirken Änderungen
 * auf der Verwaltungsseite sofort, ohne dass der Client sich neu verbinden muss.
 */

import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { randomToken, sha256, now, STATIC_TOKEN_PREFIX } from './db.js';

export const OAUTH_SCOPE = 'fredy';
const CODE_TTL = 5 * 60;
const PENDING_TTL = 15 * 60;
// Gleichzeitige Refreshs eines Clients sollen eine Verbindung nicht sofort sprengen.
const REFRESH_REPLAY_GRACE = 30;

function sameUrl(a, b) {
  const clean = (v) => String(v).split('#')[0].replace(/\/$/, '');
  return clean(a) === clean(b);
}

export class BridgeOAuthProvider {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.clientsStore = {
      getClient: (clientId) => {
        const row = db.prepare('SELECT data FROM clients WHERE client_id = ?').get(clientId);
        return row ? JSON.parse(row.data) : undefined;
      },
      registerClient: (client) => {
        db.prepare('INSERT INTO clients (client_id, data, created_at) VALUES (?, ?, ?)').run(
          client.client_id,
          JSON.stringify(client),
          now(),
        );
        return client;
      },
    };
  }

  checkResource(resource) {
    if (resource && !sameUrl(resource, this.config.mcpUrl) && !sameUrl(resource, this.config.publicUrl)) {
      throw new InvalidTargetError(`Unknown resource ${resource}`);
    }
  }

  /** Startet den Freigabe-Dialog: Anfrage merken, dann zu Login/Freigabe weiterleiten. */
  async authorize(client, params, res) {
    this.checkResource(params.resource);
    const id = randomToken(18);
    this.db
      .prepare('INSERT INTO pending_authorizations (id, client_id, params, expires_at) VALUES (?, ?, ?, ?)')
      .run(
        id,
        client.client_id,
        JSON.stringify({
          state: params.state,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
        }),
        now() + PENDING_TTL,
      );
    res.redirect(302, `/consent?req=${encodeURIComponent(id)}`);
  }

  getPending(id) {
    const row = this.db.prepare('SELECT * FROM pending_authorizations WHERE id = ? AND expires_at >= ?').get(id, now());
    if (!row) return null;
    const client = this.clientsStore.getClient(row.client_id);
    if (!client) return null;
    return { id: row.id, client, ...JSON.parse(row.params) };
  }

  deletePending(id) {
    this.db.prepare('DELETE FROM pending_authorizations WHERE id = ?').run(id);
  }

  /** Nach „Verbinden“: einmaligen Code ausstellen und die Weiterleitungs-URL zum Client bauen. */
  completeAuthorization(pending, grantId) {
    const code = randomToken(32);
    this.db
      .prepare(
        `INSERT INTO auth_codes (code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(code), grantId, pending.client.client_id, pending.codeChallenge, pending.redirectUri, this.config.mcpUrl, now() + CODE_TTL);
    this.deletePending(pending.id);
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    return target.href;
  }

  denyAuthorization(pending) {
    this.deletePending(pending.id);
    const target = new URL(pending.redirectUri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'The user denied the request.');
    if (pending.state) target.searchParams.set('state', pending.state);
    return target.href;
  }

  findCode(client, code) {
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(sha256(code));
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return row;
  }

  async challengeForAuthorizationCode(client, code) {
    return this.findCode(client, code).code_challenge;
  }

  issueTokens(grantId, clientId, familyId = randomToken(12)) {
    const t = now();
    const access = randomToken(32);
    const refresh = randomToken(32);
    const insert = this.db.prepare(
      `INSERT INTO tokens (token_hash, kind, grant_id, client_id, family_id, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(sha256(access), 'access', grantId, clientId, familyId, this.config.mcpUrl, t, t + this.config.accessTokenTtlSeconds);
    insert.run(sha256(refresh), 'refresh', grantId, clientId, familyId, this.config.mcpUrl, t, t + this.config.refreshTokenTtlSeconds);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refresh,
      scope: OAUTH_SCOPE,
    };
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
    this.checkResource(resource);
    return this.db.transaction(() => {
      const row = this.findCode(client, code);
      this.db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').run(row.code_hash);
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
      return this.issueTokens(row.grant_id, client.client_id);
    })();
  }

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    this.checkResource(resource);
    // Ergebnis erst in der Transaktion ermitteln, Fehler danach werfen – sonst würde der
    // Widerruf der Token-Familie mit dem Fehler zurückgerollt.
    const outcome = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(sha256(refreshToken));
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        return { error: 'Invalid or expired refresh token' };
      }
      if (row.used_at) {
        if (now() - row.used_at > REFRESH_REPLAY_GRACE) {
          // Ein alter Refresh-Token taucht wieder auf: vermutlich gestohlen. Ganze Token-Familie widerrufen.
          this.db.prepare('DELETE FROM tokens WHERE family_id = ?').run(row.family_id);
        }
        return { error: 'Refresh token already used' };
      }
      this.db.prepare('UPDATE tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
      return { tokens: this.issueTokens(row.grant_id, client.client_id, row.family_id) };
    })();
    if (outcome.error) throw new InvalidGrantError(outcome.error);
    return outcome.tokens;
  }

  async verifyAccessToken(token) {
    if (token.startsWith(STATIC_TOKEN_PREFIX)) return this.verifyStaticToken(token);
    const row = this.db
      .prepare(
        `SELECT t.*, g.id AS gid FROM tokens t JOIN grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND t.kind = 'access'`,
      )
      .get(sha256(token));
    if (!row || row.expires_at < now()) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.client_id,
      scopes: [OAUTH_SCOPE],
      expiresAt: row.expires_at,
      resource: new URL(this.config.mcpUrl),
      extra: { grantId: row.grant_id },
    };
  }

  /** Fester Zugangs-Token (Verbindung vom Typ „token“). */
  verifyStaticToken(token) {
    const row = this.db
      .prepare(
        `SELECT s.*, g.client_id FROM static_tokens s JOIN grants g ON g.id = s.grant_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token));
    if (!row || (row.expires_at && row.expires_at < now())) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.client_id,
      scopes: [OAUTH_SCOPE],
      // Das SDK verlangt ein Ablaufdatum; ohne eigenes gilt der Token jeweils eine Stunde ab jetzt.
      expiresAt: row.expires_at ?? now() + 3600,
      resource: new URL(this.config.mcpUrl),
      extra: { grantId: row.grant_id },
    };
  }

  /** Legt eine Token-Verbindung an und gibt den Klartext-Token einmalig zurück. */
  createStaticToken({ userId, username, name, permissions, expiresInDays }) {
    const t = now();
    const grantId = randomToken(12);
    const token = `${STATIC_TOKEN_PREFIX}${randomToken(32)}`;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO grants (id, user_id, username, client_id, client_name, redirect_host, permissions, kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'token', ?, ?)`,
        )
        .run(grantId, userId, username, `token:${grantId}`, name, JSON.stringify(permissions), t, t);
      this.db
        .prepare('INSERT INTO static_tokens (token_hash, grant_id, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256(token), grantId, token.slice(0, 10), t, expiresInDays ? t + expiresInDays * 86400 : null);
    })();
    return { grantId, token };
  }

  async revokeToken(client, request) {
    const row = this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(sha256(request.token));
    if (!row || row.client_id !== client.client_id) return;
    if (row.kind === 'refresh') {
      this.db.prepare('DELETE FROM tokens WHERE family_id = ?').run(row.family_id);
    } else {
      this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(row.token_hash);
    }
  }
}
