/*
 * Eigener Zustand der Bridge: OAuth-Clients, Verbindungen (Grants) samt Berechtigungen, Tokens,
 * Web-Sitzungen und Rollen-Obergrenzen. Fredys Datenbank wird nie angefasst.
 *
 * Tokens, Codes und Sitzungs-IDs werden nur als SHA-256-Hash gespeichert.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE clients (
    client_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE pending_authorizations (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    params TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    redirect_host TEXT,
    permissions TEXT NOT NULL,
    blocked_tools TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (user_id, client_id)
  );

  CREATE TABLE auth_codes (
    code_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    resource TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX tokens_family ON tokens(family_id);
  CREATE INDEX tokens_grant ON tokens(grant_id);

  CREATE TABLE web_sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    is_admin INTEGER NOT NULL,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE role_policies (
    role TEXT PRIMARY KEY CHECK (role IN ('admin', 'user')),
    allowed TEXT NOT NULL
  );
  `,
  // Sprache der Web-Sitzung (aus dem Fredy-Profil).
  `ALTER TABLE web_sessions ADD COLUMN lang TEXT;`,
  // Neue Rechte fürs Finanzprofil: in bereits gespeicherten Rollen-Obergrenzen erlauben, wie im
  // Standard. Jede Verbindung muss sie trotzdem einzeln einschalten (Opt-in).
  `UPDATE role_policies SET allowed = json_insert(json_insert(allowed, '$[#]', 'finance.read'), '$[#]', 'finance.write');`,
  // Neues Recht „Inseratstexte nachladen“, ebenso in bestehenden Obergrenzen erlauben.
  `UPDATE role_policies SET allowed = json_insert(allowed, '$[#]', 'listings.details');`,
];

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'bridge.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true });
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Abgelaufene Codes, Tokens, Sitzungen und nie genutzte Client-Registrierungen entfernen. */
export function sweep(db) {
  const t = now();
  db.prepare('DELETE FROM pending_authorizations WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(t);
  db.prepare(
    `DELETE FROM clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM grants)`,
  ).run(t - 24 * 60 * 60);
}
