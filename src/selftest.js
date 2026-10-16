/*
 * Selbsttest gegen Fredy. Läuft beim Start, danach stündlich und auf der Admin-Übersicht.
 *
 * Fredys REST-API ist intern und unversioniert. Statt still kaputtzugehen, prüft die Bridge, ob
 * jeder genutzte Endpunkt noch existiert: Ohne Anmeldung antwortet ein vorhandener, geschützter
 * Endpunkt mit 401, ein verschwundener mit 404.
 */

import { getSetting } from './db.js';
import { log } from './log.js';

const ENDPOINTS = [
  ['DELETE', '/api/listings', 'Inserate löschen/ausblenden'],
  ['POST', '/api/listings/restore', 'Inserate wiederherstellen'],
  ['GET', '/api/listings/table', 'Ausgeblendete Inserate auflisten'],
  ['POST', '/api/listings/selftest/status', 'Bewerbungsstatus'],
  ['POST', '/api/listings/selftest/scam', 'Betrugsmarkierung'],
  ['POST', '/api/jobs/selftest/run', 'Job starten'],
  ['PUT', '/api/jobs/selftest/status', 'Job aktivieren/pausieren'],
  ['GET', '/api/admin/users/selftest/mcp-token', 'MCP-Token abholen'],
  ['POST', '/api/mcp', 'Fredys MCP-Server'],
];

export async function runSelfTest({ fredy, config, db }) {
  const checks = [];
  const add = (state, name, message) => checks.push({ state, name, message });

  try {
    const response = await fetch(`${config.fredyUrl}/api/login/user`);
    if (response.ok) add('ok', 'Fredy erreichbar', config.fredyUrl);
    else add('bad', 'Fredy erreichbar', `${config.fredyUrl} antwortet mit ${response.status}`);
  } catch (error) {
    add('bad', 'Fredy erreichbar', `${config.fredyUrl}: ${error.cause?.code || error.message}`);
    return checks;
  }

  const missing = [];
  for (const [method, path, label] of ENDPOINTS) {
    try {
      const response = await fetch(`${config.fredyUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      if (response.status === 404) missing.push(`${label} (${method} ${path})`);
    } catch {
      missing.push(`${label} (${method} ${path})`);
    }
  }
  if (missing.length) {
    add('bad', 'Fredy-Endpunkte', `Nicht mehr vorhanden – Fredy hat seine API geändert: ${missing.join(', ')}`);
  } else {
    add('ok', 'Fredy-Endpunkte', `Alle ${ENDPOINTS.length} genutzten Endpunkte vorhanden.`);
  }

  const admin = config.adminUsername || getSetting(db, 'token_admin_username');
  if (!admin) {
    add('warn', 'Reverse-Proxy-Anmeldung', 'Noch nicht prüfbar: Ein Fredy-Admin muss sich einmal an der Bridge anmelden.');
  } else {
    try {
      const identity = await fredy.whoIs(admin, { fresh: true });
      if (identity?.isAdmin) {
        add('ok', 'Reverse-Proxy-Anmeldung', `Fredy bestätigt „${admin}“ (Admin).`);
      } else if (identity) {
        add('warn', 'Reverse-Proxy-Anmeldung', `„${admin}“ ist in Fredy kein Admin mehr – MCP-Tokens anderer Benutzer sind nicht abrufbar.`);
      } else {
        add(
          'bad',
          'Reverse-Proxy-Anmeldung',
          'Fredy akzeptiert die Bridge nicht. In Fredy unter System → „Anmeldung durch den Reverse-Proxy“: Haken setzen, IP der Bridge, Header-Namen und Geheimnis prüfen.',
        );
      }
    } catch (error) {
      add('bad', 'Reverse-Proxy-Anmeldung', error.message);
    }
  }
  return checks;
}

export async function logSelfTest(deps) {
  const checks = await runSelfTest(deps);
  for (const check of checks) {
    const line = `Selbsttest: ${check.name} – ${check.message}`;
    if (check.state === 'ok') log.info(line);
    else if (check.state === 'warn') log.warn(line);
    else log.error(`!!! ${line}`);
  }
  return checks;
}
