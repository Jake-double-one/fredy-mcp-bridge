import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { BridgeOAuthProvider } from '../src/oauth.js';
import { buildInstructions } from '../src/mcpServer.js';

const config = { publicUrl: 'https://bridge.example', mcpUrl: 'https://bridge.example/mcp', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 };
const setup = () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-tok-')));
  return { db, oauth: new BridgeOAuthProvider(db, config) };
};

test('static token works like a connection and dies with it', async () => {
  const { db, oauth } = setup();
  const { grantId, token } = oauth.createStaticToken({ userId: 'u1', username: 'bob', name: 'OpenClaw', permissions: ['fredy.read'], expiresInDays: 90 });
  assert.match(token, /^fmb_/);
  const info = await oauth.verifyAccessToken(token);
  assert.equal(info.extra.grantId, grantId);
  assert.ok(info.expiresAt > Date.now() / 1000 + 89 * 86400);
  const grant = db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId);
  assert.equal(grant.kind, 'token');
  assert.equal(grant.client_name, 'OpenClaw');
  db.prepare('DELETE FROM grants WHERE id = ?').run(grantId);
  await assert.rejects(oauth.verifyAccessToken(token));
});

test('expired and unknown static tokens are refused; no-expiry tokens get a rolling expiresAt', async () => {
  const { db, oauth } = setup();
  const { token } = oauth.createStaticToken({ userId: 'u1', username: 'bob', name: 'x', permissions: [], expiresInDays: 30 });
  db.prepare('UPDATE static_tokens SET expires_at = 1').run();
  await assert.rejects(oauth.verifyAccessToken(token));
  await assert.rejects(oauth.verifyAccessToken('fmb_nope'));
  const forever = oauth.createStaticToken({ userId: 'u1', username: 'bob', name: 'y', permissions: [], expiresInDays: null });
  const info = await oauth.verifyAccessToken(forever.token);
  assert.ok(info.expiresAt > Date.now() / 1000);
});

test("Fredy's own guidance is passed on after the bridge's", () => {
  assert.ok(!buildInstructions(null).includes("Fredy's own guidance"));
  const combined = buildInstructions('Use list_jobs to browse jobs.');
  assert.ok(combined.startsWith('This server is Fredy'));
  assert.ok(combined.endsWith('Use list_jobs to browse jobs.'));
});
