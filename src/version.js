/*
 * Versions- und Build-Infos. Im Docker-Image setzt der Build REVISION und BUILD_DATE;
 * lokal (npm start) stehen dort Platzhalter.
 */

import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const REPO_URL = 'https://github.com/Jake-double-one/fredy-mcp-bridge';

const revision = process.env.BRIDGE_REVISION && process.env.BRIDGE_REVISION !== 'unknown' ? process.env.BRIDGE_REVISION : null;
const buildDate = process.env.BRIDGE_BUILD_DATE && !Number.isNaN(Date.parse(process.env.BRIDGE_BUILD_DATE)) ? process.env.BRIDGE_BUILD_DATE : null;

export const VERSION = {
  version: pkg.version,
  revision,
  shortRevision: revision ? revision.slice(0, 7) : null,
  buildDate,
  commitUrl: revision ? `${REPO_URL}/commit/${revision}` : null,
};

const LATEST_TTL_MS = 2 * 60 * 60 * 1000;
let latestCache = { at: 0, value: null };

/**
 * Neuester Stand von main auf GitHub (zwischengespeichert, damit das Limit der GitHub-API von
 * 60 Anfragen pro Stunde nie erreicht wird). Ohne Netz oder bei Fehlern: null.
 */
export async function latestBridgeRevision() {
  if (Date.now() - latestCache.at < LATEST_TTL_MS) return latestCache.value;
  let value = null;
  try {
    const response = await fetch('https://api.github.com/repos/Jake-double-one/fredy-mcp-bridge/commits/main', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'fredy-mcp-bridge' },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      if (typeof data?.sha === 'string') value = { sha: data.sha, date: data.commit?.committer?.date ?? null };
    }
  } catch {
    /* kein Netz – dann eben keine Update-Info */
  }
  latestCache = { at: Date.now(), value };
  return value;
}
