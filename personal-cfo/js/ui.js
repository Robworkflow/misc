// View rendering. Pure functions of app state -> DOM; all behaviour is wired in
// app.js via delegated events.

import { THRESHOLDS, PERSONAS } from './config.js';
import { monthOf, addMonths } from './guardrails.js';
import { buildReportWithComparison } from './reports.js';

const money = (n, dp = 0) => `$${Math.abs(Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const SEVERITY_LABEL = {
  critical: 'Needs attention',
  serious: 'Above baseline',
  warning: 'Needs review',
  good: 'Improved',
  info: 'For information',
};

const TYPE_LABEL = {
  'subscription-jump': 'Subscription change',
  'subscription-new': 'New subscription',
  'subscription-cancelled': 'Subscription stopped',
  'bill-change': 'Recurring bill change',
  'cellular-jump': 'Cellular bill change',
  'category-overspend': 'Category over baseline',
  'unmapped-merchant': 'Unmapped merchant',
  'missing-statement': 'Missing statement',
  'reviewed-excluded': 'Reviewed one-time items',
};

// Where a Business/Personal call came from. Always shown, so a card-wide default
// reads as a default rather than as a decision somebody made about this charge.
const SPEND_SOURCE = {
  'account-default': { label: 'account default', title: 'Defaulted from the card this charge is on, not decided per charge' },
  rule: { label: 'from lookup rule', title: 'Set by the merchant rule in the lookup table' },
  imported: { label: 'from imported data', title: 'Came in with the row, from the master workbook or the statement' },
  user: { label: 'set by you', title: 'You overrode this for this charge' },
};

function spendSource(t) {
  if (t.spendTypeSource === 'statement') {
    return t.source === 'workbook'
      ? { label: 'from workbook', title: 'Recorded in the master workbook before this app saw it' }
      : { label: 'from statement', title: 'Came in with the imported statement row' };
  }
  return SPEND_SOURCE[t.spendTypeSource];
}

/* --------------------------------------------------------------- overview */

export function renderOverview(el, state) {
  const { cycle, result, transactions } = state;
  const cycleTxns = result.cycleTxns;
  const spend = cycleTxns
    .filter((t) => t.flow === 'Expense' && !['Transfers', 'Income'].includes(t.category))
    .reduce((s, t) => s + t.amount, 0);

  const prevCycle = addMonths(cycle, -1);
  const prevSpend = transactions
    .filter((t) => monthOf(t.date) === prevCycle && t.flow === 'Expense' && !['Transfers', 'Income'].includes(t.category))
    .reduce((s, t) => s + t.amount, 0);
  const spendDelta = prevSpend > 0 ? (spend - prevSpend) / prevSpend : null;

  const subNow = result.subscriptions.series.at(-1)?.value || 0;
  const subPrev = result.subscriptions.series.at(-2)?.value || 0;
  const subDelta = subPrev > 0 ? (subNow - subPrev) / subPrev : null;

  const unmappedCount = cycleTxns.filter((t) => t.unmapped).length;
  const reporting = result.coverage.filter((a) => a.txnCount > 0).length;
  const openFlags = result.flags.filter((f) => !state.acked.has(f.id)).length;

  const deltaClass = (d) => (d == null ? '' : d > 0 ? 'up' : 'down');
  const deltaText = (d) => (d == null ? 'no prior month to compare' : `${d > 0 ? '▲' : '▼'} ${pct(Math.abs(d))} vs ${prevCycle}`);

  el.innerHTML = `
    <div class="grid grid-stats">
      <div class="card stat">
        <span class="label">Spend this cycle</span>
        <span class="value">${money(spend)}</span>
        <span class="meta ${deltaClass(spendDelta)}">${deltaText(spendDelta)}</span>
      </div>
      <div class="card stat">
        <span class="label">Subscription burn</span>
        <span class="value">${money(subNow)}</span>
        <span class="meta ${subDelta != null && Math.abs(subDelta) >= THRESHOLDS.subscriptionMoMPct ? deltaClass(subDelta) : ''}">${deltaText(subDelta)}</span>
      </div>
      <div class="card stat">
        <span class="label">Open flags</span>
        <span class="value">${openFlags}</span>
        <span class="meta ${openFlags ? 'warn' : ''}">${result.flags.length} raised, ${result.flags.length - openFlags} acknowledged</span>
      </div>
      <div class="card stat">
        <span class="label">Accounts reporting</span>
        <span class="value">${reporting} / 7</span>
        <span class="meta ${reporting < 7 ? 'up' : 'down'}">${reporting < 7 ? `${7 - reporting} missing a statement` : 'all accounts covered'}</span>
      </div>
      <div class="card stat">
        <span class="label">Unmapped charges</span>
        <span class="value">${unmappedCount}</span>
        <span class="meta ${unmappedCount ? 'warn' : ''}">${unmappedCount ? 'awaiting a category' : 'everything categorised'}</span>
      </div>
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <h3>Category spend — trailing 12 months</h3>
          <span class="hint">stacked, top 7 + other</span>
        </div>
        <div class="chart-box tall"><canvas id="chart-category-trend"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>Subscription burn</h3>
          <span class="hint">marked where the move is ≥ ${pct(THRESHOLDS.subscriptionMoMPct)}</span>
        </div>
        <div class="chart-box tall"><canvas id="chart-sub-trend"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>This cycle vs 12-month baseline</h3>
          <span class="hint">top 8 categories</span>
        </div>
        <div class="chart-box"><canvas id="chart-category-baseline"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>Spend by account — ${esc(cycle)}</h3>
          <span class="hint">red = no statement ingested</span>
        </div>
        <div class="chart-box"><canvas id="chart-accounts"></canvas></div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------ transactions */

export function renderTransactions(el, state) {
  const { filter } = state;
  const rows = filteredTransactions(state);
  const categories = state.categories;

  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="txn-search" placeholder="Search merchant or description…" value="${esc(filter.q)}">
      <select id="txn-account">
        <option value="">All accounts</option>
        ${state.result.coverage.map((a) => `<option value="${esc(a.accountId)}" ${filter.account === a.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select>
      <select id="txn-category">
        <option value="">All categories</option>
        <option value="Unmapped" ${filter.category === 'Unmapped' ? 'selected' : ''}>Unmapped only</option>
        ${categories.map((c) => `<option value="${esc(c)}" ${filter.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <select id="txn-scope">
        <option value="cycle" ${filter.scope === 'cycle' ? 'selected' : ''}>This cycle</option>
        <option value="all" ${filter.scope === 'all' ? 'selected' : ''}>All history</option>
      </select>
      <span class="spacer"></span>
      <span class="hint">${rows.length.toLocaleString()} transaction${rows.length === 1 ? '' : 's'}</span>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Merchant</th><th>Category</th><th>Account</th>
            <th>Type</th><th class="num">Amount</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.slice(0, 500).map((t) => transactionRow(t, categories, state.reviewed, state.suggestions)).join('')
    : '<tr><td colspan="7"><div class="empty">No transactions match these filters.</div></td></tr>'}
        </tbody>
      </table>
    </div>
    ${rows.length > 500 ? `<p class="hint" style="margin-top:10px">Showing the first 500 of ${rows.length.toLocaleString()}. Narrow the filters to see the rest.</p>` : ''}`;
}

function transactionRow(t, categories, reviewed, suggestions) {
  const unmapped = t.unmapped;
  const isReviewed = reviewed?.has(t.fingerprint);
  const suggestion = unmapped ? suggestions?.get(t.fingerprint) : null;
  return `
    <tr class="${unmapped ? 'row-unmapped' : ''} ${isReviewed ? 'row-reviewed' : ''}">
      <td class="nowrap">${esc(t.date)}</td>
      <td class="desc">
        <div>${esc(t.merchant || t.description)}</div>
        ${t.merchant && t.merchant !== t.description ? `<span class="raw">${esc(t.description)}</span>` : ''}
      </td>
      <td>
        ${unmapped
    ? `<span class="badge badge-unmapped">Unmapped</span>
           ${suggestion ? `
             <div class="suggestion">
               <button class="btn btn-sm accept-suggestion"
                 data-key="${esc(t.merchantKey)}" data-display="${esc(t.merchant)}" data-category="${esc(suggestion.category)}">
                 Accept: ${esc(suggestion.category)}
               </button>
               <span class="why">${esc(suggestion.evidence)}</span>
               ${suggestion.caution ? `<span class="why caution">${esc(suggestion.caution)}</span>` : ''}
             </div>` : ''}
           <select class="btn-sm assign-category" data-key="${esc(t.merchantKey)}" data-display="${esc(t.merchant)}" style="margin-top:6px">
             <option value="">${suggestion ? 'Or choose another…' : 'Assign category…'}</option>
             ${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
           </select>`
    : `${esc(t.category)}${t.recurringType === 'subscription' ? ' <span class="badge badge-sub">sub</span>' : ''}`}
      </td>
      <td class="nowrap">${esc(t.accountName)}</td>
      <td class="nowrap spendtype">
        ${esc(t.spendType || '—')}
        ${spendSource(t)
    ? `<span class="why" title="${esc(spendSource(t).title)}">${esc(spendSource(t).label)}</span>` : ''}
        ${t.spendType ? `<button class="btn btn-sm flip-spendtype" data-fp="${esc(t.fingerprint)}"
             data-to="${t.spendType === 'Business' ? 'Personal' : 'Business'}"
             title="Record this charge as ${t.spendType === 'Business' ? 'Personal' : 'Business'} instead">
             → ${t.spendType === 'Business' ? 'Personal' : 'Business'}</button>` : ''}
        ${t.spendTypeSource === 'user' ? `<button class="btn btn-sm reset-spendtype" data-fp="${esc(t.fingerprint)}" title="Go back to the account default">reset</button>` : ''}
      </td>
      <td class="num nowrap" style="${t.flow === 'Income' ? 'color:#4ec44e' : ''}">
        ${t.flow === 'Income' ? '+' : ''}${money(t.amount, 2)}
      </td>
      <td class="nowrap">
        ${isReviewed ? '<span class="badge badge-info" title="Held out of baselines and month-over-month comparisons">Reviewed</span> ' : ''}
        <button class="btn btn-sm toggle-reviewed" data-fp="${esc(t.fingerprint)}"
          title="${isReviewed ? 'Put this charge back into the comparisons' : 'Confirm this is a legitimate one-off and keep it out of baselines'}">
          ${isReviewed ? 'Undo' : 'Mark reviewed'}
        </button>
      </td>
    </tr>`;
}

export function filteredTransactions(state) {
  const { transactions, cycle, filter } = state;
  const q = filter.q.trim().toLowerCase();
  return transactions
    .filter((t) => (filter.scope === 'cycle' ? monthOf(t.date) === cycle : true))
    .filter((t) => (filter.account ? t.accountId === filter.account : true))
    .filter((t) => {
      if (!filter.category) return true;
      if (filter.category === 'Unmapped') return t.unmapped;
      return t.category === filter.category;
    })
    .filter((t) => (q ? `${t.merchant} ${t.description}`.toLowerCase().includes(q) : true))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
}

/* ------------------------------------------------------------------ flags */

export function renderFlags(el, state) {
  const { result, acked, categories } = state;
  const flags = result.flags;
  const open = flags.filter((f) => !acked.has(f.id));
  const closed = flags.filter((f) => acked.has(f.id));

  if (!flags.length) {
    el.innerHTML = `<div class="empty">
      <strong>No flags for ${esc(state.cycle)}.</strong>
      <p class="hint" style="margin-top:6px">Every account reported, no category exceeded its baseline, and no unmapped merchants appeared.</p>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div class="banner">
      <div class="body">
        <strong>${open.length} open flag${open.length === 1 ? '' : 's'} for ${esc(state.cycle)}</strong>
        <p>Flags describe what changed — they never block or judge a purchase. Acknowledging one hides it for this
        session only; flags are recalculated from the data every cycle.</p>
      </div>
    </div>
    ${open.map((f) => flagCard(f, false, categories)).join('')}
    ${closed.length ? `<div class="section-title">Acknowledged (${closed.length})</div>` : ''}
    ${closed.map((f) => flagCard(f, true, categories)).join('')}`;
}

function flagCard(flag, isAcked, categories) {
  const n = flag.numbers || {};
  const numbers = [];
  if (n.previous != null && n.current != null) numbers.push(`${money(n.previous)} → ${money(n.current)}`);
  else if (n.current != null) numbers.push(money(n.current));
  if (n.baseline != null) numbers.push(`baseline ${money(n.baseline)}`);
  if (n.delta != null) numbers.push(`${n.delta > 0 ? '+' : ''}${pct(n.delta)}`);

  return `
    <div class="flag sev-${flag.severity} ${isAcked ? 'acked' : ''}">
      <div class="body">
        <div class="title">
          ${esc(flag.title)}
          <span class="badge badge-${flag.severity === 'warning' ? 'unmapped' : flag.severity}">${esc(SEVERITY_LABEL[flag.severity] || flag.severity)}</span>
          <span class="badge badge-neutral">${esc(TYPE_LABEL[flag.type] || flag.type)}</span>
        </div>
        <div class="detail">${esc(flag.detail)}</div>
        ${numbers.length ? `<div class="hint" style="margin-top:6px">${esc(numbers.join('  ·  '))}</div>` : ''}
        ${flag.caveat ? `<div class="caveat">⚠ ${esc(flag.caveat)}</div>` : ''}
        ${flag.items?.length ? `
          <ul class="flag-items">
            ${flag.items.map((i) => `<li>${esc(i.date)} · ${esc(i.accountName || '')} · ${money(i.amount, 2)} — ${esc(i.description.slice(0, 60))}</li>`).join('')}
          </ul>` : ''}
        ${flag.type === 'unmapped-merchant' ? `
          <div class="fix">
            ${flag.suggestion ? `
              <button class="btn btn-sm accept-suggestion"
                data-key="${esc(flag.merchantKey)}" data-display="${esc(flag.subject)}" data-category="${esc(flag.suggestion.category)}">
                Accept: ${esc(flag.suggestion.category)}
              </button>
              <span class="why">${esc(flag.suggestion.evidence)}</span>` : ''}
            <span class="hint">Map <code>${esc(flag.suggestedPattern)}</code> to:</span>
            <select class="btn-sm assign-category" data-key="${esc(flag.merchantKey)}" data-display="${esc(flag.subject)}">
              <option value="">Choose a category…</option>
              ${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            </select>
          </div>` : ''}
      </div>
      <div class="actions">
        <button class="btn btn-sm ack-flag" data-flag="${esc(flag.id)}">${isAcked ? 'Un-acknowledge' : 'Acknowledge'}</button>
      </div>
    </div>`;
}

/* --------------------------------------------------------- subscriptions */

export function renderSubscriptions(el, state) {
  const { subscriptions, bills, cellular } = state.result;

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Subscription burn — trailing 13 months</h3>
        <span class="hint">markers where the month-over-month move is ≥ ${pct(THRESHOLDS.subscriptionMoMPct)}</span>
      </div>
      <div class="chart-box"><canvas id="chart-sub-detail"></canvas></div>
    </div>

    <div class="section-title">Subscriptions (${subscriptions.subscriptions.length})</div>
    ${subTable(subscriptions.subscriptions, 'No subscription charges in this window.')}

    <div class="section-title">Recurring bills (${bills?.subscriptions.length || 0})</div>
    <p class="hint" style="margin:-6px 0 12px">
      Loans, utilities, insurance and taxes recur but are not subscriptions, so they are tracked separately and kept
      out of the subscription-burn number.
    </p>
    ${subTable(bills?.subscriptions || [], 'No recurring bills in this window.')}

    <div class="section-title">Cellular (${cellular?.subscriptions.length || 0})</div>
    <p class="hint" style="margin:-6px 0 12px">
      Cell phone bills are bigger and more variable than a typical app subscription, so they get their own burn
      total and their own move flag — tracked separately from both Subscriptions and Recurring bills.
    </p>
    ${subTable(cellular?.subscriptions || [], 'No cellular charges in this window.')}`;
}

function subTable(items, emptyMsg) {
  if (!items.length) return `<div class="empty">${esc(emptyMsg)}</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Item</th><th>Cadence</th>
            <th class="num">Prev month</th><th class="num">This month</th>
            <th class="num">Change</th><th class="num">Months active</th><th class="num">Window total</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((s) => {
    const delta = s.previous > 0 ? (s.current - s.previous) / s.previous : null;
    const flagged = delta != null && Math.abs(delta) >= THRESHOLDS.subscriptionMoMPct;
    return `
              <tr>
                <td>${esc(s.merchant)}</td>
                <td class="muted">${esc(s.cadence || '—')}</td>
                <td class="num">${s.previous ? money(s.previous, 2) : '—'}</td>
                <td class="num">${s.current ? money(s.current, 2) : '—'}</td>
                <td class="num">${delta == null ? '—'
      : `<span class="badge badge-${flagged ? (delta > 0 ? 'critical' : 'good') : 'neutral'}">${delta > 0 ? '+' : ''}${pct(delta)}</span>`}</td>
                <td class="num muted">${s.monthsActive}</td>
                <td class="num">${money(s.total)}</td>
              </tr>`;
  }).join('')}
        </tbody>
      </table>
    </div>`;
}

/* --------------------------------------------------------------- accounts */

/* --------------------------------------------------------------- reports */

function reportTimeFilter(rf) {
  if (rf.timeMode === 'monthly') return { mode: 'monthly', month: rf.month };
  if (rf.timeMode === 'yearly') return { mode: 'yearly', year: rf.year };
  return { mode: 'custom', start: rf.start, end: rf.end };
}

const rangeLabel = (range) => (range.start === range.end ? range.start : `${range.start} → ${range.end}`);

export function renderReports(el, state) {
  const rf = state.reportFilter;
  const years = [...new Set(state.cycles.map((c) => c.slice(0, 4)))].sort().reverse();

  let report;
  let error = null;
  try {
    report = buildReportWithComparison(state.transactions, {
      who: rf.who,
      category: rf.category,
      time: reportTimeFilter(rf),
      includeIncome: rf.includeIncome,
    });
  } catch (err) {
    error = err.message;
  }

  el.innerHTML = `
    <div class="toolbar">
      <select id="rpt-who">
        <option value="All" ${rf.who === 'All' ? 'selected' : ''}>Everyone</option>
        ${PERSONAS.map((p) => `<option value="${esc(p)}" ${rf.who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <select id="rpt-category">
        <option value="All" ${rf.category === 'All' ? 'selected' : ''}>All categories</option>
        ${state.categories.map((c) => `<option value="${esc(c)}" ${rf.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <select id="rpt-time-mode">
        <option value="monthly" ${rf.timeMode === 'monthly' ? 'selected' : ''}>Monthly</option>
        <option value="yearly" ${rf.timeMode === 'yearly' ? 'selected' : ''}>Yearly</option>
        <option value="custom" ${rf.timeMode === 'custom' ? 'selected' : ''}>Custom range</option>
      </select>
      ${rf.timeMode === 'monthly' ? `<input type="month" id="rpt-month" value="${esc(rf.month)}">` : ''}
      ${rf.timeMode === 'yearly' ? `
        <select id="rpt-year">
          ${years.length ? years.map((y) => `<option value="${y}" ${rf.year === y ? 'selected' : ''}>${y}</option>`).join('')
    : `<option value="${esc(rf.year)}" selected>${esc(rf.year)}</option>`}
        </select>` : ''}
      ${rf.timeMode === 'custom' ? `
        <input type="date" id="rpt-start" value="${esc(rf.start)}">
        <span class="hint">to</span>
        <input type="date" id="rpt-end" value="${esc(rf.end)}">` : ''}
      <label class="conflict-option" style="margin:0">
        <input type="checkbox" id="rpt-include-income" ${rf.includeIncome ? 'checked' : ''}>
        Include income
      </label>
    </div>

    ${error ? `<div class="empty">${esc(error)}</div>` : reportBody(report, rf)}`;
}

function reportBody(report, rf) {
  const { current, previous, delta, movers } = report;
  const deltaClass = delta == null ? '' : delta > 0 ? 'up' : 'down';
  const deltaText = delta == null ? 'no prior period to compare'
    : `${delta > 0 ? '▲' : '▼'} ${pct(Math.abs(delta))} vs ${rangeLabel(previous.range)} (${money(previous.total)})`;

  return `
    <div class="grid grid-stats" style="margin-top:16px">
      <div class="card stat">
        <span class="label">Spend — ${esc(rangeLabel(current.range))}</span>
        <span class="value">${money(current.total)}</span>
        <span class="meta ${deltaClass}">${deltaText}</span>
      </div>
      <div class="card stat">
        <span class="label">Transactions</span>
        <span class="value">${current.count}</span>
        <span class="meta">${esc(rf.who === 'All' ? 'everyone' : rf.who)} · ${esc(rf.category === 'All' ? 'all categories' : rf.category)}</span>
      </div>
      ${rf.includeIncome ? `
        <div class="card stat">
          <span class="label">Income</span>
          <span class="value">${money(current.incomeTotal)}</span>
          <span class="meta">shown separately — never combined with spend</span>
        </div>` : ''}
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <h3>Trend</h3>
          <span class="hint">${current.range.granularity === 'day' ? 'daily' : 'monthly'}</span>
        </div>
        <div class="chart-box"><canvas id="chart-report-trend"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Notable changes vs prior period</h3></div>
        ${movers.length ? `
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr><th>Category</th><th class="num">Previous</th><th class="num">Now</th><th class="num">Change</th></tr></thead>
              <tbody>
                ${movers.map((m) => `
                  <tr>
                    <td>${esc(m.category)}</td>
                    <td class="num muted">${money(m.previous)}</td>
                    <td class="num">${money(m.current)}</td>
                    <td class="num"><span class="badge badge-${m.delta > 0 ? 'critical' : 'good'}">${m.delta > 0 ? '+' : '−'}${money(m.delta)}</span></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="hint">Nothing moved by more than $5 between the two periods.</p>'}
      </div>
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      ${current.byPersona ? `
        <div class="card">
          <div class="card-head"><h3>By person</h3></div>
          ${breakdownTable(current.byPersona)}
        </div>` : ''}
      ${current.byCategory ? `
        <div class="card">
          <div class="card-head"><h3>By category</h3></div>
          ${breakdownTable(current.byCategory.slice(0, 12))}
        </div>` : ''}
    </div>`;
}

function breakdownTable(rows) {
  if (!rows.length) return '<p class="hint">No spend in this period.</p>';
  const total = rows.reduce((s, r) => s + r.total, 0) || 1;
  return `
    <div class="table-wrap" style="border:none">
      <table>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.key)}</td>
              <td class="num muted">${pct(r.total / total)}</td>
              <td class="num">${money(r.total)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

export function renderAccounts(el, state) {
  const { coverage } = state.result;
  const { statements, ingested } = state;
  const missing = coverage.filter((a) => a.txnCount === 0);

  el.innerHTML = `
    ${missing.length ? `
      <div class="banner error">
        <div class="body">
          <strong>${missing.length} of 7 accounts have no data for ${esc(state.cycle)}</strong>
          <p>${esc(missing.map((a) => a.name).join(', '))}. A missing statement is always reported — it is never
          treated as a month with no activity. Upload the statement to the Drive year folder and re-scan.</p>
        </div>
      </div>` : `
      <div class="banner">
        <div class="body">
          <strong>All 7 accounts reported for ${esc(state.cycle)}</strong>
          <p>Every tracked account contributed transactions to this cycle.</p>
        </div>
      </div>`}

    <div class="card" style="padding:0">
      ${coverage.map((a) => `
        <div class="account-row">
          <span class="dot ${a.txnCount ? 'ok' : 'missing'}"></span>
          <div>
            <div class="name">${esc(a.name)}</div>
            <div class="type">${esc(a.type)} · ${esc(a.person)}</div>
          </div>
          <span class="spacer"></span>
          <div style="text-align:right">
            <div>${a.txnCount ? money(a.spend) : '<span class="badge badge-critical">No statement</span>'}</div>
            <div class="type">${a.txnCount} transaction${a.txnCount === 1 ? '' : 's'}${a.income ? ` · ${money(a.income)} in` : ''}</div>
          </div>
        </div>`).join('')}
    </div>

    <div class="section-title">Statements found in Drive (${statements.length})</div>
    ${statements.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Statement date</th><th>Account</th><th>File</th><th>Ingested</th></tr></thead>
          <tbody>
            ${statements.slice().reverse().slice(0, 120).map((s) => `
              <tr>
                <td class="nowrap">${esc(s.statementDate || '—')}</td>
                <td class="nowrap">${esc(s.accountName)}</td>
                <td class="desc"><span class="raw" style="color:var(--ink-2)">${esc(s.fileName)}</span></td>
                <td>${ingested[s.fileId]
    ? `<span class="badge badge-good">${ingested[s.fileId].txnCount} txns</span>`
    : '<span class="badge badge-neutral">not ingested</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '<div class="empty">No statements scanned yet. Connect Drive and run a scan.</div>'}`;
}

/* --------------------------------------------------------------- merchants */

export function renderMerchants(el, state) {
  const { merchantRules, categories } = state;
  const q = (state.filter.ruleQ || '').trim().toLowerCase();
  const rules = merchantRules
    .filter((r) => (q ? `${r.pattern} ${r.display} ${r.category}`.toLowerCase().includes(q) : true))
    .sort((a, b) => a.display.localeCompare(b.display));

  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="rule-search" placeholder="Search the lookup table…" value="${esc(state.filter.ruleQ || '')}">
      <span class="spacer"></span>
      <span class="hint">${rules.length} of ${merchantRules.length} rules</span>
      <button class="btn btn-sm" id="export-lookup">Export CSV</button>
      <button class="btn btn-sm" id="export-overrides">Export your overrides (JSON)</button>
      <button class="btn btn-sm" id="import-overrides">Import overrides…</button>
    </div>
    <p class="hint" style="margin:-4px 0 14px">
      A merchant is matched by pattern against a normalised form of the statement description, so every billing
      variant of the same merchant collapses to one name. The longest matching pattern wins. Anything with no match
      is tagged Unmapped and flagged — never guessed into a category.
    </p>
    <p class="hint" style="margin:-4px 0 14px">
      Category assignments live only in this browser's local storage — they do not sync across devices and are lost
      if this browser's site data is cleared. <strong>Export your overrides</strong> after a categorisation session
      to back them up; <strong>Import</strong> merges a backup back in, asking before anything conflicting is changed.
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Display name</th><th>Pattern</th><th>Category</th><th>Recurring</th><th>Spend type</th><th>Source</th><th></th></tr>
        </thead>
        <tbody>
          ${rules.slice(0, 400).map((r) => `
            <tr>
              <td>${esc(r.display)}</td>
              <td><code class="muted">${esc(r.pattern)}</code></td>
              <td>
                <select class="btn-sm edit-rule-category" data-pattern="${esc(r.pattern)}">
                  ${categories.map((c) => `<option value="${esc(c)}" ${r.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                </select>
              </td>
              <td>${r.recurringType ? `<span class="badge badge-${r.recurringType === 'subscription' ? 'sub' : 'neutral'}">${esc(r.recurringType)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="muted">${esc(r.spendType || '—')}</td>
              <td class="muted">${esc(r.source || '—')}</td>
              <td><button class="btn btn-sm delete-rule" data-pattern="${esc(r.pattern)}">Remove</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function fmtRule(r) {
  const parts = [r.category || '(none)'];
  if (r.spendType) parts.push(r.spendType);
  if (r.recurringType) parts.push(r.recurringType);
  return parts.join(' · ');
}

/**
 * The conflict-resolution list for the import dialog. Every row defaults to
 * "Keep current" — importing never overwrites a local decision unless this
 * box is explicitly switched, and the switch is visible per row, not a global
 * silent default baked into the merge logic.
 */
export function renderImportConflicts(conflicts) {
  if (!conflicts.length) return '<p class="hint">No conflicts.</p>';
  return conflicts.map((c) => `
    <div class="conflict-row">
      <div class="conflict-head"><code>${esc(c.pattern)}</code></div>
      <label class="conflict-option">
        <input type="radio" name="resolve-${esc(c.pattern)}" value="keep" checked>
        Keep current — <span class="muted">${esc(fmtRule(c.existing))}</span>
      </label>
      <label class="conflict-option">
        <input type="radio" name="resolve-${esc(c.pattern)}" value="use-imported">
        Use imported — <span class="muted">${esc(fmtRule(c.incoming))}</span>
      </label>
    </div>`).join('');
}

export function setTabCounts(result, acked) {
  const open = result.flags.filter((f) => !acked.has(f.id)).length;
  const el = document.querySelector('#tab-flags .count');
  if (!el) return;
  el.textContent = String(open);
  el.classList.toggle('alert', open > 0);
}
