import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, now } from '../src/db.js';
import { BridgeOAuthProvider } from '../src/oauth.js';
import {
  DEFAULT_ROLE_POLICIES,
  defaultPermissions,
  effectivePermissions,
  permissionForFredyTool,
  setRolePolicy,
} from '../src/permissions.js';

const config = {
  publicUrl: 'https://bridge.example',
  mcpUrl: 'https://bridge.example/mcp',
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 86400,
};

function setup() {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-')));
  const oauth = new BridgeOAuthProvider(db, config);
  const client = oauth.clientsStore.registerClient({ client_id: 'c1', redirect_uris: ['https://claude.ai/cb'], client_name: 'Claude' });
  db.prepare(
    `INSERT INTO grants (id, user_id, username, client_id, client_name, permissions, created_at, updated_at)
     VALUES ('g1', 'u1', 'bob', 'c1', 'Claude', ?, ?, ?)`,
  ).run(JSON.stringify(['fredy.read', 'listings.hide', 'listings.hard_delete']), now(), now());
  return { db, oauth, client };
}

async function codeFor(oauth, client) {
  const res = { redirect: (status, url) => (res.location = url) };
  await oauth.authorize(client, { redirectUri: 'https://claude.ai/cb', codeChallenge: 'chal', state: 's' }, res);
  const pending = oauth.getPending(new URL(res.location, 'https://x').searchParams.get('req'));
  const back = new URL(oauth.completeAuthorization(pending, 'g1'));
  assert.equal(back.searchParams.get('state'), 's');
  return back.searchParams.get('code');
}

test('authorization code is single use and yields working tokens', async () => {
  const { oauth, client } = setup();
  const code = await codeFor(oauth, client);
  assert.equal(await oauth.challengeForAuthorizationCode(client, code), 'chal');
  const tokens = await oauth.exchangeAuthorizationCode(client, code, undefined, 'https://claude.ai/cb', new URL(config.mcpUrl));
  const info = await oauth.verifyAccessToken(tokens.access_token);
  assert.equal(info.extra.grantId, 'g1');
  await assert.rejects(oauth.exchangeAuthorizationCode(client, code), /Invalid or expired/);
});

test('code from another client or resource is refused', async () => {
  const { oauth, client } = setup();
  const code = await codeFor(oauth, client);
  await assert.rejects(oauth.challengeForAuthorizationCode({ client_id: 'other' }, code));
  await assert.rejects(oauth.exchangeAuthorizationCode(client, code, undefined, undefined, new URL('https://evil.example/mcp')));
});

test('refresh tokens rotate; an old one replayed later revokes the family', async () => {
  const { db, oauth, client } = setup();
  const first = await oauth.exchangeAuthorizationCode(client, await codeFor(oauth, client));
  const second = await oauth.exchangeRefreshToken(client, first.refresh_token);
  await assert.rejects(oauth.exchangeRefreshToken(client, first.refresh_token), /already used/);
  // within the grace window the new tokens survive
  assert.ok(await oauth.verifyAccessToken(second.access_token));
  // pretend the old token was used long ago -> replay kills the whole family
  db.prepare('UPDATE tokens SET used_at = used_at - 3600 WHERE used_at IS NOT NULL').run();
  await assert.rejects(oauth.exchangeRefreshToken(client, first.refresh_token));
  await assert.rejects(oauth.verifyAccessToken(second.access_token));
});

test('revoking the grant kills its tokens immediately', async () => {
  const { db, oauth, client } = setup();
  const tokens = await oauth.exchangeAuthorizationCode(client, await codeFor(oauth, client));
  db.prepare("DELETE FROM grants WHERE id = 'g1'").run();
  await assert.rejects(oauth.verifyAccessToken(tokens.access_token));
});

test('effective permissions are grant ∩ role ceiling, evaluated live', () => {
  const { db } = setup();
  const grant = db.prepare("SELECT * FROM grants WHERE id = 'g1'").get();
  const asUser = effectivePermissions(db, grant, { isAdmin: false });
  assert.deepEqual([...asUser].sort(), ['fredy.read', 'listings.hide']);
  const asAdmin = effectivePermissions(db, grant, { isAdmin: true });
  assert.ok(asAdmin.has('listings.hard_delete'));
  setRolePolicy(db, 'admin', ['fredy.read']);
  assert.deepEqual([...effectivePermissions(db, grant, { isAdmin: true })], ['fredy.read']);
});

test('defaults: Fredy features on, bridge extras off', () => {
  assert.deepEqual(defaultPermissions(DEFAULT_ROLE_POLICIES.admin), ['fredy.read', 'fredy.write']);
  assert.equal(permissionForFredyTool({ annotations: { readOnlyHint: true } }), 'fredy.read');
  assert.equal(permissionForFredyTool({ annotations: { readOnlyHint: false } }), 'fredy.write');
  assert.equal(permissionForFredyTool({}), 'fredy.write');
});
