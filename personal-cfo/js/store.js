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

/* ------------------------------------------------ parsed transaction cache */

export function cacheTransactions(transactions) {
  write('txnCache', transactions);
}

export function cachedTransactions() {
  return read('txnCache', []);
}
