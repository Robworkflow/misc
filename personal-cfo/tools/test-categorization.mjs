// Regression gate for the categorization engine.
//
// The contract: changing normalization, the lookup table or the suggestion
// engine must never change a category that is already assigned. Suggestions are
// allowed to appear, because a suggestion is not a category — it is a proposal
// shown to a human. An assigned category changing under someone's feet is not
// allowed, and neither is one silently disappearing.
//
//   node tools/test-categorization.mjs <history.json>
//
// history.json is an array of { date, description, amount, flow, accountName, ... }
// exported from the master workbook. The baseline it checks against is
// tools/categorization-baseline.json, which stores sha1(date|cents|flow|description|
// account) -> "category|spendType|recurringType" so the repo never carries the
// raw ledger. Regenerate it deliberately, never to make a failing test pass.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { compile, categorize, txnFingerprint } from '../js/merchants.js';
import { suggestCategory } from '../js/suggest.js';
import { ACCOUNTS } from '../js/config.js';

const historyPath = process.argv[2];
if (!historyPath) {
  console.error('usage: node tools/test-categorization.mjs <history.json>');
  process.exit(1);
}

const here = new URL('.', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(`${here}../data/seed.json`, 'utf8'));
const baseline = JSON.parse(fs.readFileSync(`${here}categorization-baseline.json`, 'utf8'));
const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));

const index = compile(seed.merchantRules);
const byName = new Map(ACCOUNTS.map((a) => [a.name, a]));
const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const changed = [];
const lost = [];
const newlyMapped = [];
let checked = 0;
let suggested = 0;
let stillUnmapped = 0;

for (const t of history) {
  const account = byName.get(t.accountName);
  const c = categorize({ ...t, accountId: account?.id }, index, account);
  // flow is part of the key: the ledger contains charges and their exact
  // reversals, identical in every other field.
  const key = h(`${t.date}|${Math.round(t.amount * 100)}|${t.flow}|${t.description}|${t.accountName}`);
  const want = baseline.rows[key];
  if (want === undefined) continue;
  checked += 1;

  const [wantCategory, wantSpend, wantRecurring] = want.split('|');
  const gotCategory = c.unmapped ? '' : c.category;

  if (wantCategory && !gotCategory) {
    // A category that used to exist has vanished.
    lost.push({ desc: t.description, was: wantCategory });
  } else if (wantCategory && gotCategory !== wantCategory) {
    // A category moved under someone's feet.
    changed.push({ desc: t.description, was: wantCategory, now: gotCategory });
  } else if (wantCategory && (
    (c.spendType || '') !== wantSpend || (c.recurringType || '') !== wantRecurring)) {
    changed.push({
      desc: t.description,
      was: `${wantSpend}/${wantRecurring || '-'}`,
      now: `${c.spendType || ''}/${c.recurringType || '-'}`,
    });
  } else if (!wantCategory && gotCategory) {
    // Previously unmapped, now resolved by a rule. This is the improvement the
    // work is for, not a regression — reported, never failed.
    newlyMapped.push({ desc: t.description, now: gotCategory });
  }

  if (c.unmapped) {
    stillUnmapped += 1;
    if (suggestCategory({ ...c, fingerprint: txnFingerprint(c) })) suggested += 1;
  }
}

console.log(`checked            ${checked} transactions against the baseline`);
console.log(`categories changed ${changed.length}`);
console.log(`categories lost    ${lost.length}`);
console.log(`newly resolved     ${newlyMapped.length}  (previously unmapped — an improvement, not a failure)`);
console.log('');
console.log(`still unmapped     ${stillUnmapped}`);
console.log(`  of which have a suggestion for a human to accept: ${suggested} (${(suggested / stillUnmapped * 100).toFixed(1)}%)`);

if (newlyMapped.length) {
  const byCat = {};
  newlyMapped.forEach((n) => { byCat[n.now] = (byCat[n.now] || 0) + 1; });
  console.log('\nNEWLY RESOLVED by category:');
  Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .forEach(([cat, n]) => console.log(`  ${String(n).padStart(4)}  ${cat}`));
}

if (changed.length) {
  console.log('\nCHANGED (a category moved — this must not happen):');
  changed.slice(0, 20).forEach((c) => console.log(`  "${c.desc.slice(0, 46)}"  ${c.was} -> ${c.now}`));
}
if (lost.length) {
  console.log('\nLOST (a category disappeared — this must not happen):');
  lost.slice(0, 20).forEach((c) => console.log(`  "${c.desc.slice(0, 46)}"  was ${c.was}`));
}

const failed = changed.length + lost.length;
console.log(failed ? `\nFAIL — ${failed} transaction(s) changed category.` : '\nPASS — no assigned category changed.');
process.exit(failed ? 1 : 0);
