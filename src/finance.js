/*
 * Fredys Finanzprofil (Finanzierungsrechner) lesen und gezielt ändern.
 *
 * Fredy speichert das Profil als ein JSON-Objekt pro Benutzer und prüft beim Speichern nur, dass
 * es ein Objekt ist. Deshalb prüft die Bridge jedes Feld, bevor sie speichert – und speichert gar
 * nichts, wenn auch nur ein Feld falsch ist. Felder, die die Bridge nicht kennt (z. B. neue aus
 * einem Fredy-Update), bleiben beim Zusammenführen unangetastet erhalten.
 */

// Fredys Bundesland-Codes (lib/services/finance/constants.js).
export const BUNDESLAENDER = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];
const MAX_SCENARIOS = 6;

const money = (description) => ({ type: 'number', minimum: 0, description });
const pct = (description, maximum = 100) => ({ type: 'number', minimum: 0, maximum, description });

const personSchema = (who) => ({
  type: 'object',
  description: `${who}. Only the fields you pass are changed.`,
  properties: {
    ...(who.startsWith('Partner') ? { enabled: { type: 'boolean', description: 'Whether the partner counts towards the budget.' } } : {}),
    age: { type: 'integer', minimum: 16, maximum: 100, description: 'Current age in years (only used for the debt-free age).' },
    primaryIncome: money('Monthly NET income from the main job, EUR.'),
    secondaryIncome: money('Other regular monthly NET income a bank would count (child benefit, rent, side job), EUR.'),
  },
  additionalProperties: false,
});

export const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    personA: personSchema('The user (person A)'),
    personB: personSchema('Partner (person B) – set enabled=true to count a second income'),
    livingCosts: money('Monthly living costs EXCLUDING rent (food, insurance, car, utilities), EUR.'),
    existingDebt: money('Amount still owed on existing consumer loans, EUR.'),
    existingDebtRate: money('Monthly instalment on those existing loans, EUR.'),
    existingDebtInterest: pct('Interest rate on those existing loans, percent.', 30),
    rollFreedBudgetIntoMortgage: { type: 'boolean', description: 'Once existing loans are paid off, put that instalment into the mortgage.' },
    renting: {
      type: 'object',
      description: 'Settings for rental listings.',
      properties: { nebenkostenPct: pct('Surcharge on the cold rent that makes it warm rent, percent (Fredy default 25).', 200) },
      additionalProperties: false,
    },
    financing: {
      type: 'object',
      description: 'Settings for buying. Only the fields you pass are changed.',
      properties: {
        purchasePrice: money('Purchase price for the calculator, EUR.'),
        equity: money('Equity (Eigenkapital), EUR.'),
        bundesland: { type: 'string', enum: BUNDESLAENDER, description: 'German state; sets the default transfer tax (Grunderwerbsteuer).' },
        grunderwerbsteuerPct: {
          type: ['number', 'null'],
          minimum: 0,
          maximum: 15,
          description: 'Explicit transfer tax in percent. null = use the default of the state.',
        },
        notaryPct: pct('Notary + land registry, percent of the price (Fredy default 1.5).', 10),
        maklerPct: pct("Buyer's agent fee, percent; 0 for a private sale.", 10),
        purchasePriceThreshold: money('Listings priced below this are treated as rentals, EUR (Fredy default 30000).'),
      },
      additionalProperties: false,
    },
    scenarios: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SCENARIOS,
      description:
        'Loan scenarios. This is the COMPLETE list and replaces the stored one – resend unchanged scenarios too. ' +
        'Give either tilgung or monthlyPayment per scenario; they determine each other.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', maxLength: 40 },
          annualRate: pct('Nominal interest rate (Sollzins), percent.', 20),
          tilgung: pct('Initial repayment (anfängliche Tilgung), percent per year.', 20),
          fixedYears: { type: 'integer', minimum: 1, maximum: 40, description: 'Fixed-rate period (Zinsbindung), years.' },
          monthlyPayment: { type: ['number', 'null'], minimum: 0, description: 'Monthly instalment, EUR. Overrides tilgung when set.' },
          sondertilgungPerYear: money('Extra repayment once a year, EUR.'),
        },
        required: ['annualRate', 'fixedYears'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Prüft einen Wert gegen das (vereinfachte) Schema oben; sammelt alle Fehler. */
function check(value, schema, path, errors) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) {
    if (!types.includes('null')) errors.push(`${path} must not be null.`);
    return;
  }
  if (types.includes('object')) {
    if (!isObject(value)) return errors.push(`${path} must be an object.`);
    for (const key of Object.keys(value)) {
      if (!schema.properties[key]) errors.push(`${path}.${key} is not a known field.`);
      else check(value[key], schema.properties[key], `${path}.${key}`, errors);
    }
    for (const key of schema.required || []) if (value[key] === undefined) errors.push(`${path}.${key} is required.`);
    return;
  }
  if (types.includes('array')) {
    if (!Array.isArray(value)) return errors.push(`${path} must be a list.`);
    if (value.length < (schema.minItems ?? 0)) errors.push(`${path} needs at least ${schema.minItems} entr${schema.minItems === 1 ? 'y' : 'ies'}.`);
    if (value.length > (schema.maxItems ?? Infinity)) errors.push(`${path} allows at most ${schema.maxItems} entries.`);
    value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, errors));
    return;
  }
  if (types.includes('boolean')) {
    if (typeof value !== 'boolean') errors.push(`${path} must be true or false.`);
    return;
  }
  if (types.includes('string')) {
    if (typeof value !== 'string') return errors.push(`${path} must be a string.`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}.`);
    if (schema.maxLength && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters.`);
    return;
  }
  if (types.includes('number') || types.includes('integer')) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return errors.push(`${path} must be a number.`);
    if (types.includes('integer') && !types.includes('number') && !Number.isInteger(value)) errors.push(`${path} must be a whole number.`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}.`);
  }
}

export function validateUpdate(changes) {
  const errors = [];
  if (!isObject(changes) || Object.keys(changes).length === 0) return ['Pass at least one field to change.'];
  check(changes, UPDATE_SCHEMA, 'profile', errors);
  return errors.map((e) => e.replace(/^profile\./, ''));
}

/**
 * Führt die Änderungen in das gespeicherte Profil ein. Unbekannte gespeicherte Felder bleiben.
 * Szenarien werden komplett ersetzt (wie in Fredys Formular).
 */
export function mergeProfile(stored, changes) {
  const next = isObject(stored) ? structuredClone(stored) : {};
  for (const key of ['personA', 'personB']) {
    if (changes[key]) next[key] = { ...(isObject(next[key]) ? next[key] : {}), ...changes[key] };
  }
  if (next.personA && changes.personA) next.personA.enabled = true;
  for (const key of ['livingCosts', 'existingDebt', 'existingDebtRate', 'existingDebtInterest', 'rollFreedBudgetIntoMortgage']) {
    if (changes[key] !== undefined) next[key] = changes[key];
  }
  if (changes.renting) next.renting = { ...(isObject(next.renting) ? next.renting : {}), ...changes.renting };

  if (changes.financing || changes.scenarios) {
    const financing = isObject(next.financing) ? next.financing : {};
    const incoming = { ...(changes.financing || {}) };
    // Wie in Fredys Formular: Ein neues Bundesland setzt die Grunderwerbsteuer auf dessen Satz.
    // Statt Fredys Tabelle zu kopieren, wird eine eigene Angabe entfernt – Fredy nimmt dann den
    // Satz aus seiner eigenen, aktuellen Tabelle.
    if (incoming.bundesland !== undefined && incoming.grunderwerbsteuerPct === undefined) {
      incoming.grunderwerbsteuerPct = null;
    }
    for (const [key, value] of Object.entries(incoming)) {
      if (value === null && key === 'grunderwerbsteuerPct') delete financing[key];
      else financing[key] = value;
    }
    if (changes.scenarios) {
      financing.scenarios = changes.scenarios.map((s, i) => ({
        id: `s${i + 1}`,
        label: s.label || `${s.annualRate} %`,
        annualRate: s.annualRate,
        tilgung: s.tilgung ?? 2,
        fixedYears: s.fixedYears,
        // Nur eine von beiden Angaben gilt; ohne explizite Rate rechnet Fredy aus der Tilgung.
        monthlyPayment: s.monthlyPayment ?? null,
        sondertilgungPerYear: s.sondertilgungPerYear ?? 0,
      }));
    }
    next.financing = financing;
  }
  return next;
}
