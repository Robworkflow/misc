// Update package generation.
//
// The master workbook in Drive is the system of record and this app never writes
// to it. Each cycle produces a *new* .xlsx for the user to review and re-upload
// manually, plus a plain-text changelog and an email draft for Melanie.

import { ACCOUNTS, THRESHOLDS } from './config.js';
import { monthOf, addMonths } from './guardrails.js';

const money = (n) => `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${Math.round(Math.abs(n)).toLocaleString('en-CA')}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Build the updated workbook: full transaction register, the merchant lookup
 * table as it now stands, this cycle's flags, and the subscription view.
 */
export function buildUpdatePackage({ transactions, flags, subscriptions, bills, coverage, cycle, merchantRules, newTransactions, reviewed = new Set(), suggestions = new Map() }, XLSX) {
  const wb = XLSX.utils.book_new();

  const txnRows = transactions
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => ({
      Date: t.date,
      Description: t.description,
      Merchant: t.merchant || '',
      Amount: Number(t.amount.toFixed(2)),
      'Flow Type': t.flow,
      Category: t.category,
      'Recurring Type': t.recurringType || '',
      Account: t.accountName,
      'Account Type': t.accountType || '',
      'Card Holder': t.cardHolder || '',
      Person: t.person || '',
      'Spend Type': t.spendType || '',
      // Where Business/Personal came from, so a card-wide default is never
      // mistaken for a per-charge decision.
      'Spend Type Source': t.spendTypeSource || '',
      // A suggestion is not a category. It is recorded here as a pending
      // proposal so the workbook shows what is still awaiting a human.
      'Suggested Category': t.unmapped ? (suggestions.get(t.fingerprint)?.category || '') : '',
      'Suggestion Evidence': t.unmapped ? (suggestions.get(t.fingerprint)?.evidence || '') : '',
      Month: monthOf(t.date),
      Year: Number(String(t.date).slice(0, 4)),
      Source: t.source,
      // Reviewed one-offs stay in the register in full; the column records that
      // they are held out of baseline and month-over-month comparisons.
      Reviewed: reviewed.has(t.fingerprint) ? 'One-time (excluded from comparisons)' : '',
    }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(txnRows), 'Transactions');

  if (newTransactions?.length) {
    const newRows = newTransactions
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((t) => ({
        Date: t.date,
        Description: t.description,
        Merchant: t.merchant || '',
        Amount: Number(t.amount.toFixed(2)),
        'Flow Type': t.flow,
        Category: t.category,
        Account: t.accountName,
        'Spend Type': t.spendType || '',
        Unmapped: t.unmapped ? 'YES' : '',
      }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(newRows), `New ${cycle}`);
  }

  const flagRows = flags.map((f) => ({
    Severity: f.severity,
    Type: f.type,
    Subject: f.subject,
    Flag: f.title,
    Detail: f.detail,
    Previous: f.numbers?.previous != null ? Number(f.numbers.previous.toFixed(2)) : '',
    Current: f.numbers?.current != null ? Number(f.numbers.current.toFixed(2)) : '',
    Baseline: f.numbers?.baseline != null ? Number(f.numbers.baseline.toFixed(2)) : '',
    'Change %': f.numbers?.delta != null ? Number((f.numbers.delta * 100).toFixed(1)) : '',
    Caveat: f.caveat || '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flagRows.length ? flagRows : [{ Flag: 'No flags this cycle' }]), `Flags ${cycle}`);

  const subRows = [
    ...subscriptions.subscriptions.map((s) => ({ Kind: 'Subscription', ...subRow(s) })),
    ...(bills?.subscriptions || []).map((s) => ({ Kind: 'Recurring bill', ...subRow(s) })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(subRows.length ? subRows : [{ Kind: 'none' }]), 'Subscriptions');

  const coverageRows = coverage.map((a) => ({
    Account: a.name,
    Type: a.type,
    Person: a.person,
    'Statement ingested': a.hasStatement ? 'Yes' : 'No',
    'Transactions this cycle': a.txnCount,
    Spend: Number(a.spend.toFixed(2)),
    Income: Number(a.income.toFixed(2)),
    Status: a.txnCount === 0 ? 'MISSING — flagged' : 'Reported',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(coverageRows), 'Account Coverage');

  const ruleRows = merchantRules.map((r) => ({
    Pattern: r.pattern,
    'Display Name': r.display,
    Category: r.category,
    'Recurring Type': r.recurringType || '',
    Cadence: r.cadence || '',
    'Spend Type': r.spendType || '',
    Person: r.person || '',
    Source: r.source || '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ruleRows), 'Merchant Lookup');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `Personal CFO update package ${cycle}.xlsx`);
}

function subRow(s) {
  const delta = s.previous > 0 ? (s.current - s.previous) / s.previous : null;
  return {
    Item: s.merchant,
    Cadence: s.cadence || '',
    'Previous month': Number(s.previous.toFixed(2)),
    'This month': Number(s.current.toFixed(2)),
    'Change %': delta == null ? '' : Number((delta * 100).toFixed(1)),
    'Months active': s.monthsActive,
    'Window total': Number(s.total.toFixed(2)),
  };
}

/** Human-readable changelog describing exactly what this cycle changed. */
export function buildChangelog({ cycle, flags, newTransactions, ingested, coverage, corrections, heldOut, pendingSuggestions = 0 }) {
  const lines = [];
  const rule = '='.repeat(64);
  lines.push(rule, `PERSONAL CFO — CYCLE ${cycle}`, `Generated ${new Date().toLocaleString('en-CA')}`, rule, '');

  lines.push('STATEMENTS INGESTED');
  if (!ingested?.length) {
    lines.push('  (none this run)');
  } else {
    ingested.forEach((s) => lines.push(`  ${s.accountName.padEnd(24)} ${s.fileName}  →  ${s.txnCount} transactions`));
  }
  lines.push('');

  lines.push('ACCOUNT COVERAGE (all 7 accounts are checked every cycle)');
  coverage.forEach((a) => {
    const status = a.txnCount === 0 ? 'MISSING — FLAGGED' : `${a.txnCount} txns, ${money0(a.spend)} spend`;
    lines.push(`  ${a.name.padEnd(24)} ${status}`);
  });
  lines.push('');

  lines.push(`NEW TRANSACTIONS: ${newTransactions?.length || 0}`);
  lines.push('');

  if (pendingSuggestions) {
    lines.push(`SUGGESTIONS AWAITING A HUMAN: ${pendingSuggestions}`);
    lines.push('  Proposed categories, shown with their evidence in the app. None of them');
    lines.push('  have been applied — a suggestion only becomes a category when accepted.');
    lines.push('');
  }

  if (heldOut?.length) {
    lines.push('REVIEWED ONE-TIME ITEMS (in the totals, held out of comparisons)');
    heldOut.forEach((t) => lines.push(`  ${t.date}  ${money(t.amount).padStart(14)}  ${t.accountName} — ${t.description.slice(0, 50)}`));
    lines.push('');
  }

  if (corrections?.length) {
    lines.push('CATEGORY CORRECTIONS MADE THIS SESSION');
    corrections.forEach((c) => lines.push(`  ${c.display} (${c.pattern}) → ${c.category}`));
    lines.push('');
  }

  lines.push(`FLAGS: ${flags.length}`);
  const groups = {};
  flags.forEach((f) => { (groups[f.type] ||= []).push(f); });
  for (const [type, items] of Object.entries(groups)) {
    lines.push('', `  ${type.replace(/-/g, ' ').toUpperCase()} (${items.length})`);
    items.forEach((f) => {
      lines.push(`    [${f.severity}] ${f.title}`);
      lines.push(`        ${f.detail}`);
      if (f.caveat) lines.push(`        NOTE: ${f.caveat}`);
    });
  }
  lines.push('', rule);
  lines.push('This tool flags only. It applies no budget, limit, or block to any spending.');
  lines.push('The master workbook in Drive was not modified — re-upload the update package manually.');
  lines.push(rule);

  return lines.join('\n');
}

export function downloadChangelog(text, cycle) {
  download(new Blob([text], { type: 'text/plain' }), `Personal CFO changelog ${cycle}.txt`);
}

/**
 * Plain-language monthly summary for Melanie. Written to be sent as-is, with no
 * spreadsheet jargon and no instruction to change any spending.
 */
export function buildEmailDraft({ cycle, flags, subscriptions, coverage, transactions }) {
  const monthName = new Date(`${cycle}-01T12:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const cycleTxns = transactions.filter((t) => monthOf(t.date) === cycle);
  const spend = cycleTxns.filter((t) => t.flow === 'Expense' && !['Transfers', 'Income'].includes(t.category))
    .reduce((s, t) => s + t.amount, 0);

  const subNow = subscriptions.series.at(-1)?.value || 0;
  const subPrev = subscriptions.series.at(-2)?.value || 0;
  const subDelta = subPrev > 0 ? (subNow - subPrev) / subPrev : null;

  const missing = coverage.filter((a) => a.txnCount === 0);
  const unmapped = flags.filter((f) => f.type === 'unmapped-merchant');
  const overspend = flags.filter((f) => f.type === 'category-overspend');
  const subChanges = flags.filter((f) => f.type.startsWith('subscription'));

  const lines = [];
  lines.push(`Subject: Money check-in — ${monthName}`, '');
  lines.push('Hi Mel,', '');
  lines.push(`Here's the ${monthName} run-through of our accounts. Nothing here needs action unless something looks off to you — it's just so we both know what happened.`, '');

  lines.push(`We spent ${money0(spend)} across everything last month.`);
  if (subDelta !== null && Math.abs(subDelta) >= THRESHOLDS.subscriptionMoMPct) {
    lines.push(`Our subscriptions came to ${money0(subNow)}, which is ${subDelta > 0 ? 'up' : 'down'} ${pct(Math.abs(subDelta))} from ${money0(subPrev)} the month before.`);
  } else {
    lines.push(`Our subscriptions came to ${money0(subNow)}, which is about the same as last month.`);
  }
  lines.push('');

  if (subChanges.length) {
    lines.push('Subscription changes:');
    subChanges.slice(0, 8).forEach((f) => lines.push(`  • ${f.title}`));
    lines.push('');
  }

  if (overspend.length) {
    lines.push('Spending that ran higher than our usual pattern:');
    overspend.slice(0, 6).forEach((f) => {
      lines.push(`  • ${f.subject}: ${money0(f.numbers.current)} this month vs ${money0(f.numbers.baseline)} on average.`);
    });
    lines.push('');
  }

  if (unmapped.length) {
    const total = unmapped.reduce((s, f) => s + (f.numbers?.current || 0), 0);
    lines.push(`There ${unmapped.length === 1 ? 'is' : 'are'} ${unmapped.length} ${unmapped.length === 1 ? 'purchase' : 'purchases'} totalling ${money0(total)} from ${unmapped.length === 1 ? 'a place' : 'places'} we haven't categorised before. I'll sort those into the right buckets:`);
    unmapped.slice(0, 6).forEach((f) => lines.push(`  • ${f.subject} — ${money0(f.numbers.current)}`));
    if (unmapped.length > 6) lines.push(`  • …and ${unmapped.length - 6} more`);
    lines.push('');
  }

  if (missing.length) {
    lines.push(`One thing to note: I don't have ${missing.length === 1 ? 'a statement' : 'statements'} yet for ${missing.map((a) => a.name).join(', ')}, so ${missing.length === 1 ? "that account isn't" : "those accounts aren't"} included in the numbers above.`, '');
  }

  if (!subChanges.length && !overspend.length && !unmapped.length && !missing.length) {
    lines.push('Nothing unusual turned up this month — everything came in line with our normal pattern.', '');
  }

  lines.push('Shout if anything looks wrong and I\'ll dig into it.', '', 'Rob');
  return lines.join('\n');
}

export function downloadEmail(text, cycle) {
  download(new Blob([text], { type: 'text/plain' }), `Melanie summary ${cycle}.txt`);
}

/**
 * Export merchant overrides — the category assignments made in-app — as a
 * portable JSON file. This is the durability story: `localStorage` is tied to
 * one browser on one machine, so a manual categorisation pass is one cleared
 * cache away from gone unless it is exported somewhere durable.
 */
export function buildMerchantOverridesExport(overrides) {
  return {
    app: 'personal-cfo',
    kind: 'merchant-overrides',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: Object.keys(overrides).length,
    overrides,
  };
}

export function downloadMerchantOverrides(overrides) {
  const payload = buildMerchantOverridesExport(overrides);
  const stamp = new Date().toISOString().slice(0, 10);
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `Personal CFO merchant overrides ${stamp}.json`);
}

/**
 * Parse and sanity-check an imported overrides file. Throws with a message fit
 * to show the user directly rather than a stack trace — this file may have come
 * from a different machine, a different session, or been hand-edited.
 */
export function parseMerchantOverridesFile(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!payload || typeof payload !== 'object' || payload.kind !== 'merchant-overrides') {
    throw new Error('That file does not look like a Personal CFO merchant overrides export (missing or wrong "kind").');
  }
  if (!payload.overrides || typeof payload.overrides !== 'object') {
    throw new Error('That file has no "overrides" data to import.');
  }
  return payload;
}

/** Export the merchant lookup table on its own, for editing outside the app. */
export function exportLookupTable(rules) {
  const header = 'Pattern,Display Name,Category,Recurring Type,Cadence,Spend Type,Person,Source';
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = rules.map((r) => [r.pattern, r.display, r.category, r.recurringType || '', r.cadence || '', r.spendType || '', r.person || '', r.source || ''].map(esc).join(','));
  download(new Blob([[header, ...rows].join('\n')], { type: 'text/csv' }), 'merchant-lookup-table.csv');
}

/** Sketch of the automation seam, for the parked n8n work. Not wired up. */
export const WEBHOOK_SKETCH = {
  note: 'v1 runs standalone. If this is ever automated, these are the two natural seams.',
  onNewStatement: {
    trigger: 'Google Drive: new file in a year subfolder',
    payload: { fileId: 'string', fileName: 'string', accountId: 'string', statementDate: 'YYYY-MM-DD' },
  },
  onCycleComplete: {
    trigger: 'App: user clicks "Generate update package"',
    payload: { cycle: 'YYYY-MM', flagCount: 'number', emailDraft: 'string', missingAccounts: 'string[]' },
  },
};
