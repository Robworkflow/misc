// Statement + workbook parsing.
//
// Two PDF layouts are supported, both RBC:
//
//   rbc-visa  Two-column page. The transaction table is on the left; an
//             "IMPORTANT INFORMATION" sidebar on the right must be excluded or its
//             dollar figures (credit limit, minimum payment) get read as charges.
//             Rows look like:  MAR 28  MAR 30  TELUS MOBILITY PREAUTH …  $644.08
//             followed by a long reference number on its own line.
//
//   rbc-bank  Single table, but withdrawal vs deposit is encoded by the *column*
//             a number sits in, not by sign. Column positions are read off the
//             header row ("Withdrawals ($)  Deposits ($)  Balance ($)") and each
//             number is assigned to the nearest column by right edge, because the
//             figures are right-aligned. Descriptions wrap and the date is only
//             printed on the first row of a given day.

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Reconstruct text lines from pdf.js text items, keeping x positions. */
async function pageLines(page) {
  const content = await page.getTextContent();
  const rows = new Map();
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    let key = null;
    for (const k of rows.keys()) {
      if (Math.abs(k - y) <= 2) { key = k; break; }
    }
    if (key === null) { key = y; rows.set(key, []); }
    rows.get(key).push({
      x: item.transform[4],
      right: item.transform[4] + (item.width || 0),
      str: item.str,
    });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, items]) => {
      items.sort((a, b) => a.x - b.x);
      return { y, items, text: items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim() };
    });
}

function toNumber(s) {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Resolve a MMM/DD pair against the statement period, handling year rollover. */
function resolveDate(month, day, period) {
  if (!period?.end) return null;
  const endYear = period.end.year;
  const endMonth = period.end.month;
  // A statement running Dec 20 -> Jan 20 shows December rows that belong to the
  // previous calendar year.
  const year = month > endMonth ? endYear - 1 : endYear;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parsePeriod(text) {
  // Visa: "STATEMENT FROM MAR 28 TO APR 27, 2026"
  let m = text.match(/STATEMENT FROM ([A-Z]{3})\s+(\d{1,2})\s+TO\s+([A-Z]{3})\s+(\d{1,2}),?\s*(\d{4})/i);
  if (m) {
    const endYear = Number(m[5]);
    const startMonth = MONTHS[m[1].toUpperCase()];
    const endMonth = MONTHS[m[3].toUpperCase()];
    return {
      start: { month: startMonth, day: Number(m[2]), year: startMonth > endMonth ? endYear - 1 : endYear },
      end: { month: endMonth, day: Number(m[4]), year: endYear },
    };
  }
  // Bank: "From June 15, 2026 to July 15, 2026" (personal) and
  //       "January 30, 2026 to February 27, 2026" (business — no "From" prefix).
  m = text.match(/(?:From\s+)?\b([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\s+to\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i);
  if (m && MONTHS[m[1].slice(0, 3).toUpperCase()] && MONTHS[m[4].slice(0, 3).toUpperCase()]) {
    return {
      start: { month: MONTHS[m[1].slice(0, 3).toUpperCase()], day: Number(m[2]), year: Number(m[3]) },
      end: { month: MONTHS[m[4].slice(0, 3).toUpperCase()], day: Number(m[5]), year: Number(m[6]) },
    };
  }
  return null;
}

/** Statement cycle label, e.g. "2026-07". */
export function cycleOf(period, fallbackDate) {
  if (period?.end) return `${period.end.year}-${String(period.end.month).padStart(2, '0')}`;
  return fallbackDate ? fallbackDate.slice(0, 7) : null;
}

/* ------------------------------------------------------------- RBC Visa */

const VISA_ROW = /^([A-Z]{3})\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{1,2})\s+(.+?)\s+(-?\$[\d,]+\.\d{2})$/;
const CARDHOLDER = /^([A-Z][A-Z .'-]+?)\s+\d{4}\s+\d{2}\*{2}\s+\*{4}\s+(\d{4})/;

function parseVisa(pages) {
  const txns = [];
  let period = null;
  let cardholder = null;
  let cardLast4 = null;

  for (const lines of pages) {
    // The sidebar begins well to the right of the transaction table. Find the
    // amount column from the table header and treat anything past it as chrome.
    let boundary = Infinity;
    for (const line of lines) {
      const amt = line.items.find((i) => /AMOUNT/i.test(i.str));
      if (amt && line.items.some((i) => /ACTIVITY|DESCRIPTION/i.test(i.str))) {
        boundary = amt.right + 20;
        break;
      }
    }

    for (const line of lines) {
      const left = line.items.filter((i) => i.x < boundary);
      if (!left.length) continue;
      const text = left.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();

      if (!period) period = parsePeriod(text);

      const holder = text.match(CARDHOLDER);
      if (holder) {
        cardholder = holder[1].trim();
        cardLast4 = holder[2];
        continue;
      }

      const m = text.match(VISA_ROW);
      if (!m) continue;

      const month = MONTHS[m[1].toUpperCase()];
      if (!month) continue;
      const amount = toNumber(m[6]);
      if (amount === null) continue;

      const description = m[5].replace(/\s+\d{15,}\s*$/, '').trim();
      if (!description) continue;

      txns.push({
        date: resolveDate(month, Number(m[2]), period),
        postedDate: resolveDate(MONTHS[m[3].toUpperCase()], Number(m[4]), period),
        description,
        // Visa amounts are positive for purchases, negative for payments/credits.
        amount: Math.abs(amount),
        flow: amount < 0 ? 'Income' : 'Expense',
        cardholder,
        cardLast4,
      });
    }
  }
  return { txns, period };
}

/* ------------------------------------------------------------ RBC bank */

const BANK_DATE = /^(\d{1,2})\s+([A-Za-z]{3})\b/;

// Page furniture that repeats on continuation pages. Without this, a header line
// carrying no numbers gets mistaken for a wrapped description and glued onto the
// next transaction.
const BANK_CHROME = [
  /^(?:From\s+)?[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\s+to\s+[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}/i,
  /Royal Bank of Canada/i,
  /^Details of your account/i,
  /^Summary of your account/i,
  /Your (account number|opening balance|closing balance|RBC personal)/i,
  /^Total (deposits|withdrawals|cheques|credits|debits)/i,
  // Business Account Statement furniture.
  /^Account (Activity|Summary|number|Fees)/i,
  /^Business Account Statement/i,
  /^Business Current Account/i,
  /^Private Banking/i,
  /^(Opening|Closing) balance/i,
  /^Please contact your RBC/i,
  /^RB[A-Z]+\d/i,
  /How to reach us/i,
  /rbcroyalbank|www\.rbc/i,
  /^Page \d+/i,
  /^\d+\s+of\s+\d+$/i,
  /\(continued\)/i,
  /^RBPDA/i,
  /^[A-Z]{2}\d{5,}/,
  /^\*?\d[A-Z0-9]{6,}\*?$/,
  /account statement$/i,
];

const isBankChrome = (text) => BANK_CHROME.some((re) => re.test(text));

// Column headers differ between RBC's personal and business statements:
//   personal: "Withdrawals ($)   Deposits ($)          Balance ($)"
//   business: "Cheques & Debits ($)  Deposits & Credits ($)  Balance ($)"
// The geometry is identical in both — figures are right-aligned under their
// header — so only the labels need to be recognised. These require the "($)"
// suffix so ordinary description text can never be mistaken for a header.
const DEBIT_COL = /(?:withdrawals?|cheques?\s*&\s*debits?|debits?)\s*\(\$\)/i;
const CREDIT_COL = /(?:deposits?\s*&\s*credits?|deposits?|credits?)\s*\(\$\)/i;
const BALANCE_COL = /balance\s*\(\$\)/i;

function parseBank(pages) {
  const txns = [];
  let period = null;
  let columns = null;   // { withdrawal, deposit, balance } right edges
  let currentDate = null;
  let pending = null;   // description accumulated across wrapped lines

  const flush = () => {
    if (pending && pending.amount !== null) txns.push(pending);
    pending = null;
  };

  for (const lines of pages) {
    flush();  // a wrapped description never continues across a page break
    for (const line of lines) {
      const { text, items } = line;
      if (!period) period = parsePeriod(text);
      if (isBankChrome(text)) { flush(); continue; }

      // Learn the numeric column positions from the table header. The header
      // repeats on every continuation page, so this re-learns per page — the
      // business statement shifts its whole table left on page 2.
      if (DEBIT_COL.test(text) && CREDIT_COL.test(text)) {
        const find = (re) => {
          const it = items.find((i) => re.test(i.str));
          return it ? it.right : null;
        };
        columns = {
          withdrawal: find(DEBIT_COL),
          deposit: find(CREDIT_COL),
          balance: find(BALANCE_COL),
        };
        // Anything accumulated above the header is page furniture, not the
        // start of the first transaction's description.
        pending = null;
        continue;
      }
      if (!columns || !columns.withdrawal || !columns.deposit) continue;

      const dateMatch = text.match(BANK_DATE);
      const numbers = items
        .map((i) => ({ value: toNumber(i.str), right: i.right, raw: i.str }))
        .filter((i) => i.value !== null && /^[\d,]+\.\d{2}$/.test(i.raw.trim()));

      // Words that are not the date and not a number make up the description.
      // Some business-statement rows print the date twice (posted and effective,
      // e.g. "03 Feb 03 Feb Interest AVE CAP-105"), so strip every leading date
      // rather than just the first.
      let words = items
        .filter((i) => !/^[\d,]+\.\d{2}$/.test(i.str.trim()))
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      for (let guard = 0; guard < 4 && BANK_DATE.test(words); guard += 1) {
        words = words.replace(BANK_DATE, '').trim();
      }

      if (dateMatch) {
        const month = MONTHS[dateMatch[2].slice(0, 3).toUpperCase()];
        if (month) currentDate = resolveDate(month, Number(dateMatch[1]), period);
      }

      if (!numbers.length && words) {
        // Wrapped description line — start or extend the pending row.
        flush();
        pending = { date: currentDate, description: words, amount: null, flow: 'Expense' };
        continue;
      }
      if (!numbers.length) continue;

      // Assign each number to the column whose right edge it lines up with.
      const assign = (n) => {
        const dW = Math.abs(n.right - columns.withdrawal);
        const dD = Math.abs(n.right - columns.deposit);
        const dB = columns.balance === null ? Infinity : Math.abs(n.right - columns.balance);
        const min = Math.min(dW, dD, dB);
        if (min === dB) return 'balance';
        return min === dW ? 'withdrawal' : 'deposit';
      };

      const withdrawal = numbers.find((n) => assign(n) === 'withdrawal');
      const deposit = numbers.find((n) => assign(n) === 'deposit');
      const value = withdrawal || deposit;
      if (!value) { flush(); continue; }

      const description = [pending?.description, words].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      pending = null;

      if (!description) continue;
      txns.push({
        date: currentDate,
        description,
        amount: Math.abs(value.value),
        flow: withdrawal ? 'Expense' : 'Income',
      });
    }
  }
  flush();
  return { txns, period };
}

/* --------------------------------------------------------------- public */

/**
 * Parse one statement PDF into transactions.
 * @param {ArrayBuffer} buffer  the PDF bytes
 * @param {object} account      the account definition (picks the layout)
 */
export async function parseStatement(buffer, account, pdfjsLib) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    pages.push(await pageLines(await doc.getPage(i)));
  }

  const { txns, period } = account.statementFormat === 'rbc-bank'
    ? parseBank(pages)
    : parseVisa(pages);

  const clean = txns.filter((t) => t.date && t.description && t.amount > 0);
  return {
    transactions: clean.map((t) => ({
      ...t,
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      cardHolder: t.cardholder || account.holder,
      person: account.person,
      spendType: account.defaultSpendType,
      source: 'statement',
    })),
    period,
    cycle: cycleOf(period, clean[0]?.date),
    pageCount: doc.numPages,
    skipped: txns.length - clean.length,
  };
}

/* ------------------------------------------------------ master workbook */

/**
 * Read the Transactions sheet of the master workbook. This is the historical
 * baseline; the app never writes back to it.
 */
export function parseMasterWorkbook(buffer, XLSX) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheet = wb.Sheets.Transactions || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('No Transactions sheet found in the workbook.');

  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  // Row 0 is a banner; find the real header row.
  const headerRow = grid.findIndex((r) => Array.isArray(r) && r.some((c) => String(c).trim() === 'Date'));
  if (headerRow < 0) throw new Error('Could not find the header row in the Transactions sheet.');

  const headers = grid[headerRow].map((h) => String(h || '').trim());
  const col = (name) => headers.indexOf(name);
  const iDate = col('Date');
  const iDesc = col('Description');
  const iAmount = col('Amount');
  const iFlow = col('Flow Type');
  const iCategory = col('Category') >= 0 ? col('Category') : col('Mapped Category');
  const iAccount = col('Account');
  const iType = col('Account Type');
  const iHolder = col('Card Holder');
  const iPerson = col('Person');
  const iSpend = col('Spend Type');

  const out = [];
  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const row = grid[r];
    if (!row || row[iDate] == null || row[iDesc] == null) continue;

    const date = normalizeDate(row[iDate]);
    if (!date) continue;

    let amount = row[iAmount];
    if (typeof amount === 'string') amount = Number(amount.replace(/[$,]/g, ''));
    amount = Number(amount);
    if (!Number.isFinite(amount)) continue;

    out.push({
      date,
      description: String(row[iDesc]),
      amount: Math.abs(amount),
      flow: String(row[iFlow] || 'Expense'),
      workbookCategory: iCategory >= 0 ? String(row[iCategory] || '') : '',
      accountName: iAccount >= 0 ? String(row[iAccount] || '') : '',
      accountType: iType >= 0 ? String(row[iType] || '') : '',
      cardHolder: iHolder >= 0 ? String(row[iHolder] || '') : '',
      person: iPerson >= 0 ? String(row[iPerson] || '') : '',
      spendType: iSpend >= 0 ? String(row[iSpend] || '') : '',
      source: 'workbook',
    });
  }
  return out;
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.valueOf())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}
