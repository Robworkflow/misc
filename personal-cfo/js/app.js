// Application bootstrap and orchestration.

import { DRIVE, ACCOUNTS, THRESHOLDS, UNMAPPED } from './config.js';
import {
  store, loadMerchantRules, saveMerchantOverride, removeMerchantRule,
  ingestRegistry, recordIngest, forgetIngests,
  acknowledgedFlags, acknowledgeFlag, unacknowledgeFlag,
  reviewedSet, markReviewed, unmarkReviewed,
  spendTypeOverrides, setSpendTypeOverride, clearSpendTypeOverride,
  cacheTransactions, cachedTransactions,
} from './store.js';
import { compile, categorize, txnFingerprint } from './merchants.js';
import { suggestAll, suggestCategory } from './suggest.js';
import { parseStatement, parseMasterWorkbook } from './parse.js';
import { evaluate, categoryTrend, categoryBreakdown, monthOf } from './guardrails.js';
import * as drive from './drive.js';
import * as charts from './charts.js';
import * as ui from './ui.js';
import {
  buildUpdatePackage, buildChangelog, downloadChangelog,
  buildEmailDraft, downloadEmail, exportLookupTable,
} from './export.js';

const state = {
  seed: null,
  merchantRules: [],
  categories: [],
  rawTransactions: [],   // uncategorized, from workbook + statements
  transactions: [],      // categorized
  statements: [],
  ingested: {},
  cycle: null,
  cycles: [],
  result: null,
  acked: new Set(),
  reviewed: new Set(),
  suggestions: new Map(),   // fingerprint -> { category, evidence, caution }
  spendOverrides: {},
  corrections: [],
  newTransactions: [],
  activeTab: 'overview',
  filter: { q: '', account: '', category: '', scope: 'cycle', ruleQ: '' },
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------ status */

function status(message, busy = false) {
  const el = $('#status');
  el.innerHTML = message
    ? `<span class="progress">${busy ? '<span class="spinner"></span>' : ''}${ui.esc(message)}</span>`
    : '';
}

function banner(kind, title, body) {
  const el = $('#banners');
  const div = document.createElement('div');
  div.className = `banner ${kind}`;
  div.innerHTML = `<div class="body"><strong>${ui.esc(title)}</strong><p>${ui.esc(body)}</p></div>`;
  el.appendChild(div);
  return div;
}

function clearBanners() { $('#banners').innerHTML = ''; }

/* -------------------------------------------------------------- data model */

function recategorize() {
  const index = compile(state.merchantRules);
  const byName = new Map(ACCOUNTS.map((a) => [a.name, a]));
  const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));

  state.reviewed = reviewedSet();
  state.spendOverrides = spendTypeOverrides();
  state.transactions = state.rawTransactions.map((t) => {
    const account = byId.get(t.accountId) || byName.get(t.accountName) || null;
    const categorized = categorize({ ...t, accountId: t.accountId || account?.id || null }, index, account);
    // Computed once here so the table and the engine agree on identity.
    const fingerprint = txnFingerprint(categorized);
    const override = state.spendOverrides[fingerprint];
    return {
      ...categorized,
      fingerprint,
      spendType: override || categorized.spendType,
      spendTypeSource: override ? 'user' : categorized.spendTypeSource,
    };
  });

  // Proposals only. Nothing here is written to a category — see js/suggest.js.
  state.suggestions = suggestAll(state.transactions);

  state.cycles = [...new Set(state.transactions.map((t) => monthOf(t.date)).filter(Boolean))].sort();
  if (!state.cycle || !state.cycles.includes(state.cycle)) {
    state.cycle = state.cycles.at(-1) || new Date().toISOString().slice(0, 7);
  }
  state.acked = acknowledgedFlags(state.cycle);
  state.result = evaluate({
    transactions: state.transactions,
    statements: state.statements,
    cycle: state.cycle,
    reviewed: state.reviewed,
  });
  for (const flag of state.result.flags) {
    if (flag.type !== 'unmapped-merchant' || !flag.example) continue;
    flag.suggestion = suggestCategory({
      description: flag.example, amount: flag.numbers?.current || 0, flow: 'Expense',
    });
  }

  cacheTransactions(state.rawTransactions);
}

/* ------------------------------------------------------------------ render */

function render() {
  renderCycleOptions();
  ui.setTabCounts(state.result, state.acked);

  const tab = state.activeTab;
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });

  const panel = document.querySelector(`.panel[data-panel="${tab}"]`);
  if (!panel || !state.result) return;

  if (tab === 'overview') {
    ui.renderOverview(panel, state);
    drawCharts();
  } else if (tab === 'transactions') {
    ui.renderTransactions(panel, state);
  } else if (tab === 'flags') {
    ui.renderFlags(panel, state);
  } else if (tab === 'subscriptions') {
    ui.renderSubscriptions(panel, state);
    charts.subscriptionTrendChart('chart-sub-detail', state.result.subscriptions.series, THRESHOLDS.subscriptionMoMPct);
  } else if (tab === 'accounts') {
    ui.renderAccounts(panel, state);
  } else if (tab === 'merchants') {
    ui.renderMerchants(panel, state);
  }
}

function drawCharts() {
  const trend = categoryTrend(state.transactions, state.cycle, undefined, undefined, state.reviewed);
  const breached = new Set(
    state.result.flags.filter((f) => f.type === 'category-overspend').map(() => state.cycle),
  );
  charts.categoryTrendChart('chart-category-trend', trend, breached);
  charts.subscriptionTrendChart('chart-sub-trend', state.result.subscriptions.series, THRESHOLDS.subscriptionMoMPct);
  charts.categoryVsBaselineChart('chart-category-baseline', categoryBreakdown(state.transactions, state.cycle, state.reviewed));
  charts.accountChart('chart-accounts', state.result.coverage);
}

function renderCycleOptions() {
  const sel = $('#cycle-select');
  if (!sel) return;
  const current = state.cycle;
  sel.innerHTML = state.cycles.slice().reverse().map((c) => `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`).join('');
}

/* ----------------------------------------------------------------- actions */

async function connectDrive() {
  clearBanners();
  try {
    status('Connecting to Google Drive…', true);
    await drive.signIn();
    status('Connected. Loading the master workbook…', true);
    await loadMaster();
    await scanDrive();
    status('');
  } catch (err) {
    status('');
    banner('error', 'Could not connect to Drive', err.message);
  }
}

async function loadMaster() {
  const buffer = await drive.fetchMasterWorkbook();
  const rows = parseMasterWorkbook(buffer, window.XLSX);
  const byName = new Map(ACCOUNTS.map((a) => [a.name, a]));
  const workbookRows = rows.map((r) => ({ ...r, accountId: byName.get(r.accountName)?.id || null }));

  // Keep any statement-sourced transactions; replace the workbook baseline.
  state.rawTransactions = [
    ...state.rawTransactions.filter((t) => t.source === 'statement'),
    ...workbookRows,
  ];
  recategorize();
  render();
  banner('', 'Master workbook loaded', `${rows.length.toLocaleString()} transactions read from ${DRIVE.masterFileName}. This file is read-only to the app.`);
}

async function scanDrive() {
  status('Scanning the Drive statement folders…', true);
  const { statements, problems } = await drive.scanStatements();
  state.statements = statements;
  state.ingested = ingestRegistry();
  problems.forEach((p) => banner('warn', 'Drive scan warning', p));

  const pending = drive.newSince(statements, state.ingested);
  status('');
  recategorize();
  render();

  if (pending.length) {
    banner('warn', `${pending.length} new statement${pending.length === 1 ? '' : 's'} found`,
      `${pending.map((s) => s.fileName).slice(0, 6).join(', ')}${pending.length > 6 ? `, +${pending.length - 6} more` : ''}. Use "Ingest new statements" to parse them.`);
  } else if (statements.length) {
    banner('', 'No new statements', `All ${statements.length} statements in Drive have already been ingested.`);
  }
  $('#btn-ingest').disabled = pending.length === 0;
}

async function ingestNew() {
  clearBanners();
  const pending = drive.newSince(state.statements, ingestRegistry());
  if (!pending.length) { banner('', 'Nothing to ingest', 'No new statements were found in Drive.'); return; }

  const pdfjsLib = window.pdfjsLib;
  const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
  const added = [];
  const summary = [];

  for (let i = 0; i < pending.length; i += 1) {
    const s = pending[i];
    status(`Parsing ${i + 1} of ${pending.length}: ${s.fileName}`, true);
    try {
      const buffer = await drive.downloadFile(s.fileId);
      const account = byId.get(s.accountId);
      const parsed = await parseStatement(buffer, account, pdfjsLib);
      const rows = parsed.transactions.map((t) => ({ ...t, statementFile: s.fileName }));
      added.push(...rows);
      recordIngest(s, rows.length);
      summary.push({ ...s, txnCount: rows.length });
      if (!rows.length) {
        banner('warn', `No transactions found in ${s.fileName}`,
          'The statement was read but no transaction rows matched the expected layout. It may be a different statement format.');
      }
    } catch (err) {
      banner('error', `Could not parse ${s.fileName}`, err.message);
    }
  }

  // De-duplicate against what is already loaded: the workbook and the statements
  // overlap for months that were already entered by hand.
  const existing = new Set(state.rawTransactions.map(txnFingerprint));
  const fresh = added.filter((t) => !existing.has(txnFingerprint(t)));

  state.rawTransactions.push(...fresh);
  state.newTransactions = fresh;
  state.ingested = ingestRegistry();
  recategorize();
  render();
  status('');

  banner('', `Ingested ${summary.length} statement${summary.length === 1 ? '' : 's'}`,
    `${fresh.length} new transactions added (${added.length - fresh.length} were already present in the workbook and were skipped).`);
  $('#btn-ingest').disabled = true;
}



/* --------------------------------------------------------- lookup editing */

function assignCategory(merchantKey, display, category) {
  if (!category) return;
  const pattern = (merchantKey || '').slice(0, 12);
  if (!pattern) return;

  const rule = {
    pattern,
    display: display || pattern,
    category,
    spendType: null,
    person: null,
    isSubscription: category === 'Subscriptions',
    recurringType: category === 'Subscriptions' ? 'subscription' : null,
    cadence: null,
    source: 'user',
  };
  saveMerchantOverride(rule);
  state.merchantRules = loadMerchantRules(state.seed.merchantRules);
  state.corrections.push(rule);
  recategorize();
  render();
  status(`Mapped "${display}" to ${category}. The lookup table now covers every matching charge.`);
  setTimeout(() => status(''), 4000);
}

/* -------------------------------------------------------------- exporting */

function generatePackage() {
  if (!state.result) return;
  buildUpdatePackage({
    transactions: state.transactions,
    flags: state.result.flags,
    subscriptions: state.result.subscriptions,
    bills: state.result.bills,
    coverage: state.result.coverage,
    cycle: state.cycle,
    merchantRules: state.merchantRules,
    newTransactions: state.newTransactions,
    reviewed: state.reviewed,
    suggestions: state.suggestions,
  }, window.XLSX);

  const ingestedThisRun = Object.entries(state.ingested)
    .map(([, v]) => v)
    .filter((v) => v.statementDate && monthOf(v.statementDate) === state.cycle)
    .map((v) => ({ accountName: ACCOUNTS.find((a) => a.id === v.accountId)?.name || v.accountId, fileName: v.fileName, txnCount: v.txnCount }));

  const changelog = buildChangelog({
    cycle: state.cycle,
    flags: state.result.flags,
    newTransactions: state.newTransactions,
    ingested: ingestedThisRun,
    coverage: state.result.coverage,
    corrections: state.corrections,
    heldOut: state.result.heldOut,
    pendingSuggestions: state.result.cycleTxns.filter((t) => t.unmapped && state.suggestions.has(t.fingerprint)).length,
  });
  downloadChangelog(changelog, state.cycle);
  banner('', 'Update package generated',
    'The workbook and changelog downloaded. Review them, then re-upload the workbook to Drive yourself — the app never overwrites the master file.');
}

function showEmailDraft() {
  const text = buildEmailDraft({
    cycle: state.cycle,
    flags: state.result.flags,
    subscriptions: state.result.subscriptions,
    coverage: state.result.coverage,
    transactions: state.transactions,
  });
  $('#email-text').textContent = text;
  $('#email-dialog').showModal();
  $('#email-dialog').dataset.text = text;
}

/* ------------------------------------------------------------------ events */

function wireEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => { state.activeTab = btn.dataset.tab; render(); });
  });

  $('#btn-connect').addEventListener('click', connectDrive);
  $('#btn-scan').addEventListener('click', () => scanDrive().catch((e) => banner('error', 'Scan failed', e.message)));
  $('#btn-ingest').addEventListener('click', () => ingestNew().catch((e) => banner('error', 'Ingest failed', e.message)));
  $('#btn-package').addEventListener('click', generatePackage);
  $('#btn-email').addEventListener('click', showEmailDraft);

  $('#cycle-select').addEventListener('change', (e) => {
    state.cycle = e.target.value;
    state.acked = acknowledgedFlags(state.cycle);
    state.result = evaluate({
      transactions: state.transactions, statements: state.statements, cycle: state.cycle, reviewed: state.reviewed,
    });
    render();
  });

  // Settings.
  $('#btn-settings').addEventListener('click', () => {
    $('#set-client-id').value = drive.getClientId();
    $('#set-master-id').value = store.get('masterFileId', DRIVE.masterFileId);
    $('#settings-dialog').showModal();
  });
  $('#settings-save').addEventListener('click', (e) => {
    e.preventDefault();
    store.set('googleClientId', $('#set-client-id').value.trim());
    store.set('masterFileId', $('#set-master-id').value.trim() || DRIVE.masterFileId);
    $('#settings-dialog').close();
    status('Settings saved.');
    setTimeout(() => status(''), 2500);
  });
  $('#settings-reset').addEventListener('click', (e) => {
    e.preventDefault();
    if (!window.confirm('Clear the ingest history so every statement is treated as new? Your lookup-table edits are kept.')) return;
    forgetIngests();
    state.ingested = {};
    $('#settings-dialog').close();
    scanDrive();
  });

  $('#email-copy').addEventListener('click', async (e) => {
    e.preventDefault();
    const text = $('#email-dialog').dataset.text || '';
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy to clipboard'; }, 2000);
    } catch {
      downloadEmail(text, state.cycle);
    }
  });
  $('#email-download').addEventListener('click', (e) => {
    e.preventDefault();
    downloadEmail($('#email-dialog').dataset.text || '', state.cycle);
  });

  // Delegated: category assignment, acknowledgement, rule edits, filters.
  document.addEventListener('change', (e) => {
    const assign = e.target.closest('.assign-category');
    if (assign) {
      assignCategory(assign.dataset.key, assign.dataset.display, assign.value);
      return;
    }
    const edit = e.target.closest('.edit-rule-category');
    if (edit) {
      const rule = state.merchantRules.find((r) => r.pattern === edit.dataset.pattern);
      if (rule) assignCategory(rule.pattern, rule.display, edit.value);
      return;
    }
    if (e.target.id === 'txn-account') { state.filter.account = e.target.value; render(); }
    if (e.target.id === 'txn-category') { state.filter.category = e.target.value; render(); }
    if (e.target.id === 'txn-scope') { state.filter.scope = e.target.value; render(); }
  });

  document.addEventListener('click', (e) => {
    const ack = e.target.closest('.ack-flag');
    if (ack) {
      const id = ack.dataset.flag;
      if (state.acked.has(id)) { unacknowledgeFlag(state.cycle, id); state.acked.delete(id); }
      else { acknowledgeFlag(state.cycle, id); state.acked.add(id); }
      render();
      return;
    }
    const accept = e.target.closest('.accept-suggestion');
    if (accept) {
      // The one place a suggestion turns into a category: an explicit human click.
      assignCategory(accept.dataset.key, accept.dataset.display, accept.dataset.category);
      return;
    }
    const flip = e.target.closest('.flip-spendtype');
    if (flip) {
      setSpendTypeOverride(flip.dataset.fp, flip.dataset.to);
      recategorize();
      render();
      status(`Recorded as ${flip.dataset.to} for this charge only.`);
      setTimeout(() => status(''), 4000);
      return;
    }
    const resetSpend = e.target.closest('.reset-spendtype');
    if (resetSpend) {
      clearSpendTypeOverride(resetSpend.dataset.fp);
      recategorize();
      render();
      return;
    }
    const rev = e.target.closest('.toggle-reviewed');
    if (rev) {
      const fp = rev.dataset.fp;
      const txn = state.transactions.find((t) => t.fingerprint === fp);
      if (state.reviewed.has(fp)) {
        unmarkReviewed(fp);
        status('Charge put back into the baseline comparisons.');
      } else {
        markReviewed(fp, txn ? {
          date: txn.date, amount: txn.amount, description: txn.description, accountName: txn.accountName,
        } : {});
        status('Marked as a reviewed one-time item. It stays in your totals but is held out of baselines and month-over-month comparisons.');
      }
      recategorize();
      render();
      setTimeout(() => status(''), 5000);
      return;
    }
    const del = e.target.closest('.delete-rule');
    if (del) {
      removeMerchantRule(del.dataset.pattern);
      state.merchantRules = loadMerchantRules(state.seed.merchantRules);
      recategorize();
      render();
      return;
    }
    if (e.target.id === 'export-lookup') exportLookupTable(state.merchantRules);
  });

  let searchTimer;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'txn-search' && e.target.id !== 'rule-search') return;
    const isRule = e.target.id === 'rule-search';
    const value = e.target.value;
    const pos = e.target.selectionStart;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (isRule) state.filter.ruleQ = value; else state.filter.q = value;
      render();
      const again = document.getElementById(isRule ? 'rule-search' : 'txn-search');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }, 220);
  });
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  wireEvents();

  const seed = await fetch('./data/seed.json').then((r) => r.json());
  state.seed = seed;
  state.categories = [...seed.categories, UNMAPPED].sort();
  state.merchantRules = loadMerchantRules(seed.merchantRules);
  state.ingested = ingestRegistry();

  const cached = cachedTransactions();
  if (cached.length) {
    state.rawTransactions = cached;
    recategorize();
    render();
    banner('', 'Loaded from local cache',
      `${cached.length.toLocaleString()} transactions restored from this browser. Connect Drive to refresh from the master workbook.`);
  } else {
    state.result = evaluate({ transactions: [], statements: [], cycle: new Date().toISOString().slice(0, 7) });
    state.cycle = new Date().toISOString().slice(0, 7);
    render();
  }

  if (!drive.getClientId()) {
    banner('warn', 'Google Drive is not configured yet',
      'Add an OAuth client ID in Settings to read the statement folders and the master workbook. Everything else works offline against cached data.');
  } else if (location.port !== '8000' && location.hostname === 'localhost') {
    // The configured client only authorises http://localhost:8000. Catching this
    // here is far clearer than Google's origin_mismatch error.
    banner('warn', `Serving on port ${location.port || '80'}, not 8000`,
      'The configured OAuth client only authorises http://localhost:8000, so Drive sign-in will fail with origin_mismatch. Restart with ./serve.sh 8000, or add this origin to the client in the Google Cloud console.');
  }
}

boot().catch((err) => {
  console.error(err);
  banner('error', 'Startup failed', err.message);
});
