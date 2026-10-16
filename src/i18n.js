/*
 * Übersetzungen. Dieselben Sprachen wie Fredys Oberfläche; Englisch ist Standard und Rückfall.
 * Die Sprache eines angemeldeten Benutzers kommt aus seinem Fredy-Profil.
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'locales');

export const LANGUAGES = {};
const resources = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const code = file.replace(/\.json$/, '');
  const { _meta, ...strings } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  resources[code] = strings;
  LANGUAGES[code] = { code, name: _meta?.name || code, locale: _meta?.locale || code };
}
if (!resources.en) throw new Error('i18n: locales/en.json is required');

export const DEFAULT_LANGUAGE = 'en';

/** „de“, „de-DE“, „DE“ → „de“; Unbekanntes → null. */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return resources[code] ? code : null;
}

function interpolate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : match));
}

/** Übersetzer für eine Sprache: t(key, vars) liefert reinen Text. */
export function translator(language) {
  const lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const t = (key, vars = {}) => interpolate(resources[lang][key] ?? resources.en[key] ?? key, vars);
  return { lang, locale: LANGUAGES[lang].locale, t };
}

export function availableLanguages() {
  return Object.keys(resources);
}

export function missingKeys(language) {
  return Object.keys(resources.en).filter((key) => !(key in resources[language]));
}
