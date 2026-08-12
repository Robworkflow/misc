// Persona backfill report.
//
// persona is a *derived* field (see personaFor() in js/merchants.js) — it is
// computed fresh every time the app categorises transactions, never written to
// storage, so there is nothing to migrate in the literal sense. What this script
// does is run the derivation across real history and report the counts, so a
// human can spot-check the totals look right without reviewing every row.
//
//   node tools/backfill-persona.mjs <history.json>
//
// history.json is an array of { date, description, amount, flow, accountName, ... }
// exported from the master workbook (same format tools/test-categorization.mjs
// and tools/reconcile.mjs consume).

import fs from 'node:fs';
import { compile, categorize, personaFor } from '../js/merchants.js';
import { ACCOUNTS, PERSONAS } from '../js/config.js';

const historyPath = process.argv[2];
if (!historyPath) {
  console.error('usage: node tools/backfill-persona.mjs <history.json>');
  process.exit(1);
}

const here = new URL('.', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(`${here}../data/seed.json`, 'utf8'));
const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));

const index = compile(seed.merchantRules);
const byName = new Map(ACCOUNTS.map((a) => [a.name, a]));
const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));

// account -> persona -> count, and account -> persona -> $ (expenses only, so
// the dollar figures are comparable to what Reports/the email will show)
const byAccount = new Map();
const personaTotals = Object.fromEntries(PERSONAS.map((p) => [p, { count: 0, amount: 0 }]));
let unresolved = 0;

for (const t of history) {
  const account = byName.get(t.accountName) || byId.get(t.accountId);
  if (!account) { unresolved += 1; continue; }

  const categorized = categorize({ ...t, accountId: account.id }, index, account);
  // No stored spend-type overrides exist outside a browser's localStorage, so
  // this report uses each transaction's resolved (un-overridden) spend type —
  // exactly what a fresh browser would show before any manual flips.
  const persona = personaFor(account, categorized.spendType);

  if (!byAccount.has(account.name)) {
    byAccount.set(account.name, Object.fromEntries(PERSONAS.map((p) => [p, { count: 0, amount: 0 }])));
  }
  const bucket = byAccount.get(account.name)[persona];
  if (!bucket) { unresolved += 1; continue; }
  bucket.count += 1;
  if (t.flow === 'Expense') bucket.amount += Math.abs(Number(t.amount) || 0);

  personaTotals[persona].count += 1;
  if (t.flow === 'Expense') personaTotals[persona].amount += Math.abs(Number(t.amount) || 0);
}

const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;

console.log(`${history.length} transactions read, ${unresolved} could not be matched to a tracked account/persona\n`);

console.log('BY ACCOUNT');
for (const account of ACCOUNTS) {
  const row = byAccount.get(account.name);
  if (!row) { console.log(`  ${account.name.padEnd(24)} (no transactions)`); continue; }
  const parts = PERSONAS
    .filter((p) => row[p].count > 0)
    .map((p) => `${p}: ${row[p].count} (${money(row[p].amount)})`);
  const note = account.personaLocked ? '  [locked]'
    : account.personaDefault === null ? '  [derived from spend type]' : '';
  console.log(`  ${account.name.padEnd(24)} ${parts.join(', ')}${note}`);
}

console.log('\nBY PERSONA (totals across all accounts)');
for (const p of PERSONAS) {
  console.log(`  ${p.padEnd(10)} ${String(personaTotals[p].count).padStart(5)} transactions   ${money(personaTotals[p].amount)} in expenses`);
}

// Sanity checks worth a human's eyes, not a pass/fail gate — this script only
// reports, per the instruction not to require row-by-row review.
console.log('\nSPOT-CHECK NOTES');
const danikoRobVisa = byAccount.get('Daniko Rob Visa');
if (danikoRobVisa) {
  console.log(`  Daniko Rob Visa split — Daniko: ${danikoRobVisa.Daniko.count}, Rob: ${danikoRobVisa.Rob.count}`
    + `${danikoRobVisa.Melanie.count ? `, Melanie: ${danikoRobVisa.Melanie.count} (unexpected — should be 0)` : ''}`);
}
const danikoMelVisa = byAccount.get('Daniko Mel Visa');
if (danikoMelVisa) {
  const leaked = PERSONAS.filter((p) => p !== 'Melanie' && danikoMelVisa[p].count > 0);
  console.log(`  Daniko Mel Visa (locked) — Melanie: ${danikoMelVisa.Melanie.count}`
    + `${leaked.length ? `, LEAKED to ${leaked.join(', ')} — lock is broken, report this` : ', nothing on any other persona (correct)'}`);
}
