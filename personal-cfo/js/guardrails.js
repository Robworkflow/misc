// The guardrail rules engine.
//
// This module only ever *describes* what changed. It has no notion of a budget,
// a limit, or an allowance, and nothing here can block or reject a transaction —
// every rule produces a flag for a human to read and decide on.
//
// Rules, per the PRD:
//   1. subscription total moves >= 10% month over month
//   2. a category exceeds its trailing-12-month baseline
//   3. a charge comes from a merchant with no entry in the lookup table
//   4. one of the 7 accounts has no statement for the cycle

import { ACCOUNTS, THRESHOLDS, NON_SPEND_CATEGORIES, UNMAPPED } from './config.js';
import { groupUnmapped, txnFingerprint } from './merchants.js';

export const monthOf = (date) => String(date || '').slice(0, 7);

export function addMonths(cycle, delta) {
  const [y, m] = cycle.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(endCycle, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(addMonths(endCycle, -i));
  return out;
}

const isSpend = (t) => t.flow === 'Expense' && !NON_SPEND_CATEGORIES.includes(t.category);

/** Total spend per month for a filtered set of transactions. */
function monthlyTotals(transactions, predicate) {
  const totals = new Map();
  for (const t of transactions) {
    if (!predicate(t)) continue;
    const m = monthOf(t.date);
    totals.set(m, (totals.get(m) || 0) + t.amount);
  }
  return totals;
}

/**
 * Trailing-N-month baseline for each category, measured over the N months
 * *before* the cycle under review so the current month is compared against
 * history rather than against itself.
 */
export function categoryBaselines(transactions, cycle, months = THRESHOLDS.baselineMonths) {
  const window = monthRange(addMonths(cycle, -1), months);
  const inWindow = new Set(window);
  const byCategory = new Map();

  for (const t of transactions) {
    if (!isSpend(t)) continue;
    const m = monthOf(t.date);
    if (!inWindow.has(m)) continue;
    if (!byCategory.has(t.category)) byCategory.set(t.category, new Map());
    const months_ = byCategory.get(t.category);
    months_.set(m, (months_.get(m) || 0) + t.amount);
  }

  const out = new Map();
  for (const [category, monthMap] of byCategory) {
    const values = window.map((m) => monthMap.get(m) || 0);
    // Average only over months that actually have data, so a category that
    // started mid-window isn't diluted toward zero.
    const active = values.filter((v) => v > 0);
    const mean = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
    out.set(category, {
      category,
      baseline: mean,
      monthsActive: active.length,
      windowTotal: values.reduce((a, b) => a + b, 0),
      series: window.map((m, i) => ({ month: m, value: values[i] })),
    });
  }
  return { baselines: out, window };
}

/**
 * Monthly recurring spend and the per-item detail behind it.
 * `kind` is 'subscription' (services) or 'bill' (loans, utilities, insurance,
 * taxes). They are reported separately: a $2,900/mo car loan inside the
 * subscription number would hide every change the 10% rule exists to catch.
 */
export function subscriptionSeries(transactions, cycle, months = THRESHOLDS.baselineMonths + 1, kind = 'subscription') {
  const window = monthRange(cycle, months);
  const inWindow = new Set(window);
  const matches = (t) => (t.recurringType || (t.isSubscription ? 'subscription' : null)) === kind;
  const totals = monthlyTotals(transactions, (t) => matches(t) && t.flow === 'Expense' && inWindow.has(monthOf(t.date)));

  const perSub = new Map();
  for (const t of transactions) {
    if (!matches(t) || t.flow !== 'Expense') continue;
    const m = monthOf(t.date);
    if (!inWindow.has(m)) continue;
    if (!perSub.has(t.merchant)) perSub.set(t.merchant, { merchant: t.merchant, cadence: t.cadence, months: new Map() });
    const rec = perSub.get(t.merchant);
    rec.months.set(m, (rec.months.get(m) || 0) + t.amount);
  }

  return {
    window,
    series: window.map((m) => ({ month: m, value: totals.get(m) || 0 })),
    subscriptions: [...perSub.values()].map((s) => ({
      merchant: s.merchant,
      cadence: s.cadence,
      series: window.map((m) => ({ month: m, value: s.months.get(m) || 0 })),
      current: s.months.get(cycle) || 0,
      previous: s.months.get(addMonths(cycle, -1)) || 0,
      total: [...s.months.values()].reduce((a, b) => a + b, 0),
      monthsActive: [...s.months.values()].filter((v) => v > 0).length,
    })).sort((a, b) => b.current - a.current || b.total - a.total),
  };
}

/**
 * Which accounts reported a statement for the cycle.
 * A missing account is always flagged — never assumed to have had no activity.
 */
export function accountCoverage(transactions, statements, cycle) {
  const withTxns = new Set(transactions.filter((t) => monthOf(t.date) === cycle).map((t) => t.accountId));
  const withStatements = new Set(
    (statements || [])
      .filter((s) => s.statementDate && monthOf(s.statementDate) === cycle)
      .map((s) => s.accountId),
  );

  return ACCOUNTS.map((account) => {
    const cycleTxns = transactions.filter((t) => t.accountId === account.id && monthOf(t.date) === cycle);
    return {
      accountId: account.id,
      name: account.name,
      type: account.type,
      person: account.person,
      hasStatement: withStatements.has(account.id),
      hasTransactions: withTxns.has(account.id),
      txnCount: cycleTxns.length,
      // `spend` excludes transfers and card payments so it matches the headline
      // spend figure; `outflow` is every debit including money moved between
      // the household's own accounts.
      spend: cycleTxns.filter(isSpend).reduce((s, t) => s + t.amount, 0),
      outflow: cycleTxns.filter((t) => t.flow === 'Expense').reduce((s, t) => s + t.amount, 0),
      income: cycleTxns.filter((t) => t.flow === 'Income').reduce((s, t) => s + t.amount, 0),
    };
  });
}

const money = (n) => `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/**
 * Run every guardrail for a cycle and return a flat, sorted flag list.
 * Flags are informational: each carries what tripped it, the subject, and numbers.
 */
export function evaluate({ transactions, statements, cycle, reviewed = new Set() }) {
  const flags = [];
  const cycleTxns = transactions.filter((t) => monthOf(t.date) === cycle);
  const prev = addMonths(cycle, -1);

  // Charges confirmed as one-offs are held out of every comparison — both the
  // baselines and the current month — so a verified one-time item neither trips
  // a flag now nor becomes the yardstick for future months. They stay in
  // `cycleTxns`, so the ledger and the totals still show them in full.
  const isReviewed = (t) => reviewed.has(txnFingerprint(t));
  const compared = reviewed.size ? transactions.filter((t) => !isReviewed(t)) : transactions;
  const comparedCycle = cycleTxns.filter((t) => !isReviewed(t));

  // Which accounts actually contributed data in each month. If a month is missing
  // accounts the other month has, every comparison across the two is skewed — the
  // flag still fires, but it says so rather than quietly reporting a fake percentage.
  const reporting = (month) => new Set(
    transactions.filter((t) => monthOf(t.date) === month).map((t) => t.accountId).filter(Boolean),
  );
  const nowAccounts = reporting(cycle);
  const prevAccounts = reporting(prev);
  const missingVsPrev = [...prevAccounts].filter((a) => !nowAccounts.has(a));
  const comparisonCaveat = missingVsPrev.length
    ? `Comparison is incomplete: ${missingVsPrev.length} account(s) that reported in ${prev} have no data in ${cycle}.`
    : null;

  /* --- 1. subscription month-over-month movement --------------------------- */
  const subs = subscriptionSeries(compared, cycle);
  const current = subs.series.at(-1)?.value || 0;
  const previous = subs.series.at(-2)?.value || 0;
  if (previous > 0) {
    const delta = (current - previous) / previous;
    if (Math.abs(delta) >= THRESHOLDS.subscriptionMoMPct && Math.abs(current - previous) >= THRESHOLDS.minFlagAmount) {
      flags.push({
        id: `sub-total-${cycle}`,
        type: 'subscription-jump',
        severity: delta > 0 ? 'critical' : 'good',
        title: `Subscriptions ${delta > 0 ? 'up' : 'down'} ${pct(Math.abs(delta))} month over month`,
        detail: `Total subscription burn moved from ${money(previous)} in ${prev} to ${money(current)} in ${cycle}.`,
        numbers: { previous, current, delta },
        subject: 'All subscriptions',
        caveat: comparisonCaveat,
      });
    }
  }

  // Per-subscription movement, so the total's drivers are visible individually.
  for (const sub of subs.subscriptions) {
    if (sub.previous <= 0 || sub.current <= 0) continue;
    const delta = (sub.current - sub.previous) / sub.previous;
    if (Math.abs(delta) < THRESHOLDS.subscriptionMoMPct) continue;
    if (Math.abs(sub.current - sub.previous) < THRESHOLDS.minFlagAmount) continue;
    flags.push({
      id: `sub-${sub.merchant}-${cycle}`,
      type: 'subscription-jump',
      severity: delta > 0 ? 'warning' : 'good',
      title: `${sub.merchant} ${delta > 0 ? 'up' : 'down'} ${pct(Math.abs(delta))}`,
      detail: `${money(sub.previous)} → ${money(sub.current)} between ${prev} and ${cycle}.`,
      numbers: { previous: sub.previous, current: sub.current, delta },
      subject: sub.merchant,
      caveat: comparisonCaveat,
    });
  }

  // New and disappeared subscriptions are changes worth surfacing too.
  for (const sub of subs.subscriptions) {
    if (sub.current > 0 && sub.previous === 0 && sub.monthsActive === 1) {
      flags.push({
        id: `sub-new-${sub.merchant}-${cycle}`,
        type: 'subscription-new',
        severity: 'warning',
        title: `New subscription: ${sub.merchant}`,
        detail: `First charge seen this cycle at ${money(sub.current)}.`,
        numbers: { current: sub.current },
        subject: sub.merchant,
      });
    }
    if (sub.current === 0 && sub.previous > 0 && sub.cadence !== 'annual') {
      flags.push({
        id: `sub-gone-${sub.merchant}-${cycle}`,
        type: 'subscription-cancelled',
        severity: 'good',
        title: `${sub.merchant} did not bill this cycle`,
        detail: `Charged ${money(sub.previous)} in ${prev}, nothing in ${cycle}. Cancelled, or a billing date shift.`,
        numbers: { previous: sub.previous, current: 0 },
        subject: sub.merchant,
        caveat: comparisonCaveat,
      });
    }
  }

  /* --- 1b. recurring bills ------------------------------------------------- */
  // Same movement test, reported separately from subscriptions so the two
  // numbers stay readable.
  const bills = subscriptionSeries(compared, cycle, THRESHOLDS.baselineMonths + 1, 'bill');
  for (const bill of bills.subscriptions) {
    if (bill.previous <= 0 || bill.current <= 0) continue;
    const delta = (bill.current - bill.previous) / bill.previous;
    if (Math.abs(delta) < THRESHOLDS.subscriptionMoMPct) continue;
    if (Math.abs(bill.current - bill.previous) < THRESHOLDS.minFlagAmount) continue;
    flags.push({
      id: `bill-${bill.merchant}-${cycle}`,
      type: 'bill-change',
      severity: delta > 0 ? 'serious' : 'good',
      title: `${bill.merchant} ${delta > 0 ? 'up' : 'down'} ${pct(Math.abs(delta))}`,
      detail: `Recurring bill moved ${money(bill.previous)} → ${money(bill.current)} between ${prev} and ${cycle}.`,
      numbers: { previous: bill.previous, current: bill.current, delta },
      subject: bill.merchant,
      caveat: comparisonCaveat,
    });
  }

  /* --- 2. category over trailing-12-month baseline -------------------------- */
  const { baselines, window } = categoryBaselines(compared, cycle);
  const cycleByCategory = new Map();
  for (const t of comparedCycle) {
    if (!isSpend(t)) continue;
    cycleByCategory.set(t.category, (cycleByCategory.get(t.category) || 0) + t.amount);
  }
  for (const [category, total] of cycleByCategory) {
    const base = baselines.get(category);
    if (!base || base.baseline <= 0 || base.monthsActive < 2) continue;
    const over = total - base.baseline;
    if (over <= 0 || over < THRESHOLDS.minFlagAmount) continue;
    const ratio = over / base.baseline;
    if (ratio < THRESHOLDS.categoryOverBaselinePct) continue;
    flags.push({
      id: `cat-${category}-${cycle}`,
      type: 'category-overspend',
      severity: ratio >= 0.5 ? 'critical' : 'serious',
      title: `${category} above its 12-month baseline by ${pct(ratio)}`,
      detail: `${money(total)} this cycle vs a ${money(base.baseline)}/mo baseline over ${base.monthsActive} active month${base.monthsActive === 1 ? '' : 's'}.`,
      numbers: { current: total, baseline: base.baseline, delta: ratio },
      subject: category,
      caveat: comparisonCaveat,
    });
  }

  /* --- 3. unmapped merchants ----------------------------------------------- */
  for (const group of groupUnmapped(comparedCycle)) {
    flags.push({
      id: `unmapped-${group.key}-${cycle}`,
      type: 'unmapped-merchant',
      severity: 'warning',
      title: `Unmapped merchant: ${group.display}`,
      detail: `${group.count} charge${group.count === 1 ? '' : 's'} totalling ${money(group.total)} on ${group.accounts.join(', ')}. No lookup-table entry, so it has not been categorized.`,
      numbers: { current: group.total, count: group.count },
      subject: group.display,
      merchantKey: group.key,
      example: group.example,
      suggestedPattern: group.suggestedPattern,
    });
  }

  /* --- 4. accounts missing a statement ------------------------------------- */
  const coverage = accountCoverage(transactions, statements, cycle);
  for (const account of coverage) {
    if (account.hasStatement || account.hasTransactions) continue;
    flags.push({
      id: `missing-${account.accountId}-${cycle}`,
      type: 'missing-statement',
      severity: 'critical',
      title: `No statement for ${account.name}`,
      detail: `Nothing was ingested for ${account.name} (${account.type}) in ${cycle}. This is reported, not assumed to be zero activity — upload the statement to Drive and re-scan.`,
      numbers: {},
      subject: account.name,
    });
  }

  /* --- disclosure: what was held out of the comparisons ------------------- */
  const heldOut = cycleTxns.filter(isReviewed);
  if (heldOut.length) {
    const total = heldOut.reduce((sum, t) => sum + t.amount, 0);
    flags.push({
      id: `reviewed-${cycle}`,
      type: 'reviewed-excluded',
      severity: 'info',
      title: `${heldOut.length} reviewed one-time item${heldOut.length === 1 ? '' : 's'} held out of this cycle's comparisons`,
      detail: `${money(total)} across ${heldOut.length} charge${heldOut.length === 1 ? '' : 's'} marked as verified one-offs. They remain in the ledger and in every total; only the baseline and month-over-month comparisons skip them.`,
      numbers: { current: total, count: heldOut.length },
      subject: 'Reviewed items',
      items: heldOut.map((t) => ({
        date: t.date, amount: t.amount, description: t.description, accountName: t.accountName,
      })),
    });
  }

  const order = { critical: 0, serious: 1, warning: 2, good: 3, info: 4 };
  flags.sort((a, b) => (order[a.severity] - order[b.severity])
    || (Math.abs(b.numbers?.current || 0) - Math.abs(a.numbers?.current || 0)));

  return { flags, subscriptions: subs, bills, baselines, coverage, window, cycleTxns, heldOut };
}

/** Spend by category for a cycle, with baseline comparison, for the charts. */
export function categoryBreakdown(transactions, cycle, reviewed = new Set()) {
  if (reviewed.size) transactions = transactions.filter((t) => !reviewed.has(txnFingerprint(t)));
  const { baselines } = categoryBaselines(transactions, cycle);
  const totals = new Map();
  for (const t of transactions) {
    if (monthOf(t.date) !== cycle || !isSpend(t)) continue;
    totals.set(t.category, (totals.get(t.category) || 0) + t.amount);
  }
  return [...totals.entries()]
    .map(([category, total]) => {
      const base = baselines.get(category);
      return {
        category,
        total,
        baseline: base?.baseline || 0,
        overBaseline: base ? total > base.baseline && base.monthsActive >= 2 : false,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** Monthly totals per category across a window, for the trend chart. */
export function categoryTrend(transactions, cycle, months = THRESHOLDS.baselineMonths, topN = 7, reviewed = new Set()) {
  if (reviewed.size) transactions = transactions.filter((t) => !reviewed.has(txnFingerprint(t)));
  const window = monthRange(cycle, months);
  const inWindow = new Set(window);
  const byCategory = new Map();

  for (const t of transactions) {
    const m = monthOf(t.date);
    if (!inWindow.has(m) || !isSpend(t)) continue;
    if (!byCategory.has(t.category)) byCategory.set(t.category, new Map());
    const rec = byCategory.get(t.category);
    rec.set(m, (rec.get(m) || 0) + t.amount);
  }

  const ranked = [...byCategory.entries()]
    .map(([category, m]) => ({ category, total: [...m.values()].reduce((a, b) => a + b, 0), months: m }))
    .sort((a, b) => b.total - a.total);

  // Never cycle colours: keep the top N and fold the rest into a single "Other".
  const top = ranked.slice(0, topN);
  const rest = ranked.slice(topN);
  const series = top.map((r) => ({
    category: r.category,
    values: window.map((m) => r.months.get(m) || 0),
  }));
  if (rest.length) {
    series.push({
      category: 'Other',
      values: window.map((m) => rest.reduce((s, r) => s + (r.months.get(m) || 0), 0)),
      folded: rest.length,
    });
  }
  return { window, series };
}
