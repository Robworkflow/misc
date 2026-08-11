#!/usr/bin/env python3
"""
Build data/seed.json for the Personal CFO Guardrail app.

Reads the master Personal CFO workbook and emits:
  - the canonical category list
  - the merchant -> category lookup table (curated rules + rules derived from history)
  - the subscription registry

Curated rules always win over derived ones. Derived rules are only emitted when the
history is unambiguous (see MIN_COUNT / MIN_CONFIDENCE); anything weaker is left out
on purpose so the merchant surfaces as Unmapped in the app instead of being guessed.

Usage:  python3 tools/build_seed.py path/to/master.xlsx [-o data/seed.json]
"""

import argparse
import collections
import datetime as dt
import json
import re
import sys

# ---------------------------------------------------------------- normalization

# Province / state codes that trail almost every card descriptor.
REGION = (
    "ON BC AB QC MB SK NS NB NL PE YT NT NU CA US NY MA WA TX CO IL NJ FL GA "
    "PA OH MI NC VA AZ NV UT OR MN MO TN IN WI MD"
).split()
REGION_RE = re.compile(r"\b(?:%s)\b\s*$" % "|".join(REGION))


def clean(desc: str) -> str:
    """Strip the volatile parts of a statement descriptor (ids, phones, cities)."""
    d = (desc or "").upper()
    d = re.sub(r"\d{3}[-\s]?\d{3}[-\s]?\d{4}", " ", d)  # phone numbers
    d = re.sub(r"HTTPS?[A-Z0-9.:/_-]+", " ", d)  # embedded urls
    d = re.sub(r"WWW\.[A-Z0-9.-]+", " ", d)
    # Strip transaction ids after * or # -- but only when the token actually looks
    # like an id (contains a digit). 'SQ *SNOWBERRY BOTANICALS' and
    # 'PAYPAL *VEEDLIMITED' put the real merchant name after the star.
    d = re.sub(r"[*#]\s*(?=[A-Z0-9]*\d)[A-Z0-9]{4,}", " ", d)
    d = re.sub(r"\b\d{4,}\b", " ", d)  # long digit runs
    d = re.sub(r"\s+", " ", d).strip()
    for _ in range(4):  # peel trailing region codes
        d = REGION_RE.sub("", d).strip()
    return d


def signature(desc: str) -> str:
    """Alnum-only signature. Collapses spacing variants of the same merchant.

    'MARC'S YIG ERIN #3804 ERIN ON' and "MARC'SYIGERIN#3804ERINON" both -> MARCSYIGERIN
    """
    return re.sub(r"[^A-Z0-9]", "", clean(desc))


KEY_LEN = 10  # prefix length used to group merchants during derivation

# ------------------------------------------------------------------ curated map
# Patterns are matched against signature(description) with `contains`.
# These encode the corrections called out in the PRD (Buildium/Telus were mistagged
# as Home & Property) plus the merchant consolidations the brief asks for.

CURATED = [
    # --- subscriptions: software / AI / creative -------------------------------
    ("ADOBE",            "Adobe Creative Cloud",   "Subscriptions", "Business", None,  True,  "monthly"),
    ("MICROSOFT",        "Microsoft 365",          "Subscriptions", "Business", None,  True,  "monthly"),
    ("GSUITE",           "Google Workspace",       "Subscriptions", "Business", None,  True,  "monthly"),
    ("GOOGLEWORKSPACE",  "Google Workspace",       "Subscriptions", "Business", None,  True,  "monthly"),
    ("INTUIT",           "QuickBooks Online",      "Subscriptions", "Business", None,  True,  "monthly"),
    ("QBOOKS",           "QuickBooks Online",      "Subscriptions", "Business", None,  True,  "monthly"),
    ("ANTHROPIC",        "Claude.ai",              "Subscriptions", "Business", None,  True,  "monthly"),
    ("CLAUDEAI",         "Claude.ai",              "Subscriptions", "Business", None,  True,  "monthly"),
    ("OPENAI",           "OpenAI ChatGPT",         "Subscriptions", "Business", None,  True,  "monthly"),
    ("ELEVENLABS",       "ElevenLabs",             "Subscriptions", "Business", None,  True,  "monthly"),
    ("HIGGSFIELD",       "Higgsfield",             "Subscriptions", "Business", None,  True,  "monthly"),
    ("LTXSTUDIO",        "LTX Studio",             "Subscriptions", "Business", None,  True,  "monthly"),
    ("LTX",              "LTX Studio",             "Subscriptions", "Business", None,  True,  "monthly"),
    ("VEED",             "Veed",                   "Subscriptions", "Business", None,  True,  "monthly"),
    ("VMAKE",            "Vmake AI",               "Subscriptions", "Business", None,  True,  "monthly"),
    ("BASE44",           "Base44",                 "Subscriptions", "Business", None,  True,  "monthly"),
    ("RETELL",           "Retell AI",              "Subscriptions", "Business", None,  True,  "monthly"),
    ("TWILIO",           "Twilio",                 "Subscriptions", "Business", None,  True,  "monthly"),
    ("HOSTINGER",        "Hostinger",              "Subscriptions", "Business", None,  True,  "monthly"),
    ("GODADDY",          "GoDaddy",                "Subscriptions", "Business", None,  True,  "monthly"),
    ("SKOOL",            "Skool",                  "Subscriptions", "Business", None,  True,  "monthly"),
    ("ZOOM",             "Zoom",                   "Subscriptions", "Business", None,  True,  "monthly"),
    ("N8N",              "n8n Cloud",              "Subscriptions", "Business", None,  True,  "monthly"),
    ("UPWORK",           "Upwork",                 "Subscriptions", "Business", None,  True,  "monthly"),
    ("SOLINCREATOR",     "Solin Creator",          "Subscriptions", "Business", "Rob", True,  "monthly"),
    # --- subscriptions: property management (PRD: were mistagged Home & Property)
    ("BUILDIUM",         "Buildium Property Mgmt", "Subscriptions", "Business", None,  True,  "monthly"),
    ("DOORLOOP",         "DoorLoop",               "Subscriptions", "Business", None,  True,  "annual"),
    ("LISTINGVIEW",      "ListingView.io",         "Subscriptions", "Business", None,  True,  "monthly"),
    # --- subscriptions: telecom (PRD: was mistagged Home & Property) -----------
    ("TELUS",            "Telus Mobility",         "Subscriptions", "Business", None,  True,  "monthly"),
    # --- subscriptions: media / consumer --------------------------------------
    ("NETFLIX",          "Netflix",                "Subscriptions", "Personal", None,  True,  "monthly"),
    ("DISNEYPLUS",       "Disney Plus",            "Subscriptions", "Personal", None,  True,  "annual"),
    ("SPORTSNET",        "Sportsnet NOW",          "Subscriptions", "Personal", None,  True,  "annual"),
    ("PRIMEVIDEO",       "Prime Video Ad-Free",    "Subscriptions", "Personal", None,  True,  "monthly"),
    ("ADFREEFOR",        "Prime Video Ad-Free",    "Subscriptions", "Personal", None,  True,  "monthly"),
    ("AMAZONPRIME",      "Amazon Prime",           "Subscriptions", "Personal", None,  True,  "monthly"),
    ("AUDIBLE",          "Audible",                "Subscriptions", "Personal", None,  True,  "monthly"),
    ("APPLECOMBILL",     "Apple Subscription",     "Subscriptions", "Personal", None,  True,  "monthly"),
    ("PLAYSTATION",      "PlayStation Network",    "Subscriptions", "Personal", None,  True,  "annual"),
    ("UDEMY",            "Udemy",                  "Subscriptions", "Personal", None,  True,  "annual"),
    ("UBERDIRECT",       "Uber Direct Pass",       "Subscriptions", "Personal", None,  True,  "monthly"),
    ("UBERONE",          "Uber One",               "Subscriptions", "Personal", None,  True,  "monthly"),
    ("DOLLARSHAVECLUB",  "Dollar Shave Club",      "Subscriptions", "Personal", None,  True,  "monthly"),
    ("WWCANADA",         "WW Canada",              "Subscriptions", "Personal", None,  True,  "monthly"),
    ("BETTERMEPILATES",  "BetterMe Pilates",       "Subscriptions", "Personal", None,  True,  "monthly"),
    ("BUILTWITHSCIENCE", "Built with Science",     "Subscriptions", "Personal", None,  True,  "annual"),
    # --- health / fitness ------------------------------------------------------
    ("MOVATI",           "Movati Athletic",        "Health & Wellness", "Personal", None, True, "biweekly"),
    ("GUELPHMMA",        "Guelph MMA",             "Health & Wellness", "Personal", None, True, "monthly"),
    ("NBX",              "Guelph MMA",             "Health & Wellness", "Personal", None, True, "monthly"),
    ("PILATESINERIN",    "Pilates in Erin",        "Health & Wellness", "Personal", None, False, None),
    ("ERINPHARMACY",     "Erin Pharmacy",          "Health & Wellness", "Personal", None, False, None),
    ("ALMASTREETANIMAL", "Alma Street Animal Hospital", "Health & Wellness", "Personal", None, False, None),
    # --- insurance -------------------------------------------------------------
    ("WAWANESA",         "Wawanesa Insurance",     "Insurance", "Personal", None, True,  "monthly"),
    ("LLOYDS",           "Lloyds Insurance",       "Insurance", "Personal", None, True,  "monthly"),
    ("BELAIRINS",        "Belair Insurance",       "Insurance", "Personal", None, True,  "monthly"),
    ("EQUITABLELIFE",    "Equitable Life",         "Insurance", "Business", None, True,  "monthly"),
    ("NORTHBRIDGE",      "Northbridge Insurance",  "Insurance", "Business", None, True,  "monthly"),
    # --- home & property / utilities ------------------------------------------
    ("ENBRIDGE",         "Enbridge Gas",           "Home & Property", "Personal", None, True, "monthly"),
    ("HYDROONE",         "Hydro One",              "Home & Property", "Personal", None, True, "monthly"),
    ("HSCC",             "H.S.C.C. #740",          "Home & Property", "Business", None, True, "monthly"),
    ("SEPPSUPERPASS",    "Sepp Super Pass Gas",    "Home & Property", "Business", None, True, "monthly"),
    ("SUNBELT",          "Sunbelt Rentals",        "Home & Property", "Business", None, False, None),
    ("HOMEDEPOT",        "Home Depot",             "Home & Property", "Business", None, False, None),
    ("SHADEPLUS",        "ShadePlus",              "Home & Property", "Personal", None, False, None),
    ("MIKECABINET",      "Mike (cabinets)",        "Home & Property", "Personal", None, False, None),
    ("SCOTTADNAMS",      "Scott Adnams",           "Home & Property", "Personal", None, False, None),
    ("CORYWATSON",       "Cory Watson",            "Home & Property", "Personal", None, False, None),
    # --- automotive / transport ------------------------------------------------
    ("FORDCREDIT",       "Ford Credit",            "Automotive", "Personal", None, True,  "monthly"),
    ("HWY407",           "Highway 407 ETR",        "Automotive", "Personal", None, True,  "monthly"),
    ("KUBOTA",           "Kubota Equipment Loan",  "Automotive", "Business", None, True,  "monthly"),
    ("CHARGEPOINT",      "ChargePoint",            "Automotive", "Business", None, False, None),
    ("UBERCANADAUBERTRIP", "Uber (rides)",         "Transportation", "Personal", None, False, None),
    ("UBERCANADAUBERBUSINE", "Uber (business)",    "Transportation", "Business", None, False, None),
    ("EDSTEWART",        "Ed Stewart's Garage",    "Automotive", "Business", None, False, None),
    ("WASHSHINECARWASH", "Wash & Shine Car Wash",  "Automotive", "Business", None, False, None),
    # --- food ------------------------------------------------------------------
    ("CHEFSPLATE",       "Chefs Plate",            "Groceries & Market", "Personal", "Mel", True, "weekly"),
    ("UBERCANADAUBEREATS", "Uber Eats",            "Dining & Food", "Personal", None, False, None),
    ("MARCSYIG",         "Marc's YIG Erin",        "Groceries & Market", None, None, False, None),
    ("ZEHRS",            "Zehrs",                  "Groceries & Market", None, None, False, None),
    ("SOBEYS",           "Sobeys",                 "Groceries & Market", None, None, False, None),
    ("COSTCO",           "Costco",                 "Groceries & Market", None, None, False, None),
    ("GOODNESSME",       "Goodness Me!",           "Groceries & Market", None, None, False, None),
    ("FARMTOPAW",        "Farm to Paw",            "Groceries & Market", None, None, False, None),
    ("SHARPEFARM",       "Sharpe Farm Supplies",   "Groceries & Market", None, None, False, None),
    ("HOLTOMSBAKERY",    "Holtom's Bakery",        "Groceries & Market", None, None, False, None),
    ("HEATHERLEAFARM",   "Heatherlea Farm Shoppe", "Groceries & Market", None, None, False, None),
    ("COUNTRYCROPS",     "Country Crops Erin",     "Groceries & Market", None, None, False, None),
    ("TIMHORTONS",       "Tim Hortons",            "Dining & Food", None, None, False, None),
    ("MCDONALDS",        "McDonald's",             "Dining & Food", None, None, False, None),
    ("SCADDABUSH",       "Scaddabush",             "Dining & Food", None, None, False, None),
    ("PITAPIT",          "Pita Pit",               "Dining & Food", None, None, False, None),
    ("TINROOFCAFE",      "Tin Roof Cafe",          "Dining & Food", None, None, False, None),
    # --- shopping --------------------------------------------------------------
    ("AMZNMKTP",         "Amazon Marketplace",     "Shopping & Clothing", None, None, False, None),
    ("AMAZONCA",         "Amazon.ca",              "Shopping & Clothing", None, None, False, None),
    ("TEMU",             "Temu",                   "Shopping & Clothing", None, None, False, None),
    ("WINNERS",          "Winners / HomeSense",    "Shopping & Clothing", None, None, False, None),
    ("HOMESENSE",        "Winners / HomeSense",    "Shopping & Clothing", None, None, False, None),
    ("MISSIONTHRIFT",    "Mission Thrift Store",   "Shopping & Clothing", None, None, False, None),
    ("WILDROSECONS",     "Wild Rose Consignment",  "Shopping & Clothing", None, None, False, None),
    ("SNOWBERRYB",      "Snowberry Botanicals",   "Shopping & Clothing", None, None, False, None),
    ("NORTHOFMUSKOKA",   "North of Muskoka",       "Shopping & Clothing", None, None, False, None),
    ("GAPCOM",           "Gap",                    "Shopping & Clothing", None, None, False, None),
    # --- kids / school ---------------------------------------------------------
    ("WELLINGTONCDSB",   "Wellington CDSB",        "Kids & Activities", "Personal", None, False, None),
    ("VIDSWAP",          "VidSwap",                "Kids & Activities", "Personal", "Rob", True, "monthly"),
    ("RJMCCARTHY",       "R.J. McCarthy (uniforms)", "Kids & Activities", "Personal", None, False, None),
    ("SPORTPY",          "Minor Hockey",           "Kids & Activities", "Personal", None, False, None),
    ("UNIVOFGUELPH",     "University of Guelph",   "Kids & Activities", "Personal", None, False, None),
    # --- cottage ---------------------------------------------------------------
    ("PRIDEMARINE",      "Pride Marine",           "Cottage & Recreation", "Personal", None, False, None),
    ("MIKENEAL",         "Mike Neal",              "Cottage & Recreation", "Personal", None, False, None),
    # --- travel ----------------------------------------------------------------
    ("AIRCAN",           "Air Canada",             "Travel", None, None, False, None),
    ("AIRCANADA",        "Air Canada",             "Travel", None, None, False, None),
    ("COMFORTINN",       "Comfort Inn",            "Travel", None, None, False, None),
    ("VACAC",            "Air Canada Vacations",   "Travel", None, None, False, None),
    # --- taxes / government ----------------------------------------------------
    ("MILTONTAXES",      "Milton Property Taxes",  "Taxes & Government", None, None, True, "monthly"),
    ("CANADACARBONREBATE", "Canada Carbon Rebate", "Taxes & Government", None, None, False, None),
    # --- banking / transfers ---------------------------------------------------
    ("BANKINGFEE",       "Banking Fee",            "Fees & Interest", None, None, False, None),
    ("OVERLIMITFEE",     "Over-limit Fee",         "Fees & Interest", None, None, False, None),
    ("OVERDRAFTINTEREST", "Overdraft Interest",    "Fees & Interest", None, None, False, None),
    ("LOANINTEREST",     "Loan Interest",          "Fees & Interest", None, None, False, None),
    ("DEPOSITINTEREST",  "Deposit Interest",       "Income", None, None, False, None),
    ("PAYFILEFEES",      "File Fees",              "Fees & Interest", None, None, False, None),
    ("AUTOMATICPAYMENT", "Card Payment",           "Transfers", None, None, False, None),
    ("RBCCREDITCARD",    "RBC Credit Card Payment", "Transfers", None, None, False, None),
    ("ONLINETRANSFER",   "Online Transfer",        "Transfers", None, None, False, None),
    ("ETRANSFER",        "e-Transfer",             "Transfers", None, None, False, None),
    ("BRTOBR",           "Branch Transfer",        "Transfers", None, None, False, None),
    ("ATMWITHDRAWAL",    "ATM Withdrawal",         "Transfers", None, None, False, None),
    ("MOBILECHEQUEDEPOSIT", "Cheque Deposit",      "Income", None, None, False, None),
    ("AVECAP",           "AveCap Investment Interest", "Income", "Business", None, False, None),
    ("TAXREFUND",        "Tax Refund",             "Income", "Business", None, False, None),
    ("ECOSYSTEMINFORMATICS", "Ecosystem Informatics", "Income", None, None, False, None),
    # --- local merchants that were surfacing as unmapped noise -----------------
    ("CARNEYCOUNTRY",    "Carney Country Events",  "Dining & Food", None, None, False, None),
    ("GERRIESFARM",      "Gerrie's Farm Market",   "Groceries & Market", None, None, False, None),
    ("RURALCOMMO",       "Rural Commons",          "Dining & Food", None, None, False, None),
    ("EASTWELLINGTON",   "East Wellington Community", "Kids & Activities", None, None, False, None),
    ("SQUAREINC",        "Square (unidentified)",  "Needs Review", None, None, False, None),
    ("DRKATRINA",        "Dr. Katrina Kulhay",     "Health & Wellness", None, None, False, None),
    ("HARMONYWHOLEFOODS", "Harmony Whole Foods",   "Groceries & Market", None, None, False, None),
    ("BULKBARN",         "Bulk Barn",              "Groceries & Market", None, None, False, None),
    ("FOODLAND",         "Foodland",               "Groceries & Market", None, None, False, None),
    ("METRO",            "Metro",                  "Groceries & Market", None, None, False, None),
    ("RCSS",             "Real Canadian Superstore", "Groceries & Market", None, None, False, None),
    ("VOILACA",          "Voila.ca",               "Groceries & Market", None, None, False, None),
    ("WALMART",          "Walmart",                "Groceries & Market", None, None, False, None),
    ("DUTCHMILLCOUNTRY", "Dutch Mill Country Market", "Groceries & Market", None, None, False, None),
    ("DAVESBUTCHER",     "Dave's Butcher Shop",    "Groceries & Market", None, None, False, None),
    ("ERINDOLLAR",       "Erin Dollar & Discount", "Shopping & Clothing", None, None, False, None),
    ("THEWEATHERVANE",   "The Weathervane",        "Shopping & Clothing", None, None, False, None),
    ("BEAUTYBAR",        "Beauty Bar",             "Health & Wellness", None, None, False, None),
    ("AIRDOCTOR",        "AirDoctor",              "Home & Property", None, None, False, None),
    ("STONESTHROW",      "A Stone's Throw Pub",    "Dining & Food", None, None, False, None),
    ("GIANNISPIZZA",     "Giannis Pizza",          "Dining & Food", None, None, False, None),
]

# Recurring charges split into two kinds. Both are tracked, but only 'subscription'
# feeds the subscription-burn guardrail: a car loan or a property-tax instalment is
# a recurring obligation, not a subscription, and letting a $2,900/mo loan payment
# into that number would drown out the $30 streaming change the rule exists to catch.
BILLS = {
    "FORDCREDIT", "KUBOTA", "HSCC", "MILTONTAXES", "SEPPSUPERPASS", "HYDROONE",
    "ENBRIDGE", "HWY407", "NORTHBRIDGE", "EQUITABLELIFE", "BELAIRINS",
    "WAWANESA", "LLOYDS",
}

# Treasury movement between the household's own accounts and the business. These
# are not spend; mapping them to Transfers keeps them out of every baseline.
TRANSFER_PATTERNS = [
    ("FUNDSTRANSFER",    "Funds Transfer"),
    ("B2BTRANSFER",      "B2B Transfer"),
    ("B2B",              "B2B Transfer"),
    ("AVENUECAPITAL",    "Avenue Capital Transfer"),
    ("TTLEONARDDEV",     "TT Leonard Dev Transfer"),
    ("INTERFIFUNDTR",    "Inter-FI Transfer"),
    ("ONLINEBANKINGPAYMENT", "Online Banking Payment"),
    ("ONLINEBANKINGTRANSFER", "Online Banking Transfer"),
    ("DEPOSITACCOUNT",   "Deposit Account Transfer"),
    ("BRTOBR",           "Branch Transfer"),
    ("CASHWITHDRAWAL",   "Cash Withdrawal"),
    ("TELPAYPMT",        "Telpay Payment"),
    ("PAYROLLDEP",       "Payroll Deposit"),
]

# Derived-rule quality gates. Anything below these stays unmapped on purpose.
MIN_COUNT = 3
MIN_CONFIDENCE = 0.70

CATEGORIES = [
    "Automotive", "Cottage & Recreation", "Dining & Food", "Entertainment",
    "Fees & Interest", "Groceries & Market", "Health & Wellness",
    "Home & Property", "Income", "Insurance", "Kids & Activities",
    "Shopping & Clothing", "Subscriptions", "Taxes & Government",
    "Transfers", "Transportation", "Travel",
]

# Canonicalise the "and" vs "&" spelling drift between the Rules sheet and the
# Transactions sheet ("Kids and Activities" vs "Kids & Activities").
def canon_category(c):
    if not c:
        return None
    c = str(c).strip().replace(" and ", " & ")
    for known in CATEGORIES:
        if known.lower() == c.lower():
            return known
    return c


def load_rules_sheet(wb):
    """Curated keyword rules already maintained inside the workbook."""
    if "Rules" not in wb.sheetnames:
        return []
    out = []
    for row in wb["Rules"].iter_rows(min_row=2, max_col=5, values_only=True):
        keyword, category, person, spend, notes = (list(row) + [None] * 5)[:5]
        if not keyword or not category:
            continue
        out.append({
            "pattern": signature(str(keyword)),
            "display": str(keyword).strip().title(),
            "category": canon_category(category),
            "spendType": str(spend).strip() if spend else None,
            "person": str(person).strip() if person else None,
            "isSubscription": False,
            "recurringType": None,
            "cadence": None,
            "source": "workbook-rules",
            "notes": str(notes).strip() if notes else None,
        })
    return out


def derive_rules(rows, taken):
    """Infer rules from transaction history where the category is unambiguous."""
    groups = collections.defaultdict(collections.Counter)
    examples, sigs = {}, collections.defaultdict(collections.Counter)

    for date, desc, amount, flow, category, *rest in rows:
        sig = signature(str(desc))
        if len(sig) < 4:
            continue
        key = sig[:KEY_LEN]
        groups[key][canon_category(category)] += 1
        sigs[key][sig] += 1
        examples.setdefault(key, str(desc))

    derived = []
    for key, counts in groups.items():
        total = sum(counts.values())
        mapped = {k: v for k, v in counts.items() if k and k != "Needs Review"}
        if not mapped:
            continue
        category, n = max(mapped.items(), key=lambda kv: kv[1])
        confidence = n / total
        if total < MIN_COUNT or confidence < MIN_CONFIDENCE:
            continue
        if any(key.startswith(t) or t.startswith(key) for t in taken):
            continue  # already covered by a curated rule
        display = clean(examples[key]).title() or key
        derived.append({
            "pattern": key,
            "display": display[:40],
            "category": category,
            "spendType": None,
            "person": None,
            "isSubscription": False,
            "recurringType": None,
            "cadence": None,
            "source": "derived",
            "confidence": round(confidence, 2),
            "sampleCount": total,
            "example": examples[key][:60],
        })
    derived.sort(key=lambda r: -r["sampleCount"])
    return derived


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook")
    ap.add_argument("-o", "--out", default="data/seed.json")
    args = ap.parse_args()

    try:
        import openpyxl
    except ImportError:
        sys.exit("openpyxl is required:  pip install openpyxl")

    wb = openpyxl.load_workbook(args.workbook, data_only=True)
    rows = [r for r in wb["Transactions"].iter_rows(min_row=3, values_only=True) if r and r[0]]

    curated = []
    for pattern, display, category, spend, person, is_sub, cadence in CURATED:
        if pattern in BILLS:
            recurring = "bill"
        elif is_sub:
            recurring = "subscription"
        else:
            recurring = None
        curated.append({
            "pattern": pattern,
            "display": display,
            "category": canon_category(category),
            "spendType": spend,
            "person": person,
            "isSubscription": recurring == "subscription",
            "recurringType": recurring,
            "cadence": cadence,
            "source": "curated",
        })

    for pattern, display in TRANSFER_PATTERNS:
        curated.append({
            "pattern": pattern,
            "display": display,
            "category": "Transfers",
            "spendType": None,
            "person": None,
            "isSubscription": False,
            "recurringType": None,
            "cadence": None,
            "source": "curated",
        })

    taken = {r["pattern"] for r in curated}
    from_sheet = [r for r in load_rules_sheet(wb) if r["pattern"] not in taken]
    taken |= {r["pattern"] for r in from_sheet}
    derived = derive_rules(rows, taken)

    seed = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generatedFrom": args.workbook.split("/")[-1],
        "categories": CATEGORIES,
        "merchantRules": curated + from_sheet + derived,
    }

    with open(args.out, "w") as fh:
        json.dump(seed, fh, indent=1)

    print(f"wrote {args.out}")
    print(f"  curated : {len(curated)}")
    print(f"  workbook: {len(from_sheet)}")
    print(f"  derived : {len(derived)}  (>= {MIN_COUNT} txns, >= {MIN_CONFIDENCE:.0%} agreement)")
    print(f"  total   : {len(seed['merchantRules'])} rules")


if __name__ == "__main__":
    main()
