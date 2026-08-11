// Parser check against real statement PDFs.
//
// The useful property of a bank statement is that it carries its own control
// totals, so a parser can be checked rather than eyeballed: RBC Visa prints
// "Purchases & debits" and bank statements print "Total withdrawals/deposits".
// Point this at a downloaded statement and compare.
//
//   npm i pdfjs-dist@4.6.82
//   node tools/test-parsers.mjs rbc-visa ./visa.pdf
//   node tools/test-parsers.mjs rbc-bank ./bank.pdf

import fs from 'node:fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseStatement } from '../js/parse.js';
import { ACCOUNTS } from '../js/config.js';

const [format, file] = process.argv.slice(2);
if (!format || !file) {
  console.error('usage: node tools/test-parsers.mjs <rbc-visa|rbc-bank> <file.pdf>');
  process.exit(1);
}

const account = ACCOUNTS.find((a) => a.statementFormat === format)
  || { id: 'test', name: 'Test', type: 'Test', holder: '', person: '', defaultSpendType: null, statementFormat: format };

const bytes = fs.readFileSync(file);
const result = await parseStatement(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  account,
  pdfjsLib,
);

const expenses = result.transactions.filter((t) => t.flow === 'Expense');
const income = result.transactions.filter((t) => t.flow === 'Income');
const sum = (rows) => rows.reduce((s, t) => s + t.amount, 0);

console.log(`file        ${file}`);
console.log(`format      ${format}`);
console.log(`cycle       ${result.cycle}   (${result.pageCount} pages)`);
console.log(`parsed      ${result.transactions.length} transactions`);
console.log(`expenses    ${expenses.length}  =  $${sum(expenses).toFixed(2)}`);
console.log(`income      ${income.length}  =  $${sum(income).toFixed(2)}`);
console.log('');
console.log('Compare those totals with the statement itself:');
console.log('  Visa  ->  "Purchases & debits" and "Payments & credits"');
console.log('  Bank  ->  "Total withdrawals" and "Total deposits"');
console.log('');
console.log('First 10 rows:');
for (const t of result.transactions.slice(0, 10)) {
  console.log(`  ${t.date}  ${t.flow === 'Income' ? '+' : '-'}${String(t.amount.toFixed(2)).padStart(10)}  ${t.description.slice(0, 54)}`);
}

const undated = result.transactions.filter((t) => !t.date).length;
if (undated) console.log(`\nWARNING: ${undated} rows had no resolvable date.`);
if (!result.transactions.length) {
  console.log('\nWARNING: nothing parsed — the statement layout may differ from the two supported formats.');
  process.exitCode = 1;
}
