# Personal CFO — Guardrail Dashboard

A local, single-user dashboard that watches household and Daniko Management Ltd.
spending across 7 accounts and surfaces what changed each month.

**It flags; it never blocks.** There is no budget, no spending limit, and no
blocking logic anywhere in the codebase. Every rule produces a description of
what moved, for a human to decide on.

---

## Running it

The app is plain ES modules with no build step, but it does need to be served
over HTTP rather than opened as a `file://` URL — Google OAuth requires a real
origin, and ES modules require one too.

```bash
cd personal-cfo
./serve.sh            # or: python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Chart.js, SheetJS and pdf.js are vendored in `vendor/`, so the dashboard renders
and parses statements with no third-party requests at all. The only remote script
is Google Identity Services, and it is loaded solely to connect Drive.

### Connecting Google Drive

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth client ID of type **Web application**.
2. Add `http://localhost:8000` as an **Authorised JavaScript origin**.
3. Enable the **Google Drive API** for the project.
4. Paste the client ID into **Settings** in the app.

The app requests `drive.readonly` only. It can read the statement folders and the
master workbook; it cannot modify anything in your Drive.

---

## What it does each cycle

1. **Scan** — walks the Drive year folders (`2025`, `2026`), finds the per-account
   statement subfolders, and lists every statement PDF. Anything not already in
   the local ingest registry is reported as new.
2. **Ingest** — parses the new PDFs, extracting date, description, amount and
   account. Rows already present in the master workbook are de-duplicated by
   date + amount + normalised description + account.
3. **Categorise** — every transaction is resolved through the merchant lookup
   table. No match means `Unmapped` and a flag; a merchant is never guessed into
   a category.
4. **Evaluate** — the guardrail rules run and produce the Flags list.
5. **Hand off** — generate an update package (a new `.xlsx` plus a changelog) and
   a plain-language email draft for Melanie.

The master workbook in Drive is the system of record and is **only ever read**.
Update packages download to your machine for you to review and re-upload
yourself, per the PRD's decision that direct write-back is not reliable.

---

## The guardrail rules

| Rule | Trigger |
|---|---|
| Subscription movement | A subscription's monthly total moves ≥ 10% month over month |
| Category over baseline | A category's cycle total exceeds its trailing-12-month baseline |
| Unmapped merchant | A charge from a merchant with no lookup-table entry |
| Missing statement | Any of the 7 accounts has no data for the cycle |
| New / stopped subscription | A subscription bills for the first time, or stops billing |
| Recurring bill change | A recurring bill moves ≥ 10% month over month |
| Reviewed items held out | Informational: lists any verified one-time charges excluded from this cycle's comparisons |

Thresholds live in `js/config.js` (`THRESHOLDS`).

Two deliberate design decisions are worth knowing about:

**Subscriptions and recurring bills are counted separately.** A car loan, condo
fees, property-tax instalments and insurance premiums all recur, but they are not
subscriptions. Leaving them in the subscription number meant a $2,900/mo loan
payment drowned out every change the 10% rule exists to catch — the burn figure
read ~$24,000/mo instead of the real ~$2,500/mo. Both are tracked; only true
subscriptions feed the subscription guardrail. The split is the `BILLS` set in
`tools/build_seed.py`.

**Baselines exclude transfers.** Moving six figures between the household's own
accounts is not spending. `NON_SPEND_CATEGORIES` in `js/config.js` keeps
`Transfers` and `Income` out of every baseline and category flag.

**Verified one-time items can be held out of comparisons.** A legitimate one-off
— a loan repayment, a holiday, a boat — will breach its category baseline, and
worse, it becomes the yardstick every future month is measured against. Marking a
charge **Reviewed** (the button on any row in the Transactions tab) keeps that
single charge out of the baselines and the month-over-month maths.

It is scoped to one transaction, identified by date + exact amount + normalised
description + account. It is not a rule, not a merchant, and not a threshold, so
a different large charge later is still evaluated normally. Reviewed charges stay
in the ledger, in every total, and in the exported workbook — only the
comparisons skip them, and each cycle raises an informational flag listing
exactly what was held out, so nothing is ever silently absorbed. The state
persists in `localStorage` and is reversible from the same button.

**Comparisons state when they are unreliable.** If an account reported last month
but not this month, any month-over-month number is skewed. The flag still fires,
carrying an explicit caveat rather than quietly presenting a percentage that is
not comparable.

---

## The merchant lookup table

The consolidation problem is real: in the existing history, Microsoft bills under
17 distinct descriptor strings, Amazon under 195, Adobe under 6, Netflix under 5.

Matching works on a **normalised signature** of the description — uppercased,
with phone numbers, URLs, transaction ids and trailing province codes stripped,
then reduced to letters and digits only. So `MARC'S YIG ERIN #3804 ERIN ON` and
`MARC'SYIGERIN#3804ERINON` both become `MARCSYIGERIN` and collapse to one
merchant. A rule matches when its pattern is a substring of that signature, and
**the longest matching pattern wins**, so `GOOGLEWORKSPACE` beats `GOOGLE`.

`data/seed.json` ships 253 rules from three sources:

- **curated** — hand-written, including the mistags the PRD calls out (Buildium
  and Telus belong under Subscriptions, not Home & Property)
- **workbook-rules** — the `Rules` sheet already maintained in the master workbook
- **derived** — inferred from transaction history, but only where ≥ 3 transactions
  agree on a category ≥ 70% of the time

Weak evidence deliberately produces **no rule**. Those merchants stay `Unmapped`
and get flagged, which is the point — the table currently resolves ~79% of
historical transactions, and the remaining ~21% is a long tail of roughly 700
one-off local merchants that genuinely need a human decision.

Edit the table from the **Lookup table** tab, or inline from any unmapped
transaction row or flag. Edits persist to `localStorage` and survive a re-seed.

Regenerate the seed after changing `build_seed.py`:

```bash
pip install openpyxl
python3 tools/build_seed.py "/path/to/Personal CFO 2025 - UPDATED (May-Jul 2026).xlsx" -o data/seed.json
```

---

## Statement parsing

Three RBC layouts are supported, handled by two parsers:

- **`rbc-visa`** — a two-column page. The right-hand "IMPORTANT INFORMATION"
  sidebar is excluded by x-position; without that, the credit limit and minimum
  payment get read as charges.
- **`rbc-bank`** — covers both the **personal** account statement and the
  **business** account statement. Withdrawal versus deposit is encoded by *which
  column* a number sits in, not by sign, so column positions are read off the
  header row and each figure is assigned by matching right edges (the figures are
  right-aligned). The two statement types differ only in their labels —
  `Withdrawals ($) / Deposits ($)` versus `Cheques & Debits ($) / Deposits &
  Credits ($)` — and in printing the period without a "From" prefix. The business
  statement also prints the date twice on some rows (posted and effective) and
  shifts its whole table left on continuation pages.

### Verification

Every parse is checked against the control totals the statement itself prints,
which is the only check that actually proves a parser is right:

```bash
npm i pdfjs-dist@4.6.82
node tools/reconcile.mjs rbc-bank ~/Downloads/statement.pdf
node tools/reconcile.mjs rbc-visa  ~/Downloads/visa.pdf
```

It exits non-zero on any mismatch. All 7 accounts have been reconciled exactly —
amounts, and for business statements the transaction counts too:

| Account | Statement | Debits | Credits |
|---|---|---|---|
| Rob Bank | 2026-07 | $22,707.17 | $50,000.01 |
| Mel Bank | 2026-07 | $10,137.96 | $14,536.88 |
| Daniko Bank | 2025-12 → 2026-04 (5) | exact, counts too | exact, counts too |
| Rob Visa Personal | 2026-07 | $5,907.82 | $5,112.66 |
| Melanie Personal Visa | 2026-07 | $115.32 | $3,000.00 |
| Daniko Rob Visa | 2026-04 | $19,656.37 | $7,080.31 |
| Daniko Mel Visa | 2026-07 | $0.00 | $29.38 |

Note for Visa statements: the control total is `Purchases & debits` **plus**
`Cash advances`, `Interest` and `Fees`. Interest and fees are real charges the
parser picks up; RBC just accounts for them on separate lines. Melanie's July
statement is the case that makes this visible — $0.00 of purchases but $115.32 of
purchase interest.

A statement in some other layout will parse to zero rows and say so rather than
inventing data.

---

## Files

```
index.html            shell and tab structure
css/styles.css        dark theme; status colour is the loudest thing on the page
js/config.js          Drive ids, the 7 accounts, thresholds, palette
js/drive.js           OAuth, folder traversal, statement discovery
js/parse.js           RBC Visa + RBC bank PDF parsers, master workbook reader
js/merchants.js       normalisation, consolidation, category lookup
js/guardrails.js      baselines and the rules engine
js/charts.js          Chart.js visualisations
js/export.js          update package, changelog, email draft
js/ui.js              view rendering
js/app.js             orchestration
data/seed.json        generated lookup table
tools/build_seed.py   regenerates data/seed.json from the master workbook
tools/test-parsers.mjs  quick parse dump for one PDF
tools/reconcile.mjs   checks a parse against the statement's printed totals
vendor/               Chart.js, SheetJS, pdf.js
```

---

## Known limitations

- Only RBC statement layouts are supported. Anything else parses to zero rows and
  is reported, never silently skipped.
- Reconciliation covers one statement per account (five for Daniko Bank). Other
  months are assumed to share the layout; `tools/reconcile.mjs` re-checks any of
  them in seconds if you want more coverage.
- Acknowledged flags are per-browser and reset each cycle by design — acknowledging
  is not "fixed", and the flag returns if the underlying data still trips the rule.

## Not built (deliberately)

n8n automation is out of scope for v1, per the PRD's decision to run several manual
cycles first. `WEBHOOK_SKETCH` in `js/export.js` records the two natural seams — a
Drive "new statement" trigger and a "cycle complete" payload — for whenever that
work starts. No workflow was built.
