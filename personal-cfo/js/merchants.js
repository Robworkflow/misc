// Merchant normalization, consolidation and category lookup.
//
// The normalization here is deliberately identical to tools/build_seed.py so the
// patterns generated offline match at runtime. If you change one, change both.

import { UNMAPPED } from './config.js';

const REGION = ('ON BC AB QC MB SK NS NB NL PE YT NT NU CA US NY MA WA TX CO IL NJ FL GA '
  + 'PA OH MI NC VA AZ NV UT OR MN MO TN IN WI MD').split(' ');
const REGION_RE = new RegExp(`\\b(?:${REGION.join('|')})\\b\\s*$`);

/** Strip the volatile parts of a statement descriptor (ids, phone numbers, cities). */
export function clean(desc) {
  let d = String(desc || '').toUpperCase();
  d = d.replace(/\d{3}[-\s]?\d{3}[-\s]?\d{4}/g, ' ');       // phone numbers
  d = d.replace(/HTTPS?[A-Z0-9.:/_-]+/g, ' ');               // embedded urls
  d = d.replace(/WWW\.[A-Z0-9.-]+/g, ' ');
  // Transaction ids after * or # — only when the token looks like an id (has a
  // digit). 'SQ *SNOWBERRY BOTANICALS' puts the real merchant name after the star.
  d = d.replace(/[*#]\s*(?=[A-Z0-9]*\d)[A-Z0-9]{4,}/g, ' ');
  d = d.replace(/\b\d{4,}\b/g, ' ');                         // long digit runs
  d = d.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i += 1) d = d.replace(REGION_RE, '').trim();
  return d;
}

/** Alnum-only signature; collapses spacing variants of the same merchant. */
export function signature(desc) {
  return clean(desc).replace(/[^A-Z0-9]/g, '');
}

/**
 * Match a description against the lookup table.
 * Longest pattern wins, so a specific rule beats a general one
 * ("GOOGLEWORKSPACE" beats "GOOGLE").
 */
export function lookup(desc, rules) {
  const sig = signature(desc);
  if (!sig) return null;
  let best = null;
  for (const rule of rules) {
    if (!rule.pattern) continue;
    if (sig.includes(rule.pattern) && (!best || rule.pattern.length > best.pattern.length)) {
      best = rule;
    }
  }
  return best;
}

/** Index rules once, sorted longest-first, for repeated lookups. */
export function compile(rules) {
  const sorted = [...rules].sort((a, b) => b.pattern.length - a.pattern.length);
  return {
    rules: sorted,
    match(desc) {
      const sig = signature(desc);
      if (!sig) return null;
      return sorted.find((r) => r.pattern && sig.includes(r.pattern)) || null;
    },
  };
}

/**
 * Apply the lookup table to a transaction, producing its display merchant,
 * category and spend type. A merchant with no rule is tagged Unmapped and never
 * guessed into a category.
 */
export function categorize(txn, index, account) {
  const rule = index.match(txn.description);
  if (!rule) {
    return {
      ...txn,
      merchant: titleCase(clean(txn.description)) || txn.description,
      merchantKey: signature(txn.description),
      category: txn.flow === 'Income' ? 'Income' : UNMAPPED,
      spendType: txn.spendType || account?.defaultSpendType || null,
      person: txn.person || account?.person || null,
      isSubscription: false,
      recurringType: null,
      unmapped: txn.flow !== 'Income',
      ruleSource: null,
    };
  }
  return {
    ...txn,
    merchant: rule.display,
    merchantKey: rule.pattern,
    category: rule.category,
    spendType: rule.spendType || txn.spendType || account?.defaultSpendType || null,
    person: rule.person || txn.person || account?.person || null,
    isSubscription: Boolean(rule.isSubscription),
    // 'subscription' | 'bill' | null. Only true subscriptions feed the
    // subscription-burn guardrail; recurring bills are tracked separately.
    recurringType: rule.recurringType || (rule.isSubscription ? 'subscription' : null),
    cadence: rule.cadence || null,
    unmapped: rule.category === 'Needs Review',
    ruleSource: rule.source || null,
  };
}

export function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group unmapped transactions by merchant signature so the Flags tab asks the
 * user once per merchant instead of once per charge.
 */
export function groupUnmapped(transactions) {
  const groups = new Map();
  for (const t of transactions) {
    if (!t.unmapped) continue;
    const key = t.merchantKey || signature(t.description);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        suggestedPattern: key.slice(0, 12),
        display: t.merchant,
        example: t.description,
        count: 0,
        total: 0,
        accounts: new Set(),
        firstSeen: t.date,
        lastSeen: t.date,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.total += Math.abs(t.amount);
    g.accounts.add(t.accountName);
    if (t.date < g.firstSeen) g.firstSeen = t.date;
    if (t.date > g.lastSeen) g.lastSeen = t.date;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, accounts: [...g.accounts] }))
    .sort((a, b) => b.total - a.total);
}
