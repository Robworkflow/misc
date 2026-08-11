// Static configuration: Drive locations, the 7 tracked accounts, guardrail thresholds.
// Everything here is overridable from the Settings panel and persisted to localStorage.

export const DRIVE = {
  // Parent finance folder in Google Drive.
  parentFolderId: '1XNMFCcOa5YDVjrTvamRUdTJ-aElIOjOX',
  // Master transaction workbook — the system of record. Read-only to this app.
  masterFileId: '1XiPaWdrurLLehDHiy3FN0s4VvoWBeZZT',
  masterFileName: 'Personal CFO 2025 - UPDATED (May-Jul 2026).xlsx',
  // Year subfolders holding the statement PDFs (each contains per-account subfolders).
  yearFolders: {
    2025: '1gdRWStPZrRUcsiD7WwjCzv7hpU3_sXKm',
    2026: '1nqIllG0t-TtFGaKRgSQx1px1JlDPogHV',
  },
  scope: 'https://www.googleapis.com/auth/drive.readonly',
  // Default OAuth client for the browser flow. A client ID is not a secret — it is
  // sent in the clear on every OAuth request — but it only works from an origin
  // registered on the client, which for this one is http://localhost:8000.
  // Serve the app on port 8000 or sign-in will fail with origin_mismatch.
  // Settings overrides this value if you need a different client.
  oauthClientId: '329588979883-o191q61plf1ua6u9navkk0c61cg49rss.apps.googleusercontent.com',
};

// The 7 tracked accounts. `match` drives discovery of the per-account statement
// subfolders inside each year folder — folder naming is not consistent between
// 2025 and 2026 ("Rob Bank Statement (7434) 2025" vs "Rob Bank Statement 2026",
// and the 2026 files themselves are named "Dad Statement-7434 …"), so we match on
// the card/account last-4 first and fall back to name keywords.
export const ACCOUNTS = [
  {
    id: 'rob-bank',
    name: 'Rob Bank',
    type: 'Personal Bank',
    holder: 'Roberto Luongo',
    person: 'Rob',
    defaultSpendType: 'Personal',
    statementFormat: 'rbc-bank',
    last4: '7434',
    match: ['rob bank', 'dad statement'],
    folders: { 2025: '1z4bVx25_Ejw1-JAxOkwzBWRgDw4L28Xd', 2026: '1usr2vKBz-Qj8Kzl39k1-dkkQyjpyOppL' },
  },
  {
    id: 'rob-visa-personal',
    name: 'Rob Visa Personal',
    type: 'Personal CC',
    holder: 'Roberto Luongo',
    person: 'Rob',
    defaultSpendType: 'Personal',
    statementFormat: 'rbc-visa',
    last4: '0456',
    match: ['rob visa personal', 'rob personal visa'],
    folders: { 2025: '1S4nVOMbcoZDpveZu0ujNr4En15LCVTfK', 2026: '1zwipWfBndMnuSwWtJntCxhAUVwMvSYnz' },
  },
  {
    id: 'mel-bank',
    name: 'Mel Bank',
    type: 'Personal Bank',
    holder: 'Melanie Scott-Luongo',
    person: 'Mel',
    defaultSpendType: 'Personal',
    statementFormat: 'rbc-bank',
    last4: '5599',
    match: ['mel bank'],
    folders: { 2025: '1_ZTDxTd3XD6_zZGt4OvwxaPWGfGEQsOp', 2026: '16wvkWt66DbXJXTAXtBOyOREW5AN8E76e' },
  },
  {
    id: 'mel-visa-personal',
    name: 'Melanie Personal Visa',
    type: 'Personal CC',
    holder: 'Melanie Scott-Luongo',
    person: 'Mel',
    defaultSpendType: 'Personal',
    statementFormat: 'rbc-visa',
    last4: null,
    match: ['mel personal visa', 'melanie personal visa'],
    folders: { 2025: '1B5_db5iRzuudZncULSWb4T9eWT7Ze3mx', 2026: '1dJ1k5kdTb1GD69NeHZtT3f3WBi0HHrLN' },
  },
  {
    id: 'daniko-bank',
    name: 'Daniko Bank',
    type: 'Business Bank',
    holder: 'Daniko Management',
    person: 'Rob',
    defaultSpendType: 'Business',
    statementFormat: 'rbc-bank',
    last4: '6673',
    match: ['daniko bank'],
    folders: { 2025: '17zq5MlpDL7UDhbClKVVDEzEIHIETrBsW', 2026: '1zfNfPnRVd7U_mld2ikwRtX5WrAehCGMG' },
  },
  {
    id: 'daniko-rob-visa',
    name: 'Daniko Rob Visa',
    type: 'Business CC',
    holder: 'Roberto Luongo',
    person: 'Rob',
    // Daniko cards deliberately carry both business and personal charges; the
    // Category/Spend Type column separates them, not the account.
    defaultSpendType: 'Business',
    statementFormat: 'rbc-visa',
    last4: '9166',
    match: ['daniko rob', 'rob daniko'],
    folders: { 2025: '1gONd38Vg9fOKGR63lodbQVJKa4tqivyD', 2026: '1IgTDdxLSFREN_eIsn7XaN_gcVpakj2la' },
  },
  {
    id: 'daniko-mel-visa',
    name: 'Daniko Mel Visa',
    type: 'Business CC',
    holder: 'Melanie Scott-Luongo',
    person: 'Mel',
    defaultSpendType: 'Business',
    statementFormat: 'rbc-visa',
    last4: '7578',
    match: ['daniko mel', 'mel daniko'],
    folders: { 2025: '1NdpMo7vp7LZK2jxJ91g_XPSR5h_b9PTY', 2026: '1bX21sT-8eGsRF-FSetml9kPN65hWEdEm' },
  },
];

export const THRESHOLDS = {
  // Flag a subscription whose monthly total moves by at least this much MoM.
  subscriptionMoMPct: 0.10,
  // Flag a category whose month total exceeds its trailing-12-month baseline.
  categoryOverBaselinePct: 0.0,
  // Trailing window used for every baseline.
  baselineMonths: 12,
  // Ignore trivial moves so the Flags tab stays worth reading.
  minFlagAmount: 5,
};

// Categories that are transfers//payments rather than real spend. Excluded from
// baselines and category-overspend flags so a credit-card payment doesn't read as
// a spending blowout.
export const NON_SPEND_CATEGORIES = ['Transfers', 'Income'];

export const UNMAPPED = 'Unmapped';

export const CHART_COLORS = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#008300', '#9085e9', '#e66767',
];

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};
