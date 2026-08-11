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

Two RBC layouts are supported, both built against real statements:

- **`rbc-visa`** — a two-column page. The right-hand "IMPORTANT INFORMATION"
  sidebar is excluded by x-position; without that, the credit limit and minimum
  payment get read as charges.
- **`rbc-bank`** — withdrawal versus deposit is encoded by *which column* a number
  sits in, not by sign. Column positions are read off the header row and each
  figure is assigned by matching right edges, since the numbers are right-aligned.
  Wrapped descriptions and repeated page furniture are handled.

Both were verified against their own control totals — a Visa statement's parsed
purchases matched its printed "Purchases & debits" of $19,656.37 exactly, and a
bank statement's parsed withdrawals and deposits matched its printed $22,707.17
and $50,000.01 exactly.

To re-check a statement:

```bash
npm i pdfjs-dist@4.6.82
node tools/test-parsers.mjs rbc-bank ~/Downloads/statement.pdf
```

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
tools/test-parsers.mjs  parser check against a real PDF
vendor/               Chart.js, SheetJS, pdf.js
```

---

## Known limitations

- **Melanie Personal Visa has no data.** The account is configured and its Drive
  folders exist, but no statements have been uploaded, so it is flagged as missing
  every cycle until they are.
- **May–Jul 2026 is missing the three Daniko accounts**, matching the gap the PRD
  describes. Month-over-month figures for those cycles carry the incomplete-comparison
  caveat.
- Only RBC statement layouts are supported.
- Acknowledged flags are per-browser and reset each cycle by design — acknowledging
  is not "fixed", and the flag returns if the underlying data still trips the rule.

## Not built (deliberately)

n8n automation is out of scope for v1, per the PRD's decision to run several manual
cycles first. `WEBHOOK_SKETCH` in `js/export.js` records the two natural seams — a
Drive "new statement" trigger and a "cycle complete" payload — for whenever that
work starts. No workflow was built.
