// Chart.js visualisations.
//
// Colour rules followed here:
//   - categorical hues are assigned in fixed order and never cycled; past 7
//     categories the remainder folds into a single "Other" series
//   - status colours (amber/red/green) are reserved for state and never reused
//     as a series colour
//   - text stays in ink tokens; a coloured mark beside a label carries identity

import { CHART_COLORS, STATUS } from './config.js';

const INK = {
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  surface: '#1a1a19',
};

const charts = new Map();

function mount(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el || !window.Chart) return null;
  charts.get(canvasId)?.destroy();
  const chart = new window.Chart(el.getContext('2d'), config);
  charts.set(canvasId, chart);
  return chart;
}

export function destroyAll() {
  charts.forEach((c) => c.destroy());
  charts.clear();
}

const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;
// Axis ticks: keep one decimal below $10k so neighbouring ticks don't both round
// to the same label ($1,500 and $2,400 must not both read "$2k").
const axisMoney = (v) => {
  if (Math.abs(v) >= 10000) return `$${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `$${v}`;
};
const shortMonth = (m) => {
  const [y, mm] = m.split('-');
  return `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm)]} ${y.slice(2)}`;
};

const baseScales = (stacked = false) => ({
  x: {
    stacked,
    grid: { display: false, drawBorder: false },
    border: { color: INK.axis },
    ticks: { color: INK.muted, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 },
  },
  y: {
    stacked,
    beginAtZero: true,
    grid: { color: INK.grid, drawBorder: false, drawTicks: false },
    border: { display: false },
    ticks: {
      color: INK.muted,
      font: { size: 11 },
      padding: 8,
      callback: axisMoney,
    },
  },
});

const tooltip = (extra = {}) => ({
  backgroundColor: '#000000',
  borderColor: 'rgba(255,255,255,0.14)',
  borderWidth: 1,
  titleColor: INK.primary,
  bodyColor: INK.secondary,
  padding: 10,
  cornerRadius: 6,
  displayColors: true,
  boxWidth: 8,
  boxHeight: 8,
  usePointStyle: true,
  ...extra,
});

const legend = {
  display: true,
  position: 'bottom',
  align: 'start',
  labels: {
    color: INK.secondary,
    boxWidth: 8,
    boxHeight: 8,
    usePointStyle: true,
    pointStyle: 'circle',
    padding: 14,
    font: { size: 11 },
  },
};

/**
 * Category spend across the trailing window, stacked by category, with the
 * current month called out if any category breached its baseline.
 */
export function categoryTrendChart(canvasId, trend, breachedMonths = new Set()) {
  const datasets = trend.series.map((s, i) => ({
    label: s.folded ? `Other (${s.folded})` : s.category,
    data: s.values,
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
    borderColor: INK.surface,
    // A 2px surface gap between stacked segments keeps adjacent hues readable.
    borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
    borderRadius: i === trend.series.length - 1 ? { topLeft: 4, topRight: 4 } : 0,
  }));

  return mount(canvasId, {
    type: 'bar',
    data: { labels: trend.window.map(shortMonth), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: baseScales(true),
      plugins: {
        legend,
        tooltip: tooltip({
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${money(ctx.parsed.y)}`,
            footer: (items) => {
              const total = items.reduce((s, i) => s + i.parsed.y, 0);
              const month = trend.window[items[0].dataIndex];
              const breach = breachedMonths.has(month) ? '  ⚠ over baseline' : '';
              return `Total: ${money(total)}${breach}`;
            },
          },
        }),
      },
    },
  });
}

/**
 * Total monthly subscription burn, with a marker on any month that moved by at
 * least the flag threshold against the month before it.
 */
export function subscriptionTrendChart(canvasId, series, thresholdPct = 0.10) {
  const values = series.map((p) => p.value);
  const jumps = values.map((v, i) => {
    if (i === 0 || !values[i - 1]) return false;
    return Math.abs((v - values[i - 1]) / values[i - 1]) >= thresholdPct;
  });

  return mount(canvasId, {
    type: 'line',
    data: {
      labels: series.map((p) => shortMonth(p.month)),
      datasets: [{
        label: 'Subscription burn',
        data: values,
        borderColor: CHART_COLORS[0],
        backgroundColor: 'rgba(57,135,229,0.12)',
        borderWidth: 2,
        fill: true,
        tension: 0.25,
        pointRadius: (ctx) => (jumps[ctx.dataIndex] ? 6 : 3),
        pointHoverRadius: 8,
        // Status colour marks the months that tripped the rule; the tooltip and
        // the Flags tab carry the label, so colour is never the only signal.
        pointBackgroundColor: (ctx) => (jumps[ctx.dataIndex] ? STATUS.warning : CHART_COLORS[0]),
        pointBorderColor: INK.surface,
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: baseScales(),
      plugins: {
        legend: { display: false },
        tooltip: tooltip({
          callbacks: {
            label: (ctx) => {
              const i = ctx.dataIndex;
              const prev = values[i - 1];
              const base = `Subscriptions: ${money(ctx.parsed.y)}`;
              if (i === 0 || !prev) return base;
              const delta = ((ctx.parsed.y - prev) / prev) * 100;
              const mark = jumps[i] ? '  ⚠ flagged' : '';
              return `${base}  (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% MoM)${mark}`;
            },
          },
        }),
      },
    },
  });
}

/**
 * Spend by account for the cycle. Accounts with no data are drawn as an empty
 * slot in the status colour so a missing statement is visible at a glance.
 */
export function accountChart(canvasId, coverage) {
  const labels = coverage.map((a) => a.name);
  const data = coverage.map((a) => a.spend);
  const colors = coverage.map((a) => (a.txnCount === 0 ? STATUS.critical : CHART_COLORS[0]));

  // An account with no statement has nothing to draw, and an invisible zero-bar is
  // exactly the silence this dashboard exists to prevent. Label those rows in the
  // plot area instead of inflating the bar to a value the account does not have.
  const missingLabels = {
    id: 'missingAccountLabels',
    afterDatasetsDraw(chart) {
      const { ctx, scales } = chart;
      ctx.save();
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = STATUS.critical;
      ctx.textBaseline = 'middle';
      coverage.forEach((a, i) => {
        if (a.txnCount > 0) return;
        const y = scales.y.getPixelForTick(i);
        ctx.fillText('⚠ No statement ingested', scales.x.getPixelForValue(0) + 8, y);
      });
      ctx.restore();
    },
  };

  return mount(canvasId, {
    plugins: [missingLabels],
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Spend this cycle',
        data,
        backgroundColor: colors,
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: false,
        barThickness: 'flex',
        maxBarThickness: 34,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: INK.grid, drawBorder: false, drawTicks: false },
          border: { display: false },
          ticks: { color: INK.muted, font: { size: 11 }, callback: axisMoney },
        },
        y: {
          grid: { display: false, drawBorder: false },
          border: { color: INK.axis },
          ticks: { color: INK.secondary, font: { size: 11 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: tooltip({
          callbacks: {
            label: (ctx) => {
              const a = coverage[ctx.dataIndex];
              if (a.txnCount === 0) return 'No statement ingested for this cycle';
              return `${money(a.spend)} across ${a.txnCount} transaction${a.txnCount === 1 ? '' : 's'}`;
            },
          },
        }),
      },
    },
  });
}

/** Current-cycle category totals against their trailing-12-month baselines. */
export function categoryVsBaselineChart(canvasId, breakdown) {
  const top = breakdown.slice(0, 8);
  return mount(canvasId, {
    type: 'bar',
    data: {
      labels: top.map((b) => b.category),
      datasets: [
        {
          label: 'This cycle',
          data: top.map((b) => b.total),
          // Over-baseline bars take the status colour; the legend plus the
          // baseline series keep the meaning legible without relying on hue.
          backgroundColor: top.map((b) => (b.overBaseline ? STATUS.critical : CHART_COLORS[0])),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: false,
        },
        {
          label: '12-month baseline',
          data: top.map((b) => b.baseline),
          backgroundColor: 'rgba(195,194,183,0.22)',
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: (() => {
        const s = baseScales();
        // Category names are long; let them tilt rather than silently drop out.
        s.x.ticks = { ...s.x.ticks, maxRotation: 40, minRotation: 40, autoSkip: false, font: { size: 10 } };
        return s;
      })(),
      plugins: {
        legend,
        tooltip: tooltip({
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${money(ctx.parsed.y)}`,
            footer: (items) => {
              const b = top[items[0].dataIndex];
              if (!b.baseline) return '';
              const delta = ((b.total - b.baseline) / b.baseline) * 100;
              return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% vs baseline`;
            },
          },
        }),
      },
    },
  });
}

/**
 * The Reports tab / email trend: spend over the selected range, one bar per
 * day or month depending on the range's granularity (see reports.js). Income
 * is drawn as its own line only when the report included it — it is never
 * stacked into the spend bar, since the two are never meant to be added
 * together.
 */
export function reportTrendChart(canvasId, trend, granularity) {
  const labels = trend.map((p) => (granularity === 'day'
    ? p.label.slice(5).replace(/^0/, '').replace('-', '/')
    : shortMonth(p.label)));
  const hasIncome = trend.some((p) => p.income > 0);

  const datasets = [{
    type: 'bar',
    label: 'Spend',
    data: trend.map((p) => p.spend),
    backgroundColor: CHART_COLORS[0],
    borderRadius: { topLeft: 3, topRight: 3 },
    borderSkipped: false,
    order: 2,
  }];
  if (hasIncome) {
    datasets.push({
      type: 'line',
      label: 'Income',
      data: trend.map((p) => p.income),
      borderColor: STATUS.good,
      backgroundColor: STATUS.good,
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.2,
      order: 1,
    });
  }

  return mount(canvasId, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: (() => {
        const s = baseScales();
        if (trend.length > 20) s.x.ticks = { ...s.x.ticks, maxRotation: 0, autoSkipPadding: 16 };
        return s;
      })(),
      plugins: {
        legend: hasIncome ? legend : { display: false },
        tooltip: tooltip({
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${money(ctx.parsed.y)}` },
        }),
      },
    },
  });
}
