/*
 * Selbsttest gegen Fredy. Läuft beim Start, danach stündlich und auf der Admin-Übersicht.
 *
 * Fredys REST-API ist intern und unversioniert. Statt still kaputtzugehen, prüft die Bridge, ob
 * jeder genutzte Endpunkt noch existiert: Ohne Anmeldung antwortet ein vorhandener, geschützter
 * Endpunkt mit 401, ein verschwundener mit 404.
 *
 * Ergebnisse tragen Übersetzungsschlüssel; die Oberfläche zeigt sie in der Sprache des Betrachters,
 * das Log auf Englisch.
 */

import { getSetting } from './db.js';
import { translator } from './i18n.js';
import { log } from './log.js';

const ENDPOINTS = [
  ['DELETE', '/api/listings'],
  ['POST', '/api/listings/restore'],
  ['GET', '/api/listings/table'],
  ['POST', '/api/listings/selftest/status'],
  ['POST', '/api/listings/selftest/scam'],
  ['POST', '/api/listings/selftest/details'],
  ['POST', '/api/jobs/selftest/run'],
  ['PUT', '/api/jobs/selftest/status'],
  ['GET', '/api/admin/users/selftest/mcp-token'],
  ['GET', '/api/user/settings'],
  ['POST', '/api/user/settings/finance-profile'],
  ['GET', '/api/finance/profile-summary'],
  ['POST', '/api/mcp'],
];

export async function runSelfTest({ fredy, config, db }) {
  const checks = [];
  // name/message sind Übersetzungsschlüssel; raw ist ein unübersetzbarer Text (z. B. Fehlermeldung).
  const add = (state, name, message, vars = {}) => checks.push({ state, name, message, vars });
  const addRaw = (state, name, raw) => checks.push({ state, name, raw });

  try {
    const response = await fetch(`${config.fredyUrl}/api/login/user`);
    if (response.ok) addRaw('ok', 'check.fredy', config.fredyUrl);
    else add('bad', 'check.fredy', 'check.fredyStatus', { url: config.fredyUrl, status: response.status });
  } catch (error) {
    addRaw('bad', 'check.fredy', `${config.fredyUrl}: ${error.cause?.code || error.message}`);
    return checks;
  }

  const missing = [];
  for (const [method, path] of ENDPOINTS) {
    try {
      const response = await fetch(`${config.fredyUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      if (response.status === 404) missing.push(`${method} ${path}`);
    } catch {
      missing.push(`${method} ${path}`);
    }
  }
  if (missing.length) add('bad', 'check.endpoints', 'check.endpointsMissing', { list: missing.join(', ') });
  else add('ok', 'check.endpoints', 'check.endpointsOk', { count: ENDPOINTS.length });

  const admin = config.adminUsername || getSetting(db, 'token_admin_username');
  if (!admin) {
    add('warn', 'check.proxy', 'check.proxyPending');
  } else {
    try {
      const identity = await fredy.whoIs(admin, { fresh: true });
      if (identity?.isAdmin) add('ok', 'check.proxy', 'check.proxyOk', { user: admin });
      else if (identity) add('warn', 'check.proxy', 'check.proxyNotAdmin', { user: admin });
      else add('bad', 'check.proxy', 'check.proxyRejected');
    } catch (error) {
      addRaw('bad', 'check.proxy', error.message);
    }
  }
  return checks;
}

export async function logSelfTest(deps) {
  const checks = await runSelfTest(deps);
  const { t } = translator('en');
  for (const check of checks) {
    const line = `Self-test: ${t(check.name)} – ${check.raw ?? t(check.message, check.vars)}`;
    if (check.state === 'ok') log.info(line);
    else if (check.state === 'warn') log.warn(line);
    else log.error(`!!! ${line}`);
  }
  return checks;
}
