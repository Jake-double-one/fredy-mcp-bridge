import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_TOOLS } from '../src/profileTools.js';

const tool = (name) => PROFILE_TOOLS.find((t) => t.name === name);
const body = (result) => JSON.parse(result.content[0].text);

/** Minimaler Fredy: merkt sich Einstellungen und protokolliert Aufrufe. */
function fakeFredy(settings = {}) {
  const calls = [];
  return {
    calls,
    settings,
    async asUser(username, method, path, payload) {
      calls.push({ method, path, payload });
      if (method === 'GET' && path === '/api/user/settings') return { status: 200, data: structuredClone(settings) };
      if (path === '/api/user/settings/home-address') {
        settings.home_addresses = payload.home_addresses.map((p) => (p.kind ? p : { ...p, coords: p.address.includes('Nowhere') ? { lat: -1, lng: -1 } : { lat: 51, lng: 7 } }));
        return { status: 200, data: { success: true, home_addresses: settings.home_addresses, queued: 3 } };
      }
      if (path === '/api/user/settings/applicant-profile') {
        settings.applicant_profile = payload.applicant_profile;
        return { status: 200, data: { success: true, applicant_profile: payload.applicant_profile } };
      }
      if (path === '/api/user/settings/application-templates') {
        settings.application_templates = payload.application_templates;
        return { status: 200, data: { success: true } };
      }
      return { status: 404, data: null };
    },
  };
}

test('set_place adds, changes by label and keeps the other places', async () => {
  const fredy = fakeFredy({ home_addresses: [{ label: 'Work', address: 'Hauptstr. 1, Dortmund', coords: { lat: 1, lng: 2 }, mode: 'car' }] });
  let r = await tool('set_place').run(fredy, 'bob', { label: 'Nearest school', category: 'school', mode: 'walk', departureTime: '07:30' });
  assert.equal(body(r).saved, 'added');
  assert.equal(fredy.settings.home_addresses.length, 2);
  assert.deepEqual(fredy.settings.home_addresses[1], { label: 'Nearest school', mode: 'walk', kind: 'category', category: 'school', departure: { time: '07:30' } });
  r = await tool('set_place').run(fredy, 'bob', { label: 'work', mode: 'bike' });
  assert.equal(body(r).saved, 'changed');
  assert.equal(fredy.settings.home_addresses[0].address, 'Hauptstr. 1, Dortmund');
  assert.equal(fredy.settings.home_addresses[0].mode, 'bike');
  assert.equal(fredy.settings.home_addresses[0].label, 'Work', 'changing does not rename');
  await tool('set_place').run(fredy, 'bob', { label: 'work', newLabel: 'Büro' });
  assert.equal(fredy.settings.home_addresses[0].label, 'Büro');
  const clash = await tool('set_place').run(fredy, 'bob', { label: 'Büro', newLabel: 'nearest SCHOOL' });
  assert.equal(clash.isError, true);
  const lastSave = fredy.calls.filter((c) => c.method === 'POST').at(-1);
  assert.ok(!('coords' in lastSave.payload.home_addresses[0]), 'coordinates are not sent back; Fredy geocodes');
});

test('set_place validates input and warns about addresses Fredy cannot find', async () => {
  const fredy = fakeFredy({});
  assert.equal((await tool('set_place').run(fredy, 'bob', { label: 'X' })).isError, true);
  assert.equal((await tool('set_place').run(fredy, 'bob', { label: 'X', address: 'a b c', category: 'school' })).isError, true);
  assert.equal((await tool('set_place').run(fredy, 'bob', { label: 'X', address: 'Somewhere 1', departureTime: '7 Uhr' })).isError, true);
  const r = await tool('set_place').run(fredy, 'bob', { label: 'Oma', address: 'Nowhere 99' });
  assert.match(body(r).note, /could not find this address/);
});

test('remove_place removes by label and reports unknown labels', async () => {
  const fredy = fakeFredy({ home_addresses: [{ label: 'Work', address: 'A 1', mode: 'transit' }, { label: 'Gym', kind: 'category', category: 'gym', mode: 'walk' }] });
  const missing = await tool('remove_place').run(fredy, 'bob', { label: 'Kita' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Work, Gym/);
  await tool('remove_place').run(fredy, 'bob', { label: 'gym' });
  assert.deepEqual(fredy.settings.home_addresses.map((p) => p.label), ['Work']);
});

test('update_applicant_profile merges, clears with null and rejects bad input entirely', async () => {
  const fredy = fakeFredy({ applicant_profile: { firstName: 'Jake', city: 'Dortmund', pets: 'cat' } });
  const bad = await tool('update_applicant_profile').run(fredy, 'bob', { employmentType: 'boss', adults: 1.5, shoeSize: 44 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /employmentType must be one of/);
  assert.match(bad.content[0].text, /adults must be a whole number/);
  assert.match(bad.content[0].text, /shoeSize is not a known field/);
  assert.equal(fredy.calls.length, 0, 'nothing sent to Fredy');
  await tool('update_applicant_profile').run(fredy, 'bob', { employmentType: 'permanent', pets: null, moveInDate: '2027-03-01' });
  assert.deepEqual(fredy.settings.applicant_profile, { firstName: 'Jake', city: 'Dortmund', employmentType: 'permanent', moveInDate: '2027-03-01' });
});

test('set_application_template saves per language/deal type and resets with null', async () => {
  const fredy = fakeFredy({ application_templates: { en: { rent: 'old' } } });
  await tool('set_application_template').run(fredy, 'bob', { language: 'de', dealType: 'buy', template: 'Hallo {{contact.salutation}}' });
  assert.deepEqual(fredy.settings.application_templates, { en: { rent: 'old' }, de: { buy: 'Hallo {{contact.salutation}}' } });
  await tool('set_application_template').run(fredy, 'bob', { language: 'en', dealType: 'rent', template: null });
  await tool('set_application_template').run(fredy, 'bob', { language: 'de', dealType: 'buy', template: null });
  assert.equal(fredy.settings.application_templates, null);
});
