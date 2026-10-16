import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfile, validateUpdate } from '../src/finance.js';

const stored = {
  personA: { label: 'A', enabled: true, age: 40, primaryIncome: 3000, secondaryIncome: 0 },
  livingCosts: 1200,
  futureFredyField: { keep: true },
  renting: { nebenkostenPct: 25 },
  financing: {
    purchasePrice: 400000,
    equity: 80000,
    bundesland: 'NW',
    grunderwerbsteuerPct: 6.5,
    scenarios: [{ id: 'low', label: '3.0 %', annualRate: 3, tilgung: 2, fixedYears: 10 }],
  },
};

test('only the given fields change, unknown stored fields survive', () => {
  const next = mergeProfile(stored, { personA: { primaryIncome: 3500 }, financing: { equity: 100000 } });
  assert.equal(next.personA.primaryIncome, 3500);
  assert.equal(next.personA.age, 40);
  assert.equal(next.financing.equity, 100000);
  assert.equal(next.financing.purchasePrice, 400000);
  assert.deepEqual(next.futureFredyField, { keep: true });
  assert.equal(next.livingCosts, 1200);
  assert.equal(stored.personA.primaryIncome, 3000, 'input is not mutated');
});

test('a new state drops the explicit transfer tax so Fredy uses its own table', () => {
  const next = mergeProfile(stored, { financing: { bundesland: 'BY' } });
  assert.equal(next.financing.bundesland, 'BY');
  assert.ok(!('grunderwerbsteuerPct' in next.financing));
  const explicit = mergeProfile(stored, { financing: { bundesland: 'BY', grunderwerbsteuerPct: 3.5 } });
  assert.equal(explicit.financing.grunderwerbsteuerPct, 3.5);
});

test('scenarios are replaced as a whole', () => {
  const next = mergeProfile(stored, {
    scenarios: [
      { annualRate: 3.4, tilgung: 3, fixedYears: 15 },
      { annualRate: 3.9, fixedYears: 10, monthlyPayment: 1800 },
    ],
  });
  assert.equal(next.financing.scenarios.length, 2);
  assert.equal(next.financing.scenarios[0].label, '3.4 %');
  assert.equal(next.financing.scenarios[1].monthlyPayment, 1800);
  assert.equal(next.financing.equity, 80000);
});

test('works without a stored profile', () => {
  const next = mergeProfile(null, { personA: { primaryIncome: 2500 }, livingCosts: 900 });
  assert.deepEqual(next, { personA: { primaryIncome: 2500, enabled: true }, livingCosts: 900 });
});

test('validation reports every problem and accepts good input', () => {
  assert.deepEqual(validateUpdate({ livingCosts: 1000, personB: { enabled: true, primaryIncome: 2000 } }), []);
  assert.deepEqual(validateUpdate({}), ['Pass at least one field to change.']);
  const errors = validateUpdate({
    livingCosts: -5,
    financing: { bundesland: 'XX', equity: 'viel' },
    scenarios: [{ annualRate: 3 }],
    hobby: 'x',
  });
  assert.ok(errors.includes('livingCosts must be at least 0.'), errors.join('|'));
  assert.ok(errors.some((e) => e.startsWith('financing.bundesland must be one of')));
  assert.ok(errors.includes('financing.equity must be a number.'));
  assert.ok(errors.includes('scenarios[0].fixedYears is required.'));
  assert.ok(errors.includes('hobby is not a known field.'));
  assert.deepEqual(validateUpdate({ financing: { grunderwerbsteuerPct: null } }), []);
  assert.ok(validateUpdate({ personA: { age: 30.5 } }).includes('personA.age must be a whole number.'));
});
