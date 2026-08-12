// Category suggestions from merchant-name semantics.
//
// This exists because the lookup table can only learn a merchant that repeats,
// and 84% of the unmapped merchants in this ledger appear exactly once. A
// frequency rule will never reach them. Reading what the name *says* will.
//
// THE RULE THAT GOVERNS THIS FILE: a suggestion is never applied. It is shown to
// a human with the evidence behind it, and it becomes a category only when that
// human accepts it. Nothing here writes a category, and no confidence level
// unlocks auto-apply — there is deliberately no such threshold to raise.
//
// The lexicon is intentionally *generic*. Brand names belong in the curated
// rules in data/seed.json, where "SHOPPERSDRUG" already matches every store
// number and town. Putting brands here would make this look smarter than it is:
// measured against transactions whose category is fixed by a curated rule, the
// generic lexicon agreed 161 times out of 162 (99.4%).

import { displayText } from './merchants.js';

/** Generic words that identify what a merchant *is*, never who it is. */
export const LEXICON = [
  { category: 'Dining & Food', terms: [
    'PIZZA', 'PIZZERIA', 'CAFE', 'COFFEE', 'ESPRESSO', 'RESTAURANT', 'GRILL', 'PUB',
    'BISTRO', 'TAQUERIA', 'SUSHI', 'DINER', 'EATERY', 'BURGER', 'DELI', 'BAR',
    'BREWERY', 'BREWING', 'STEAKHOUSE', 'SOUVLAKI', 'PANCAKE', 'CANTINA', 'TAVERN',
    'KITCHEN', 'CHIPS', 'CREAMERY', 'GELATO', 'DONUT', 'SANDWICH', 'NOODLE',
    'RAMEN', 'CURRY', 'TACO', 'BBQ', 'ROTISSERIE', 'CATERING', 'FOOD TRUCK',
  ] },
  { category: 'Groceries & Market', terms: [
    'MARKET', 'GROCER', 'GROCERY', 'FARM', 'FARMS', 'BUTCHER', 'FOODS', 'PRODUCE',
    'MEATS', 'BAKERY', 'SUPERMARKET', 'ORCHARD', 'CREAMERIES', 'FISHERY', 'FISH MARKET',
    'PROVISIONS', 'MERCADO', 'FRUIT',
  ] },
  { category: 'Health & Wellness', terms: [
    'PHARMACY', 'PHARMACIE', 'FARMACIA', 'DRUG MART', 'DRUGS', 'DENTAL', 'DENTIST',
    'CLINIC', 'MEDICAL', 'PHYSIO', 'PHYSIOTHERAPY', 'CHIRO', 'CHIROPRACTIC',
    'OPTOMETRY', 'OPTICAL', 'SPA', 'FITNESS', 'GYM', 'YOGA', 'PILATES', 'SALON',
    'WELLNESS', 'HOSPITAL', 'THERAPY', 'MASSAGE', 'BARBER', 'DERMATOLOGY',
    'VETERINARY', 'ANIMAL HOSPITAL', 'HEALTH',
  ] },
  { category: 'Travel', terms: [
    'HOTEL', 'INN', 'RESORT', 'AIRLINE', 'AIRLINES', 'AIRPORT', 'AIRWAYS', 'MOTEL',
    'LODGE', 'HOSTEL', 'DUTY FREE', 'TRAVEL', 'TOURS', 'CRUISE', 'RENT A CAR',
    'CAR RENTAL', 'BAGGAGE', 'AEROPUERTO',
  ] },
  { category: 'Automotive', terms: [
    'AUTO', 'AUTOMOTIVE', 'TIRE', 'TYRE', 'GARAGE', 'CAR WASH', 'PARKING',
    'MECHANIC', 'MUFFLER', 'COLLISION', 'AUTOBODY', 'FUEL', 'GASOLINE', 'GAS BAR',
    'SERVICE CENTRE', 'OIL CHANGE', 'TOWING',
  ] },
  { category: 'Shopping & Clothing', terms: [
    'BOUTIQUE', 'CLOTHING', 'APPAREL', 'SHOES', 'FOOTWEAR', 'THRIFT', 'CONSIGNMENT',
    'SOUVENIR', 'GIFTS', 'JEWELLERS', 'JEWELRY', 'OUTFITTERS', 'DEPARTMENT STORE',
    'TOYS', 'BOOKS', 'BOOKSTORE', 'FLORIST',
  ] },
  { category: 'Home & Property', terms: [
    'HARDWARE', 'LUMBER', 'BUILDING SUPPLY', 'GARDEN', 'NURSERY', 'PLUMBING',
    'ELECTRIC', 'ELECTRICAL', 'ROOFING', 'FLOORING', 'PAINT', 'FURNITURE',
    'APPLIANCE', 'LANDSCAPING', 'CONTRACTING', 'RENOVATION', 'STORAGE',
  ] },
  { category: 'Entertainment', terms: [
    'CINEMA', 'CINEMAS', 'THEATRE', 'THEATER', 'GOLF', 'MUSEUM', 'GALLERY',
    'BOWLING', 'ARCADE', 'CASINO', 'CONCERT', 'TICKETS', 'AMUSEMENT',
  ] },
  { category: 'Kids & Activities', terms: [
    'SCHOOL', 'ACADEMY', 'DAYCARE', 'MONTESSORI', 'TUTORING', 'MINOR HOCKEY',
    'SOCCER CLUB', 'SCOUTS', 'CAMP',
  ] },
  { category: 'Transportation', terms: [
    'TRANSIT', 'RAILWAY', 'TAXI', 'LIMO', 'SHUTTLE', 'FERRY',
  ] },
];

/**
 * Amounts far outside what a category normally looks like. This is used only to
 * *caution*, never to suggest — the amount alone says almost nothing (a $40
 * charge is groceries, dining, fuel or a toy), so it can weaken a name-based
 * reading but must never produce one.
 */
const ATYPICAL_ABOVE = {
  'Dining & Food': 500,
  'Groceries & Market': 900,
  'Health & Wellness': 1500,
  'Transportation': 500,
  'Entertainment': 1000,
};

const boundary = (term) => new RegExp(`(?:^|[^A-Z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Z]|$)`);
const COMPILED = LEXICON.map(({ category, terms }) => ({
  category,
  matchers: terms.map((t) => ({ term: t, re: boundary(t) })),
}));

/**
 * Read a transaction's merchant name and suggest a category, with the evidence.
 * Returns null when nothing in the name identifies the business — silence is the
 * correct answer far more often than a guess.
 *
 * The caller must treat this as a proposal for a human, never as a category.
 */
export function suggestCategory(txn) {
  if (!txn || txn.flow === 'Income') return null;
  const text = displayText(txn.description);
  if (text.length < 3) return null;

  for (const { category, matchers } of COMPILED) {
    const hit = matchers.find(({ re }) => re.test(text));
    if (!hit) continue;

    const ceiling = ATYPICAL_ABOVE[category];
    const caution = ceiling && txn.amount > ceiling
      ? `unusually large for ${category} — worth a closer look`
      : null;

    return {
      category,
      term: hit.term,
      evidence: `name contains "${hit.term.toLowerCase()}"`,
      caution,
    };
  }
  return null;
}

/** Suggestions for a set of transactions, keyed by fingerprint. */
export function suggestAll(transactions) {
  const out = new Map();
  for (const t of transactions) {
    if (!t.unmapped) continue;
    const s = suggestCategory(t);
    if (s) out.set(t.fingerprint, s);
  }
  return out;
}
