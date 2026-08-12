// Local persistence. Everything the user edits (the merchant lookup table,
// acknowledged flags, the ingest registry, settings) lives in localStorage so the
// tool is genuinely single-user and local. Nothing is written back to Drive.

const PREFIX = 'pcfo:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not persist', key, err);
  }
}

export const store = {
  get: read,
  set: write,
  remove(key) {
    localStorage.removeItem(PREFIX + key);
  },
  clearAll() {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  },
};

/* ----------------------------------------------------------- merchant table */

/**
 * The merchant lookup table = seed rules + user overrides, keyed by pattern.
 * User edits always win and survive a re-seed.
 */
export function loadMerchantRules(seedRules) {
  const overrides = read('merchantOverrides', {});
  const removed = new Set(read('merchantRemoved', []));
  const byPattern = new Map();

  for (const rule of seedRules) {
    if (removed.has(rule.pattern)) continue;
    byPattern.set(rule.pattern, { ...rule });
  }
  for (const [pattern, rule] of Object.entries(overrides)) {
    byPattern.set(pattern, { ...(byPattern.get(pattern) || {}), ...rule, pattern, source: 'user' });
  }
  return [...byPattern.values()];
}

export function saveMerchantOverride(rule) {
  const overrides = read('merchantOverrides', {});
  overrides[rule.pattern] = rule;
  write('merchantOverrides', overrides);
}

export function removeMerchantRule(pattern) {
  const overrides = read('merchantOverrides', {});
  delete overrides[pattern];
  write('merchantOverrides', overrides);
  const removed = new Set(read('merchantRemoved', []));
  removed.add(pattern);
  write('merchantRemoved', [...removed]);
}

/* --------------------------------------------------------- ingest registry */

/** fileId -> { fileName, accountId, statementDate, ingestedAt, txnCount } */
export function ingestRegistry() {
  return read('ingested', {});
}

export function recordIngest(statement, txnCount) {
  const reg = ingestRegistry();
  reg[statement.fileId] = {
    fileName: statement.fileName,
    accountId: statement.accountId,
    statementDate: statement.statementDate,
    ingestedAt: new Date().toISOString(),
    txnCount,
  };
  write('ingested', reg);
}

export function forgetIngests() {
  write('ingested', {});
}

/* ------------------------------------------------------------------- flags */

export function acknowledgedFlags(cycle) {
  return new Set(read(`ack:${cycle}`, []));
}

export function acknowledgeFlag(cycle, flagId) {
  const acked = new Set(read(`ack:${cycle}`, []));
  acked.add(flagId);
  write(`ack:${cycle}`, [...acked]);
}

export function unacknowledgeFlag(cycle, flagId) {
  const acked = new Set(read(`ack:${cycle}`, []));
  acked.delete(flagId);
  write(`ack:${cycle}`, [...acked]);
}

/* -------------------------------------------------- reviewed one-time items */

/**
 * Charges a human has checked and confirmed are legitimate one-offs.
 *
 * This is deliberately different from acknowledging a flag. Acknowledging says
 * "I've seen this flag" and resets every cycle. Marking a charge reviewed says
 * "this specific charge is verified and is not part of our recurring pattern",
 * so it is kept out of baselines and comparisons permanently — otherwise a
 * one-time loan repayment or a holiday becomes the yardstick every future month
 * is measured against.
 *
 * It is scoped to one transaction fingerprint, never to a rule or a merchant, so
 * a future large charge is still evaluated normally. Reviewed items stay visible
 * in the ledger and in every total; only the guardrail comparisons skip them,
 * and each cycle discloses which ones it skipped.
 */
export function reviewedItems() {
  return read('reviewed', {});
}

export function reviewedSet() {
  return new Set(Object.keys(read('reviewed', {})));
}

export function markReviewed(fingerprint, meta = {}) {
  const items = read('reviewed', {});
  items[fingerprint] = {
    note: meta.note || '',
    date: meta.date || '',
    amount: meta.amount ?? null,
    description: meta.description || '',
    accountName: meta.accountName || '',
    reviewedAt: new Date().toISOString(),
  };
  write('reviewed', items);
}

export function unmarkReviewed(fingerprint) {
  const items = read('reviewed', {});
  delete items[fingerprint];
  write('reviewed', items);
}

/* ------------------------------------------------------ spend type overrides */

/**
 * Per-transaction Business/Personal overrides.
 *
 * Daniko cards default to Business because that is what they mostly are, but a
 * default nobody can see or reverse is just a hidden assumption. These make the
 * call explicit and per-charge: the row shows where the value came from, and one
 * click changes it.
 */
export function spendTypeOverrides() {
  return read('spendTypeOverrides', {});
}

export function setSpendTypeOverride(fingerprint, value) {
  const all = read('spendTypeOverrides', {});
  all[fingerprint] = value;
  write('spendTypeOverrides', all);
}

export function clearSpendTypeOverride(fingerprint) {
  const all = read('spendTypeOverrides', {});
  delete all[fingerprint];
  write('spendTypeOverrides', all);
}

/* ------------------------------------------------ parsed transaction cache */

export function cacheTransactions(transactions) {
  write('txnCache', transactions);
}

export function cachedTransactions() {
  return read('txnCache', []);
}
