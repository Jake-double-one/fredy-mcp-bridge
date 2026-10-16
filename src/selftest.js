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
  ['GET', '/api/listings/selftest/priceHistory'],
  ['POST', '/api/user/settings/home-address'],
  ['GET', '/api/transit/travel-times'],
  ['POST', '/api/user/settings/applicant-profile'],
  ['POST', '/api/user/settings/application-templates'],
  ['POST', '/api/user/settings/application-preview'],
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

/** Letztes Ergebnis – Grundlage für /healthz und die Admin-Übersicht. */
export const selfTestState = { at: 0, checks: [] };

/** Gesund, solange keine Prüfung „bad“ ist („warn“ – z. B. noch kein Admin angemeldet – zählt nicht). */
export function isHealthy() {
  return !selfTestState.checks.some((c) => c.state === 'bad');
}

/**
 * Führt den Selbsttest aus und schreibt ins Log – beim ersten Lauf vollständig, danach nur, wenn
 * sich etwas geändert hat. So bleibt das Log ruhig, obwohl alle paar Minuten geprüft wird.
 */
export async function logSelfTest(deps) {
  const checks = await runSelfTest(deps);
  const { t } = translator('en');
  const lines = checks.map((check) => ({
    state: check.state,
    text: `Self-test: ${t(check.name)} – ${check.raw ?? t(check.message, check.vars)}`,
  }));
  const signature = JSON.stringify(lines);
  if (signature !== selfTestState.signature) {
    for (const { state, text } of lines) {
      if (state === 'ok') log.info(text);
      else if (state === 'warn') log.warn(text);
      else log.error(`!!! ${text}`);
    }
  }
  Object.assign(selfTestState, { at: Date.now(), checks, signature });
  return checks;
}
