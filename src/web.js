/*
 * Weboberfläche: Login (mit Fredy-Zugangsdaten), Freigabe-Dialog, Verwaltung der Verbindungen,
 * Rollen-Obergrenzen.
 */

import express from 'express';
import crypto from 'node:crypto';
import { randomToken, sha256, now, setSetting, grantName } from './db.js';
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
import { normalizeLanguage, translator, DEFAULT_LANGUAGE } from './i18n.js';
import { runSelfTest } from './selftest.js';
import { log } from './log.js';

const COOKIE = 'fmb_session';
// Merkt sich die zuletzt genutzte Sprache, damit schon die Login-Seite passt.
const LANG_COOKIE = 'fmb_lang';
const FLASH = { saved: 'flash.saved', revoked: 'flash.revoked', rolesSaved: 'flash.rolesSaved' };
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
        let lang = row.lang;
        // Rolle und Sprache aktuell halten: Änderungen in Fredy gelten hier ab der nächsten Minute –
        // sofern Fredy den Benutzer über die Proxy-Anmeldung bestätigt.
        try {
          const identity = await fredy.whoIs(row.username);
          if (identity?.userId === row.user_id) {
            const fresh = (await fredy.languageOf(row.username)) || DEFAULT_LANGUAGE;
            if (identity.isAdmin !== req.user.isAdmin || fresh !== lang) {
              req.user.isAdmin = identity.isAdmin;
              lang = fresh;
              db.prepare('UPDATE web_sessions SET is_admin = ?, lang = ? WHERE id_hash = ?').run(identity.isAdmin ? 1 : 0, lang, row.id_hash);
            }
          }
        } catch {
          /* Fredy kurz nicht erreichbar: bisherige Rolle und Sprache behalten */
        }
        req.i = translator(lang);
      }
    }
    req.i ??= translator(normalizeLanguage(parseCookies(req.headers.cookie)[LANG_COOKIE]) || DEFAULT_LANGUAGE);
    next();
  });

  const setCookie = (res, value, maxAge, name = COOKIE) => {
    res.append(
      'Set-Cookie',
      `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`,
    );
  };
  const message = (req, res, status, titleKey, messageKey) =>
    res.status(status).send(messagePage(req.i, { title: req.i.t(titleKey), message: req.i.t(messageKey), user: req.user, csrf: req.csrf }));

  const requireLogin = (req, res, next) => {
    if (!req.user) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (!req.user?.isAdmin) {
      return message(req, res, 403, 'error.forbiddenTitle', 'error.adminOnly');
    }
    next();
  };
  const checkCsrf = (req, res, next) => {
    const sent = String(req.body?._csrf || '');
    const ok = req.csrf && sent.length === req.csrf.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.csrf));
    if (!ok) {
      return message(req, res, 403, 'error.csrfTitle', 'error.csrf');
    }
    next();
  };

  // ---- Login -------------------------------------------------------------------------------
  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(303, safeNext(req.query.next));
    res.send(loginPage(req.i, { next: safeNext(req.query.next) }));
  });

  router.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const next = safeNext(req.body.next);
    const ipKey = `ip:${req.ip}`;
    const userKey = `user:${username.toLowerCase()}`;
    const show = (status, key) => res.status(status).send(loginPage(req.i, { error: req.i.t(key), next, username }));

    if (!username || !password) return show(400, 'login.errorMissing');
    if (limiter.count(ipKey) >= MAX_FAILS_PER_IP || limiter.count(userKey) >= MAX_FAILS_PER_USER) {
      return show(429, 'login.errorTooMany');
    }

    let result;
    try {
      result = await fredy.checkPassword(username, password);
    } catch (error) {
      log.error(`Password check against Fredy failed: ${error.message}`);
      return show(502, 'login.errorUnreachable');
    }
    if (!result.ok) {
      if (result.reason === 'rate_limited') return show(429, 'login.errorFredyRateLimit');
      limiter.add(ipKey);
      limiter.add(userKey);
      log.warn(`Failed sign-in for "${username}" from ${req.ip}`);
      return show(401, 'login.errorInvalid');
    }

    limiter.clear(userKey);
    const { user } = result;
    if (user.isAdmin && !config.adminUsername) setSetting(db, 'token_admin_username', user.username);
    fredy.forgetIdentity(user.username);

    const lang = normalizeLanguage(result.language) || DEFAULT_LANGUAGE;
    const raw = randomToken(32);
    const t = now();
    db.prepare(
      'INSERT INTO web_sessions (id_hash, user_id, username, is_admin, csrf, lang, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(sha256(raw), user.userId, user.username, user.isAdmin ? 1 : 0, randomToken(24), lang, t, t + config.webSessionTtlSeconds);
    setCookie(res, raw, config.webSessionTtlSeconds);
    setCookie(res, lang, 365 * 24 * 60 * 60, LANG_COOKIE);
    log.info(`Sign-in: ${user.username}${user.isAdmin ? ' (admin)' : ''} from ${req.ip}`);
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
      return message(req, res, 400, 'error.requestExpiredTitle', 'error.requestExpired');
    }
    const ceiling = getRolePolicy(db, roleOf(req.user));
    const existing = db.prepare('SELECT * FROM grants WHERE user_id = ? AND client_id = ?').get(req.user.userId, pending.client.client_id);
    const selected = existing ? JSON.parse(existing.permissions) : defaultPermissions(ceiling);
    res.send(consentPage(req.i, { user: req.user, csrf: req.csrf, pending, ceiling, selected, existing }));
  });

  router.post('/consent', requireLogin, checkCsrf, (req, res) => {
    const pending = oauth.getPending(String(req.body.req || ''));
    if (!pending) {
      return message(req, res, 400, 'error.requestExpiredTitle', 'error.requestExpired');
    }
    if (req.body.action !== 'allow') return res.redirect(303, oauth.denyAuthorization(pending));

    const ceiling = new Set(getRolePolicy(db, roleOf(req.user)));
    const permissions = sanitizePermissions(list(req.body.perm)).filter((key) => ceiling.has(key));
    const t = now();
    const clientName = String(pending.client.client_name || 'Unknown client').slice(0, 120);
    const redirectHost = new URL(pending.redirectUri).host;
    db.prepare(
      `INSERT INTO grants (id, user_id, username, client_id, client_name, redirect_host, permissions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, client_id) DO UPDATE SET permissions = excluded.permissions, username = excluded.username,
         client_name = excluded.client_name, updated_at = excluded.updated_at`,
    ).run(randomToken(12), req.user.userId, req.user.username, pending.client.client_id, clientName, redirectHost, JSON.stringify(permissions), t, t);
    const grant = db.prepare('SELECT id FROM grants WHERE user_id = ? AND client_id = ?').get(req.user.userId, pending.client.client_id);
    log.info(`Connection approved: ${req.user.username} → ${clientName} [${permissions.join(', ')}]`);
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
      dashboardPage(req.i, {
        user: req.user,
        csrf: req.csrf,
        mcpUrl: config.mcpUrl,
        myGrants,
        otherGrants,
        ceilings,
        proxyOk,
        checks,
        flash: FLASH[req.query.ok] || null,
      }),
    );
  });

  // ---- Einzelne Verbindung -----------------------------------------------------------------
  const loadGrant = (req, res, next) => {
    const grant = db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    if (!grant || (grant.user_id !== req.user.userId && !req.user.isAdmin)) {
      return message(req, res, 404, 'error.notFoundTitle', 'error.connectionNotFound');
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
      upstreamError = req.i.t('connPage.ownerUnconfirmed');
    } else {
      try {
        upstreamTools = await upstream.listTools(identity);
      } catch (error) {
        upstreamError = error.message;
      }
    }
    res.send(
      connectionPage(req.i, {
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
    // Eigener Name: Steuerzeichen raus, Leerraum zusammenfassen, max. 60 Zeichen; leer = Client-Name.
    const customName =
      String(req.body.name ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || null;
    db.prepare('UPDATE grants SET permissions = ?, blocked_tools = ?, custom_name = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(permissions),
      JSON.stringify(blocked),
      customName,
      now(),
      req.grant.id,
    );
    log.info(
      `Connection updated by ${req.user.username}: ${req.grant.username} → ${customName || req.grant.client_name} [${permissions.join(', ')}]`,
    );
    res.redirect(303, '/?ok=saved');
  });

  router.post('/connections/:id/revoke', requireLogin, checkCsrf, loadGrant, (req, res) => {
    db.prepare('DELETE FROM grants WHERE id = ?').run(req.grant.id);
    log.info(`Connection revoked by ${req.user.username}: ${req.grant.username} → ${grantName(req.grant)}`);
    res.redirect(303, '/?ok=revoked');
  });

  // ---- Rollen-Obergrenzen ------------------------------------------------------------------
  router.get('/admin/roles', requireLogin, requireAdmin, (req, res) => {
    const policies = Object.fromEntries(Object.keys(ROLES).map((role) => [role, getRolePolicy(db, role)]));
    res.send(rolesPage(req.i, { user: req.user, csrf: req.csrf, policies }));
  });

  router.post('/admin/roles', requireLogin, requireAdmin, checkCsrf, (req, res) => {
    for (const role of Object.keys(ROLES)) setRolePolicy(db, role, list(req.body[role]));
    log.info(`Role limits changed by ${req.user.username}`);
    res.redirect(303, '/?ok=rolesSaved');
  });

  return router;
}
