// Shared reporting aggregation — Who / Category / Time filtered summaries.
//
// This is the one place spend gets sliced by persona, category and an
// arbitrary date range. Both the Reports tab and the Melanie summary email
// call buildReport() directly rather than each computing their own totals, so
// the two can never quietly disagree with each other.
//
// This module does not flag anything and has no baseline logic — that stays in
// guardrails.js, untouched. buildReport() only answers "how much, on what, by
// whom, over this window" — a report, not a guardrail.

import { NON_SPEND_CATEGORIES, PERSONAS } from './config.js';

const isNonSpend = (category) => NON_SPEND_CATEGORIES.includes(category);
const sum = (rows) => rows.reduce((s, t) => s + t.amount, 0);
const pad2 = (n) => String(n).padStart(2, '0');

function ymd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Resolve a { mode, month|year|start+end } filter into an inclusive date range. */
export function resolveRange(time) {
  if (!time) throw new Error('reports: a time filter is required');
  if (time.mode === 'monthly') {
    const [y, m] = time.month.split('-').map(Number);
    return { start: ymd(y, m, 1), end: ymd(y, m, daysInMonth(y, m)), granularity: 'day' };
  }
  if (time.mode === 'yearly') {
    const y = Number(time.year);
    return { start: ymd(y, 1, 1), end: ymd(y, 12, 31), granularity: 'month' };
  }
  if (time.mode === 'custom') {
    if (!time.start || !time.end || time.start > time.end) {
      throw new Error('reports: custom range needs start <= end');
    }
    // A custom range spanning a single calendar month reads better broken down
    // by day; anything wider is bucketed by month, same as Yearly.
    const sameMonth = time.start.slice(0, 7) === time.end.slice(0, 7);
    return { start: time.start, end: time.end, granularity: sameMonth ? 'day' : 'month' };
  }
  throw new Error(`reports: unknown time mode "${time.mode}"`);
}

/** The equal-length period immediately preceding `range`, for period-over-period deltas. */
export function previousRange(range) {
  const start = new Date(`${range.start}T00:00:00Z`);
  const end = new Date(`${range.end}T00:00:00Z`);
  const spanMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const prevStart = new Date(prevEnd.getTime() - spanMs);
  const toYmd = (d) => ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  return { start: toYmd(prevStart), end: toYmd(prevEnd), granularity: range.granularity };
}

function groupSum(rows, field) {
  const totals = new Map();
  for (const t of rows) totals.set(t[field], (totals.get(t[field]) || 0) + t.amount);
  return [...totals.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);
}

function bucketLabel(date, granularity) {
  return granularity === 'day' ? date : date.slice(0, 7);
}

function buildTrend(spendRows, incomeRows, range) {
  const buckets = new Map();
  const order = [];
  const push = (date) => {
    const label = bucketLabel(date, range.granularity);
    if (!buckets.has(label)) { buckets.set(label, { label, spend: 0, income: 0 }); order.push(label); }
    return buckets.get(label);
  };

  // Seed every bucket in the range, even empty ones, so a trend line doesn't
  // silently skip a day/month with zero activity.
  if (range.granularity === 'day') {
    const cursor = new Date(`${range.start}T00:00:00Z`);
    const stop = new Date(`${range.end}T00:00:00Z`);
    while (cursor <= stop) {
      push(ymd(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else {
    let [y, m] = range.start.split('-').map(Number);
    const [endY, endM] = range.end.split('-').map(Number);
    while (y < endY || (y === endY && m <= endM)) {
      push(ymd(y, m, 1));
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }

  for (const t of spendRows) push(t.date).spend += t.amount;
  for (const t of incomeRows) push(t.date).income += t.amount;
  return order.map((label) => buckets.get(label));
}

/**
 * Build a summary report over `transactions` (already categorised, carrying
 * `.persona`), filtered by who/category/time.
 *
 * @param {object} filters
 * @param {'All'|'Rob'|'Melanie'|'Daniko'} filters.who
 * @param {'All'|string} filters.category
 * @param {object} filters.time  { mode: 'monthly', month } | { mode: 'yearly', year } | { mode: 'custom', start, end }
 * @param {boolean} [filters.includeIncome]  false by default — Income rows are
 *   excluded entirely unless this is set. When set, Income is reported as its
 *   own figure alongside spend, never merged into it.
 */
export function buildReport(transactions, filters) {
  const who = filters.who || 'All';
  const category = filters.category || 'All';
  const includeIncome = Boolean(filters.includeIncome);
  const range = resolveRange(filters.time);

  const inRange = (t) => t.date >= range.start && t.date <= range.end;
  const matchesWho = (t) => who === 'All' || t.persona === who;
  const matchesCategory = (t) => category === 'All' || t.category === category;

  let base = transactions.filter((t) => inRange(t) && matchesWho(t) && matchesCategory(t));
  if (!includeIncome) base = base.filter((t) => t.flow !== 'Income');

  // Transfers/Income are excluded from the headline spend figure the same way
  // every other view in the app excludes them — but only for the "All
  // categories" aggregate. If someone explicitly picked Transfers or Income as
  // the category filter, that exclusion would zero out the exact thing they
  // asked to see, so it only applies when category === 'All'.
  const excludeNonSpend = category === 'All';
  const spendRows = base.filter((t) => t.flow === 'Expense' && (!excludeNonSpend || !isNonSpend(t.category)));
  const incomeRows = includeIncome ? base.filter((t) => t.flow === 'Income') : [];

  return {
    filters: { who, category, time: filters.time, includeIncome },
    range,
    count: spendRows.length,
    total: sum(spendRows),
    incomeTotal: sum(incomeRows),
    byCategory: category === 'All' ? groupSum(spendRows, 'category') : null,
    byPersona: who === 'All' ? groupSum(spendRows, 'persona') : null,
    trend: buildTrend(spendRows, incomeRows, range),
  };
}

/**
 * A report plus its period-over-period comparison (previous period of equal
 * length) and the categories that moved most — the "notable changes" both the
 * Reports tab and the email draft show. Still just arithmetic over
 * buildReport(); no flagging, no baseline.
 */
export function buildReportWithComparison(transactions, filters) {
  const current = buildReport(transactions, filters);
  const previous = buildReport(transactions, { ...filters, time: { mode: 'custom', ...previousRange(current.range) } });

  const delta = previous.total > 0 ? (current.total - previous.total) / previous.total : null;

  let movers = [];
  if (current.byCategory && previous.byCategory) {
    const prevByKey = new Map(previous.byCategory.map((c) => [c.key, c.total]));
    movers = current.byCategory
      .map((c) => {
        const prev = prevByKey.get(c.key) || 0;
        return { category: c.key, current: c.total, previous: prev, delta: c.total - prev };
      })
      .filter((m) => Math.abs(m.delta) >= 5)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);
  }

  return { current, previous, delta, movers };
}

export { PERSONAS };
