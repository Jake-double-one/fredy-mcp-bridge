import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { availableLanguages, missingKeys, normalizeLanguage, translator } from '../src/i18n.js';
import { PERMISSIONS } from '../src/permissions.js';

const read = (lang) => JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), 'utf8'));
const placeholders = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

test('ships the same languages as Fredy, without Turkish', () => {
  assert.deepEqual(availableLanguages().sort(), ['de', 'en', 'es', 'fr', 'it']);
});

test('every language has every key, no extras, same placeholders as English', () => {
  const en = read('en');
  for (const lang of availableLanguages()) {
    assert.deepEqual(missingKeys(lang), [], `${lang} is missing keys`);
    const strings = read(lang);
    for (const key of Object.keys(strings)) {
      if (key === '_meta') continue;
      assert.ok(key in en, `${lang} has unknown key ${key}`);
      assert.deepEqual(placeholders(strings[key]), placeholders(en[key]), `${lang}:${key} placeholders`);
    }
  }
});

test('every permission has a label and description', () => {
  const en = read('en');
  for (const p of PERMISSIONS) {
    assert.ok(en[`perm.${p.key}.label`], p.key);
    assert.ok(en[`perm.${p.key}.desc`], p.key);
  }
});

test('language selection: Fredy profile codes, fallback English', () => {
  assert.equal(normalizeLanguage('de'), 'de');
  assert.equal(normalizeLanguage('fr-FR'), 'fr');
  assert.equal(normalizeLanguage('tr'), null);
  assert.equal(translator(null).lang, 'en');
  assert.equal(translator('tr').lang, 'en');
  assert.equal(translator('it').t('consent.connect'), 'Connetti');
});
