/**
 * Open Food Facts enrichment.
 *
 * Every provider gives you a name and a price. None of them reliably give you
 * allergens, additives, Nutri-Score or ingredients — and the ones that do use
 * their own vocabulary, so you cannot compare across retailers or countries.
 *
 * Open Food Facts is an open database covering products worldwide under a free
 * licence (ODbL for the data). One integration enriches every provider in every
 * country, needs no key, and cannot be WAF-blocked. It is the cheapest global
 * capability in this project.
 *
 * Docs: https://openfoodfacts.github.io/openfoodfacts-server/api/
 * Verified live: 2026-08-03.
 */

import axios from 'axios';
import type { Product } from '../providers/types';

const PRODUCT_API = 'https://world.openfoodfacts.org/api/v2';
const SEARCH_API = 'https://search.openfoodfacts.org';

/**
 * Open Food Facts asks that clients identify themselves so they can contact you
 * if a client misbehaves, rather than silently blocking it. Be a good citizen.
 */
const USER_AGENT = 'open-supermarkets (+https://github.com/abracadabra50/open-supermarkets)';

const FIELDS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'nutriscore_grade',
  'nova_group',
  'ecoscore_grade',
  'allergens_tags',
  'ingredients_text',
  'labels_tags',
].join(',');

export interface Nutrition {
  barcode?: string;
  /** Nutri-Score a–e. */
  nutriscore?: string;
  /** NOVA processing group 1–4; 4 is ultra-processed. */
  nova?: number;
  /** Green-Score / Eco-Score a–e, where present. */
  ecoscore?: string;
  /** Normalised, prefix stripped: ["milk", "nuts"] rather than ["en:milk"]. */
  allergens: string[];
  ingredients?: string;
  labels: string[];
  brand?: string;
  /**
   * How the product was matched. `barcode` is exact; `name` is a best guess
   * from a text search and should be shown as such.
   */
  match: 'barcode' | 'name';
  source: 'openfoodfacts';
}

/** `en:milk` → `milk`. Language prefixes are noise for display. */
function stripTag(tag: string): string {
  const i = tag.indexOf(':');
  return (i === -1 ? tag : tag.slice(i + 1)).replace(/-/g, ' ');
}

/**
 * Open Food Facts is crowd-sourced, so plenty of records exist with a name and
 * nothing else — verified against AH's Dutch milk, which resolves to a real
 * barcode carrying no Nutri-Score, no NOVA and no allergens.
 *
 * Attaching such a record would look like a successful match while telling the
 * caller nothing, so an empty record is treated as no match at all.
 */
function hasSignal(n: Nutrition): boolean {
  return Boolean(
    n.nutriscore || n.nova || n.ecoscore || n.allergens.length || n.ingredients
  );
}

function toNutrition(p: any, match: 'barcode' | 'name'): Nutrition | null {
  if (!p) return null;
  const n: Nutrition = {
    barcode: p.code,
    nutriscore: p.nutriscore_grade && p.nutriscore_grade !== 'unknown'
      ? p.nutriscore_grade
      : undefined,
    nova: typeof p.nova_group === 'number' ? p.nova_group : undefined,
    ecoscore: p.ecoscore_grade && p.ecoscore_grade !== 'unknown'
      ? p.ecoscore_grade
      : undefined,
    allergens: Array.isArray(p.allergens_tags) ? p.allergens_tags.map(stripTag) : [],
    ingredients: p.ingredients_text || undefined,
    labels: Array.isArray(p.labels_tags) ? p.labels_tags.map(stripTag) : [],
    brand: p.brands || undefined,
    match,
    source: 'openfoodfacts',
  };
  return hasSignal(n) ? n : null;
}

/** Exact lookup by barcode. Cheap and accurate — prefer this when you have one. */
export async function byBarcode(barcode: string): Promise<Nutrition | null> {
  try {
    const { data } = await axios.get(`${PRODUCT_API}/product/${encodeURIComponent(barcode)}.json`, {
      params: { fields: FIELDS },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10_000,
    });
    return data?.status === 1 ? toNutrition(data.product, 'barcode') : null;
  } catch {
    // Enrichment is strictly additive. It must never fail a search.
    return null;
  }
}

/** Words too common in product names to count as evidence of a match. */
const STOPWORDS = new Set([
  'the', 'and', 'with', 'de', 'het', 'een', 'pack', 'stuks', 'value',
  'organic', 'bio', 'biologisch', 'fresh', 'free', 'range', 'g', 'kg', 'ml', 'l',
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Similarity between a retailer's product name and an Open Food Facts record,
 * as a Sørensen–Dice coefficient over meaningful tokens.
 *
 * This guard exists because a text search always returns *something*. An early
 * version matched an unrelated product that happened to carry a full allergen
 * record, and attaching that would have been actively dangerous rather than
 * merely unhelpful. Wrong allergen data is worse than no allergen data.
 *
 * Dice rather than one-directional overlap, because the first attempt measured
 * hits ÷ query tokens and that is biased against correct matches. Retail names
 * carry brand and pack noise the canonical record does not:
 *
 *   "Tesco British Semi Skimmed Milk 1.13L, 2 Pints"  (7 tokens)
 *   "Semi Skimmed Milk 2 pints"                        (4 tokens, correct match)
 *
 * One-directional scoring gives 4/7 = 0.57 and rejects it. Dice gives
 * 2×4/(7+4) = 0.73 and accepts. Symmetry is the point: a genuinely unrelated
 * pair scores low in both directions and is still rejected.
 */
function similarity(query: string, candidate: string): number {
  const q = tokens(query);
  const c = tokens(candidate);
  if (q.size === 0 || c.size === 0) return 0;

  // A variant marker present on one side and absent on the other is
  // disqualifying regardless of how well everything else lines up.
  for (const t of q) if (VARIANT_MARKERS.has(t) && !c.has(t)) return 0;
  for (const t of c) if (VARIANT_MARKERS.has(t) && !q.has(t)) return 0;

  const shared = [...q].filter(t => c.has(t));
  if (shared.length === 0) return 0;
  // At least one shared word must be distinctive. Sharing only "milk" is not a
  // match, it is a category.
  if (!shared.some(t => !GENERIC.has(t))) return 0;

  const dice = (2 * shared.length) / (q.size + c.size);
  // Containment rescues the common case where a retailer's verbose name
  // ("Nutella Hazelnut Chocolate Spread Jar 630g") maps to a terse canonical
  // record ("Nutella"). Dice punishes that asymmetry; containment does not.
  const containment = shared.length / Math.min(q.size, c.size);
  return Math.max(dice, containment);
}

/**
 * Words that change what a product IS, not merely how it is described.
 *
 * If the retailer's name says "zero" and the candidate does not, they are
 * different products however well the rest matches — and attaching regular
 * Coke's sugar content to a Zero bottle is the exact failure this module exists
 * to prevent. Checked before any similarity score is even considered.
 */
const VARIANT_MARKERS = new Set([
  'zero', 'diet', 'light', 'lite', 'free', 'decaf', 'decaffeinated',
  'gluten', 'lactose', 'vegan', 'vegetarian', 'unsalted', 'salted',
  'reduced', 'low', 'skimmed', 'semi', 'whole', 'wholemeal', 'unsweetened',
  'sweetened', 'alcohol', 'caffeine', 'sugarfree', 'dairy',
]);

/**
 * Generic category nouns. A shared "chocolate" or "milk" alone is not evidence
 * of the same product — "Chocolate" would otherwise match anything chocolatey.
 */
const GENERIC = new Set([
  'milk', 'chocolate', 'bread', 'cheese', 'water', 'juice', 'yogurt', 'yoghurt',
  'spread', 'sauce', 'cream', 'butter', 'oil', 'rice', 'pasta', 'beans', 'soup',
  'crisps', 'chips', 'biscuits', 'coffee', 'tea', 'sugar', 'flour', 'salt',
  'eggs', 'chicken', 'beef', 'fish', 'drink', 'snack', 'bar', 'jar', 'bottle',
]);

/** Minimum overlap before we believe a name match. Deliberately strict. */
const MIN_SIMILARITY = 0.6;

/**
 * Fuzzy lookup by product name, for the common case where a provider exposes no
 * barcode. Best-effort and guarded: a hit whose name does not substantially
 * overlap the query is discarded rather than returned as a guess.
 *
 * Never rely on a `match: 'name'` result for allergen decisions.
 */
export async function byName(name: string): Promise<Nutrition | null> {
  try {
    const { data } = await axios.get(`${SEARCH_API}/search`, {
      params: { q: name, page_size: 1 },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10_000,
    });

    // ONLY the top hit is considered, and this is deliberate.
    //
    // Scoring the top five instead was tried and reverted: it produced two false
    // positives immediately — a Coca-Cola ZERO query matched a regular-Coke
    // record, and Tesco Finest Blueberries matched something scoring Nutri-Score
    // E. Widening the candidate pool widens the blast radius, because every extra
    // candidate is another chance for a plausible-but-wrong record to clear the
    // guard.
    //
    // The cost is real misses. Searching a Nutella jar returns an unrelated
    // "Milkato" at position one, so that product gets no enrichment at all even
    // though the correct record sits at position two. That is the right trade:
    // a miss shows nothing, a false positive shows the wrong allergens.
    const hit = data?.hits?.[0];
    if (!hit) return null;
    if (similarity(name, hit.product_name ?? '') < MIN_SIMILARITY) return null;

    // search-a-licious returns a trimmed field set, so re-fetch the full record
    // by barcode when we have one. The match stays labelled 'name'.
    if (hit.code) {
      const full = await byBarcode(hit.code);
      if (full) return { ...full, match: 'name' };
    }
    return toNutrition(hit, 'name');
  } catch {
    return null;
  }
}

export interface EnrichedProduct extends Product {
  nutrition?: Nutrition;
}

/**
 * Enrich a batch of products, bounded in concurrency so we stay a polite client
 * of a donation-funded nonprofit. Never throws: a product that cannot be matched
 * comes back unchanged.
 */
export async function enrich(
  products: Product[],
  opts: { concurrency?: number } = {}
): Promise<EnrichedProduct[]> {
  const concurrency = opts.concurrency ?? 4;
  const out: EnrichedProduct[] = [...products];

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < out.length) {
      const i = cursor++;
      const p = out[i];
      const nutrition = /^\d{8,14}$/.test(p.product_uid)
        ? await byBarcode(p.product_uid)
        : await byName(p.name);
      if (nutrition) out[i] = { ...p, nutrition };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, out.length) }, () => worker())
  );
  return out;
}
