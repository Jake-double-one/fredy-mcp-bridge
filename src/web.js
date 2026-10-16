/*
 * Weboberfläche: Login (mit Fredy-Zugangsdaten), Freigabe-Dialog, Verwaltung der Verbindungen,
 * Rollen-Obergrenzen.
 */

import express from 'express';
import crypto from 'node:crypto';
import { randomToken, sha256, now, setSetting } from './db.js';
import {
  ROLES,
  defaultPermissions,
  getRolePolicy,
  permissionForFredyTool,
  roleOf,
  sanitizePermissions,
  setRolePolicy,
} from './permissions.js';
import { consentPage, connectionPage, dashboardPage, loginPage, messagePage, rolesPage } from './views.js';
import { runSelfTest } from './selftest.js';
import { log } from './log.js';

const COOKIE = 'fmb_session';
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 10;
const MAX_FAILS_PER_USER = 5;

/** Fehlversuche zählen – vor Fredy, damit niemand über die Bridge deinen Fredy-Login sperrt. */
class FailureLimiter {
  constructor() {
    this.hits = new Map();
  }
  count(key) {
    const list = (this.hits.get(key) || []).filter((t) => t > Date.now() - WINDOW_MS);
    this.hits.set(key, list);
    return list.length;
  }
  add(key) {
    this.count(key);
    this.hits.get(key).push(Date.now());
  }
  clear(key) {
    this.hits.delete(key);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeNext(next) {
  // Nur relative Ziele innerhalb der Bridge – kein Open Redirect.
  // „/\\host“ behandeln Browser wie „//host“, daher Backslashes generell ablehnen.
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
}

function list(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function createWebRouter({ db, fredy, upstream, oauth, config }) {
  const router = express.Router();
  const limiter = new FailureLimiter();
  const secureCookie = config.publicUrl.startsWith('https://');
  let selfTestCache = { at: 0, checks: [] };

  router.use(express.urlencoded({ extended: false, limit: '50kb' }));
  router.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ---- Sitzung -----------------------------------------------------------------------------
  router.use(async (req, res, next) => {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (raw) {
      const row = db.prepare('SELECT * FROM web_sessions WHERE id_hash = ? AND expires_at >= ?').get(sha256(raw), now());
      if (row) {
        req.user = { userId: row.user_id, username: row.username, isAdmin: !!row.is_admin };
        req.csrf = row.csrf;
        req.sessionHash = row.id_hash;
        // Rolle aktuell halten: Wird jemand in Fredy zum Admin gemacht oder herabgestuft, gilt das
        // hier ab der nächsten Minute – sofern Fredy den Benutzer über die Proxy-Anmeldung bestätigt.
        try {
          const identity = await fredy.whoIs(row.username);
          if (identity?.userId === row.user_id && identity.isAdmin !== req.user.isAdmin) {
            req.user.isAdmin = identity.isAdmin;
            db.prepare('UPDATE web_sessions SET is_admin = ? WHERE id_hash = ?').run(identity.isAdmin ? 1 : 0, row.id_hash);
          }
        } catch {
          /* Fredy kurz nicht erreichbar: bisherige Rolle behalten */
        }
      }
    }
    next();
  });

  const setCookie = (res, value, maxAge) => {
    res.append(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`,
    );
  };

  const requireLogin = (req, res, next) => {
    if (!req.user) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (!req.user?.isAdmin) {
      return res.status(403).send(messagePage({ title: 'Kein Zugriff', message: 'Nur für Fredy-Admins.', user: req.user, csrf: req.csrf }));
    }
    next();
  };
  const checkCsrf = (req, res, next) => {
    const sent = String(req.body?._csrf || '');
    const ok = req.csrf && sent.length === req.csrf.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.csrf));
    if (!ok) {
      return res.status(403).send(messagePage({ title: 'Abgelaufen', message: 'Formular abgelaufen. Bitte neu laden.', user: req.user, csrf: req.csrf }));
    }
    next();
  };

  // ---- Login -------------------------------------------------------------------------------
  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(303, safeNext(req.query.next));
    res.send(loginPage({ next: safeNext(req.query.next) }));
  });

  router.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const next = safeNext(req.body.next);
    const ipKey = `ip:${req.ip}`;
    const userKey = `user:${username.toLowerCase()}`;
    const show = (status, error) => res.status(status).send(loginPage({ error, next, username }));

    if (!username || !password) return show(400, 'Bitte Benutzername und Passwort eingeben.');
    if (limiter.count(ipKey) >= MAX_FAILS_PER_IP || limiter.count(userKey) >= MAX_FAILS_PER_USER) {
      return show(429, 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
    }

    let result;
    try {
      result = await fredy.checkPassword(username, password);
    } catch (error) {
      log.error(`Login-Prüfung bei Fredy fehlgeschlagen: ${error.message}`);
      return show(502, 'Fredy ist gerade nicht erreichbar.');
    }
    if (!result.ok) {
      if (result.reason === 'rate_limited') return show(429, 'Fredy hat zu viele Anmeldeversuche gezählt. Bitte später erneut versuchen.');
      limiter.add(ipKey);
      limiter.add(userKey);
      log.warn(`Fehlgeschlagener Login für „${username}“ von ${req.ip}`);
      return show(401, 'Benutzername oder Passwort falsch.');
    }

    limiter.clear(userKey);
    const { user } = result;
    if (user.isAdmin && !config.adminUsername) setSetting(db, 'token_admin_username', user.username);
    fredy.forgetIdentity(user.username);

    const raw = randomToken(32);
    const t = now();
    db.prepare(
      'INSERT INTO web_sessions (id_hash, user_id, username, is_admin, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(sha256(raw), user.userId, user.username, user.isAdmin ? 1 : 0, randomToken(24), t, t + config.webSessionTtlSeconds);
    setCookie(res, raw, config.webSessionTtlSeconds);
    log.info(`Login: ${user.username}${user.isAdmin ? ' (Admin)' : ''} von ${req.ip}`);
    res.redirect(303, next);
  });

  router.post('/logout', requireLogin, checkCsrf, (req, res) => {
    db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(req.sessionHash);
    setCookie(res, '', 0);
    res.redirect(303, '/login');
  });

  // ---- Freigabe (OAuth-Consent) ------------------------------------------------------------
  router.get('/consent', requireLogin, (req, res) => {
    const pending = oauth.getPending(String(req.query.req || ''));
    if (!pending) {
      return res.status(400).send(
        messagePage({
          title: 'Anfrage abgelaufen',
          message: 'Diese Verbindungsanfrage ist abgelaufen oder unbekannt. Bitte im Client erneut verbinden.',
          user: req.user,
          csrf: req.csrf,
        }),
      );
    }
    const ceiling = getRolePolicy(db, roleOf(req.user));
    const existing = db.prepare('SELECT * FROM grants WHERE user_id = ? AND client_id = ?').get(req.user.userId, pending.client.client_id);
    const selected = existing ? JSON.parse(existing.permissions) : defaultPermissions(ceiling);
    res.send(consentPage({ user: req.user, csrf: req.csrf, pending, ceiling, selected, existing }));
  });

  router.post('/consent', requireLogin, checkCsrf, (req, res) => {
    const pending = oauth.getPending(String(req.body.req || ''));
    if (!pending) {
      return res.status(400).send(
        messagePage({ title: 'Anfrage abgelaufen', message: 'Bitte im Client erneut verbinden.', user: req.user, csrf: req.csrf }),
      );
    }
    if (req.body.action !== 'allow') return res.redirect(303, oauth.denyAuthorization(pending));

    const ceiling = new Set(getRolePolicy(db, roleOf(req.user)));
    const permissions = sanitizePermissions(list(req.body.perm)).filter((key) => ceiling.has(key));
    const t = now();
    const clientName = String(pending.client.client_name || 'Unbekannter Client').slice(0, 120);
    const redirectHost = new URL(pending.redirectUri).host;
    db.prepare(
      `INSERT INTO grants (id, user_id, username, client_id, client_name, redirect_host, permissions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, client_id) DO UPDATE SET permissions = excluded.permissions, username = excluded.username,
         client_name = excluded.client_name, updated_at = excluded.updated_at`,
    ).run(randomToken(12), req.user.userId, req.user.username, pending.client.client_id, clientName, redirectHost, JSON.stringify(permissions), t, t);
    const grant = db.prepare('SELECT id FROM grants WHERE user_id = ? AND client_id = ?').get(req.user.userId, pending.client.client_id);
    log.info(`Verbindung freigegeben: ${req.user.username} → ${clientName} [${permissions.join(', ')}]`);
    res.redirect(303, oauth.completeAuthorization(pending, grant.id));
  });

  // ---- Übersicht ---------------------------------------------------------------------------
  router.get('/', requireLogin, async (req, res) => {
    const myGrants = db.prepare('SELECT * FROM grants WHERE user_id = ? ORDER BY created_at DESC').all(req.user.userId);
    let otherGrants = [];
    let checks = [];
    if (req.user.isAdmin) {
      otherGrants = db.prepare('SELECT * FROM grants WHERE user_id <> ? ORDER BY username, created_at DESC').all(req.user.userId);
      for (const grant of otherGrants) {
        try {
          grant.isAdmin = !!(await fredy.whoIs(grant.username))?.isAdmin;
        } catch {
          grant.isAdmin = false;
        }
      }
      if (Date.now() - selfTestCache.at > 5 * 60 * 1000) {
        selfTestCache = { at: Date.now(), checks: await runSelfTest({ fredy, config, db }) };
      }
      checks = selfTestCache.checks;
    }
    let proxyOk = null;
    try {
      proxyOk = (await fredy.whoIs(req.user.username))?.userId === req.user.userId;
    } catch {
      proxyOk = null;
    }
    const ceilings = Object.fromEntries(Object.keys(ROLES).map((role) => [role, getRolePolicy(db, role)]));
    res.send(
      dashboardPage({
        user: req.user,
        csrf: req.csrf,
        mcpUrl: config.mcpUrl,
        myGrants,
        otherGrants,
        ceilings,
        proxyOk,
        checks,
        flash: req.query.ok ? String(req.query.ok) : null,
      }),
    );
  });

  // ---- Einzelne Verbindung -----------------------------------------------------------------
  const loadGrant = (req, res, next) => {
    const grant = db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    if (!grant || (grant.user_id !== req.user.userId && !req.user.isAdmin)) {
      return res.status(404).send(messagePage({ title: 'Nicht gefunden', message: 'Diese Verbindung gibt es nicht (mehr).', user: req.user, csrf: req.csrf }));
    }
    req.grant = grant;
    next();
  };

  /** Rolle des Verbindungs-Inhabers – nicht unbedingt die des Betrachters (Admin sieht fremde). */
  const ownerContext = async (grant, viewer) => {
    if (grant.user_id === viewer.userId) return { identity: viewer, role: roleOf(viewer) };
    const identity = await fredy.whoIs(grant.username).catch(() => null);
    return { identity: identity?.userId === grant.user_id ? identity : null, role: roleOf(identity) };
  };

  router.get('/connections/:id', requireLogin, loadGrant, async (req, res) => {
    const { identity, role } = await ownerContext(req.grant, req.user);
    let upstreamTools = [];
    let upstreamError = null;
    if (!identity) {
      upstreamError = 'Fredy bestätigt den Inhaber dieser Verbindung gerade nicht.';
    } else {
      try {
        upstreamTools = await upstream.listTools(identity);
      } catch (error) {
        upstreamError = error.message;
      }
    }
    res.send(
      connectionPage({
        user: req.user,
        csrf: req.csrf,
        grant: req.grant,
        ceiling: getRolePolicy(db, role),
        upstreamTools,
        upstreamError,
        permissionFor: permissionForFredyTool,
      }),
    );
  });

  router.post('/connections/:id', requireLogin, checkCsrf, loadGrant, async (req, res) => {
    const { role } = await ownerContext(req.grant, req.user);
    const ceiling = new Set(getRolePolicy(db, role));
    const previous = sanitizePermissions(JSON.parse(req.grant.permissions));
    // Rechte außerhalb der Obergrenze werden auf der Seite nicht angezeigt; die gespeicherte
    // Auswahl dafür bleibt erhalten, damit sie wieder greift, wenn ein Admin sie zurückgibt.
    const permissions = [
      ...sanitizePermissions(list(req.body.perm)).filter((key) => ceiling.has(key)),
      ...previous.filter((key) => !ceiling.has(key)),
    ];
    let blocked = JSON.parse(req.grant.blocked_tools || '[]');
    if (req.body.toolsShown === '1') {
      const { identity } = await ownerContext(req.grant, req.user);
      if (identity) {
        const allowedTools = new Set(list(req.body.tool));
        const tools = await upstream.listTools(identity).catch(() => null);
        if (tools) blocked = tools.map((t) => t.name).filter((name) => !allowedTools.has(name));
      }
    }
    db.prepare('UPDATE grants SET permissions = ?, blocked_tools = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(permissions),
      JSON.stringify(blocked),
      now(),
      req.grant.id,
    );
    log.info(`Rechte geändert von ${req.user.username}: ${req.grant.username} → ${req.grant.client_name} [${permissions.join(', ')}]`);
    res.redirect(303, `/?ok=${encodeURIComponent('Gespeichert.')}`);
  });

  router.post('/connections/:id/revoke', requireLogin, checkCsrf, loadGrant, (req, res) => {
    db.prepare('DELETE FROM grants WHERE id = ?').run(req.grant.id);
    log.info(`Verbindung getrennt von ${req.user.username}: ${req.grant.username} → ${req.grant.client_name}`);
    res.redirect(303, `/?ok=${encodeURIComponent('Verbindung getrennt.')}`);
  });

  // ---- Rollen-Obergrenzen ------------------------------------------------------------------
  router.get('/admin/roles', requireLogin, requireAdmin, (req, res) => {
    const policies = Object.fromEntries(Object.keys(ROLES).map((role) => [role, getRolePolicy(db, role)]));
    res.send(rolesPage({ user: req.user, csrf: req.csrf, policies }));
  });

  router.post('/admin/roles', requireLogin, requireAdmin, checkCsrf, (req, res) => {
    for (const role of Object.keys(ROLES)) setRolePolicy(db, role, list(req.body[role]));
    log.info(`Rollen-Obergrenzen geändert von ${req.user.username}`);
    res.redirect(303, `/?ok=${encodeURIComponent('Rollen-Obergrenzen gespeichert.')}`);
  });

  return router;
}
