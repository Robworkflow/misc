// Reconcile a parsed statement against the control totals the statement itself
// prints. This is the only check that actually proves a parser is right: a
// statement that balances to its own summary line has been read correctly.
//
//   npm i pdfjs-dist@4.6.82
//   node tools/reconcile.mjs <rbc-visa|rbc-bank> file.pdf [more.pdf ...]
//
// Exits non-zero if any statement fails to reconcile.

import fs from 'node:fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseStatement } from '../js/parse.js';
import { ACCOUNTS } from '../js/config.js';

const args = process.argv.slice(2);
const format = args.shift();
if (!format || !args.length) {
  console.error('usage: node tools/reconcile.mjs <rbc-visa|rbc-bank> file.pdf [...]');
  process.exit(1);
}

const account = ACCOUNTS.find((a) => a.statementFormat === format)
  || { id: 'test', name: 'Test', type: 'Test', holder: '', person: '', defaultSpendType: null, statementFormat: format };

const num = (s) => Number(String(s).replace(/[$,\s]/g, ''));

/** Pull the printed control totals out of the raw page text. */
function printedTotals(text) {
  const out = {};
  // Business bank: "Total cheques & debits (18) - 18,845.07"
  let m = text.match(/Total cheques?\s*&\s*debits?\s*\((\d+)\)\s*-?\s*([\d,]+\.\d{2})/i);
  if (m) { out.debitCount = Number(m[1]); out.debits = num(m[2]); }
  m = text.match(/Total deposits?\s*&\s*credits?\s*\((\d+)\)\s*\+?\s*([\d,]+\.\d{2})/i);
  if (m) { out.creditCount = Number(m[1]); out.credits = num(m[2]); }
  // Personal bank: "Total withdrawals from your account - 22,707.17"
  m = text.match(/Total withdrawals? from your account\s*-?\s*([\d,]+\.\d{2})/i);
  if (m) out.debits = num(m[1]);
  m = text.match(/Total deposits? into your account\s*\+?\s*([\d,]+\.\d{2})/i);
  if (m) out.credits = num(m[1]);
  // Visa "CALCULATING YOUR BALANCE" block. Charges are split across four lines
  // and the parser picks up all of them, so the control total is their sum —
  // interest and fees are real charges on the card, they are simply not counted
  // under "Purchases & debits".
  const line = (re) => {
    const hit = text.match(re);
    return hit ? num(hit[1]) : null;
  };
  // The '$' is required: the sidebar prints annual interest *rates* using the
  // same words ("Cash advances 22.99%"), and matching those inflates the total.
  const purchases = line(/Purchases?\s*&\s*debits?\s*\$([\d,]+\.\d{2})/i);
  if (purchases !== null) {
    const cash = line(/Cash advances\s*\$([\d,]+\.\d{2})/i) ?? 0;
    const interest = line(/\bInterest\s*\$([\d,]+\.\d{2})/i) ?? 0;
    const fees = line(/\bFees\s*\$([\d,]+\.\d{2})/i) ?? 0;
    out.debits = Number((purchases + cash + interest + fees).toFixed(2));
    out.debitParts = { purchases, cash, interest, fees };
  }
  m = text.match(/Payments?\s*&\s*credits?\s*-?\$?([\d,]+\.\d{2})/i);
  if (m) out.credits = num(m[1]);
  return out;
}

async function rawText(buffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  let all = '';
  for (let p = 1; p <= doc.numPages; p += 1) {
    const tc = await (await doc.getPage(p)).getTextContent();
    all += `${tc.items.map((i) => i.str).join(' ')}\n`;
  }
  return all.replace(/\s+/g, ' ');
}

const money = (n) => `$${n.toFixed(2)}`;
let failures = 0;

for (const file of args) {
  const bytes = fs.readFileSync(file);
  // pdf.js transfers (and thus detaches) the buffer it is handed, so each read
  // needs its own copy.
  const copy = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const result = await parseStatement(copy(), account, pdfjsLib);
  const printed = printedTotals(await rawText(copy()));

  const debits = result.transactions.filter((t) => t.flow === 'Expense');
  const credits = result.transactions.filter((t) => t.flow === 'Income');
  const sum = (rows) => Number(rows.reduce((s, t) => s + t.amount, 0).toFixed(2));

  const checks = [];
  const check = (label, got, want) => {
    if (want === undefined) return;
    const ok = Math.abs(got - want) < 0.005;
    checks.push({ label, got, want, ok });
    if (!ok) failures += 1;
  };
  check('debit total', sum(debits), printed.debits);
  check('credit total', sum(credits), printed.credits);
  check('debit count', debits.length, printed.debitCount);
  check('credit count', credits.length, printed.creditCount);

  const verdict = checks.length === 0 ? 'NO CONTROL TOTALS FOUND'
    : checks.every((c) => c.ok) ? 'RECONCILED' : 'MISMATCH';
  if (!checks.length) failures += 1;

  console.log(`\n${file.split('/').pop()}  [${result.cycle}]  ${result.transactions.length} txns  → ${verdict}`);
  for (const c of checks) {
    const fmt = c.label.includes('count') ? String : money;
    console.log(`   ${c.ok ? 'ok  ' : 'FAIL'}  ${c.label.padEnd(13)} parsed ${fmt(c.got).padStart(12)}   printed ${fmt(c.want).padStart(12)}`);
  }
  if (!result.transactions.length) console.log('   (no transactions parsed at all)');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll statements reconciled exactly.');
process.exit(failures ? 1 : 0);
