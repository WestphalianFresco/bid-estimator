import { cents, fromDollars, type Cents } from "../money";
import type { AssumptionSet, MaterialRate } from "../assumptions";
import type { Unit } from "../schema";

/**
 * Material unit costs from Home Depot retail listings, via SerpApi.
 *
 * ## Read this before trusting a number that came out of here
 *
 * **Retail is the wrong basis, and this module does not pretend otherwise.**
 * A commercial contractor buys roofing from ABC Supply or Beacon, plumbing from
 * Ferguson and gear from Graybar, on negotiated accounts that typically land
 * 20–40% under the retail shelf price. Home Depot is a reasonable sanity check
 * and a reasonable starting point for a contractor who does not yet have their
 * own quotes loaded. It is not a substitute for them. `retailFactor` exists to
 * apply your own account discount; it defaults to 1.0 because inventing a
 * discount would be worse than showing you the retail number and saying so.
 *
 * **Only some of the catalog is a retail SKU.** Ready-mix concrete by the yard,
 * fabricated ES-1 edge metal, commercial rooftop units, elevator controllers and
 * site utility pipe are not sold at Home Depot in any form an estimator can use.
 * `HD_SOURCING` covers the keys where a retail listing is genuinely comparable
 * and deliberately leaves the rest alone — those keep their catalog default and
 * are reported as unsourced rather than being force-fitted to a search result.
 *
 * **Retail sells packages, estimating needs units.** Polyiso comes as a 4x8
 * sheet, TPO as a 10'x100' roll, shingles by the bundle, paint by the pail. Each
 * mapping therefore carries the coverage of one package and a waste factor, and
 * the unit cost is derived, not read off the listing.
 *
 * ## Determinism
 *
 * Layer 2 must produce the same number from the same inputs forever, so nothing
 * here is called during pricing. Prices are fetched ahead of time, folded into
 * an assumption set, and that assumption set is captured in the estimate
 * snapshot along with the provenance below. An estimate can therefore be
 * reproduced years later even after every listing has changed.
 */

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";

export interface SourcingRule {
  /** What to search Home Depot for. */
  query: string;
  /** How many `unit`s one purchased package covers. */
  coveragePerPackage: number;
  /** Unit the resulting cost is expressed in; must match the catalog entry. */
  unit: Unit;
  /** Cut, overlap and breakage allowance. 0.10 = 10% extra material bought. */
  wasteFactor: number;
  /** What one package is, for the audit trail. */
  packageNote: string;
}

/**
 * Keys Home Depot can genuinely price. Everything absent from this map keeps its
 * catalog default — see the module comment.
 */
export const HD_SOURCING: Record<string, SourcingRule> = {
  "06-rough-framing": {
    query: "2x4x8 kiln dried whitewood stud",
    coveragePerPackage: 8, // ~1 stud per SF of wall at 16" o.c. plus plates
    unit: "SF",
    wasteFactor: 0.12,
    packageNote: "one 2x4x8 stud, spread over ~8 SF of framed wall",
  },
  "06-blocking-nailer": {
    query: "2x6x8 pressure treated lumber",
    coveragePerPackage: 8,
    unit: "LF",
    wasteFactor: 0.1,
    packageNote: "one 8 ft treated board",
  },
  "06-roof-deck-repair": {
    query: "5/8 in CDX plywood sheathing 4x8",
    coveragePerPackage: 32,
    unit: "SF",
    wasteFactor: 0.1,
    packageNote: "one 4x8 sheet = 32 SF",
  },
  "07-roof-insulation": {
    query: "polyiso rigid foam roof insulation board 4x8",
    coveragePerPackage: 32,
    unit: "SF",
    wasteFactor: 0.08,
    packageNote: "one 4x8 board = 32 SF",
  },
  "07-roof-cover-board": {
    query: "roof cover board gypsum 4x8",
    coveragePerPackage: 32,
    unit: "SF",
    wasteFactor: 0.08,
    packageNote: "one 4x8 board = 32 SF",
  },
  "07-roof-membrane-tpo": {
    query: "TPO roofing membrane 60 mil roll",
    coveragePerPackage: 1000,
    unit: "SF",
    wasteFactor: 0.12,
    packageNote: "one 10 ft x 100 ft roll = 1,000 SF",
  },
  "07-roof-membrane-epdm": {
    query: "EPDM rubber roofing membrane 45 mil roll",
    coveragePerPackage: 1000,
    unit: "SF",
    wasteFactor: 0.12,
    packageNote: "one 10 ft x 100 ft roll = 1,000 SF",
  },
  "07-roof-shingles": {
    query: "architectural asphalt roofing shingles bundle",
    coveragePerPackage: 0.333, // three bundles to a square
    unit: "SQ",
    wasteFactor: 0.1,
    packageNote: "one bundle = one third of a 100 SF square",
  },
  "07-caulking-sealant": {
    query: "polyurethane construction sealant 10 oz cartridge",
    coveragePerPackage: 25,
    unit: "LF",
    wasteFactor: 0.15,
    packageNote: "one cartridge at a 1/2 in joint = ~25 LF",
  },
  "07-wall-insulation": {
    query: "R-13 fiberglass batt insulation",
    coveragePerPackage: 40,
    unit: "SF",
    wasteFactor: 0.1,
    packageNote: "one batt bag = ~40 SF",
  },
  "04-cmu-wall": {
    query: "8 in x 8 in x 16 in concrete block",
    coveragePerPackage: 0.889,
    unit: "SF",
    wasteFactor: 0.05,
    packageNote: "one 8x8x16 block = 0.889 SF of wall",
  },
  "09-gypsum-board": {
    query: "1/2 in drywall sheet 4x8",
    coveragePerPackage: 32,
    unit: "SF",
    wasteFactor: 0.12,
    packageNote: "one 4x8 sheet = 32 SF",
  },
  "09-acoustic-ceiling": {
    // Sold by the case, not the tile. Reading a case price as a single-tile
    // price overstated this by 8x and the plausibility gate caught it.
    query: "acoustic ceiling tile 2x4 lay in case",
    coveragePerPackage: 64,
    unit: "SF",
    wasteFactor: 0.08,
    packageNote: "one case of eight 2x4 tiles = 64 SF",
  },
  "09-painting": {
    query: "interior latex paint 5 gallon",
    coveragePerPackage: 875, // ~1,750 SF one coat, two coats specified
    unit: "SF",
    wasteFactor: 0.08,
    packageNote: "one 5 gal pail at two coats = ~875 SF",
  },
  "09-flooring-vct": {
    query: "luxury vinyl plank flooring case",
    coveragePerPackage: 24,
    unit: "SF",
    wasteFactor: 0.1,
    packageNote: "one case = ~24 SF",
  },
  "09-ceramic-tile": {
    query: "porcelain floor tile case",
    coveragePerPackage: 15,
    unit: "SF",
    wasteFactor: 0.12,
    packageNote: "one case = ~15 SF",
  },
  "08-door-hollow-metal": {
    query: "steel commercial entry door slab with frame",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one door",
  },
  "08-door-wood": {
    query: "solid core wood interior door slab",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one door",
  },
  "08-overhead-door": {
    query: "commercial rolling steel overhead door",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one door",
  },
  "10-lockers": {
    query: "metal storage locker single tier",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one locker",
  },
  "10-fire-extinguisher-cabinet": {
    query: "fire extinguisher cabinet",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one cabinet",
  },
  "22-plumbing-fixture": {
    query: "commercial toilet floor mount",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one fixture",
  },
  "22-water-heater": {
    query: "commercial gas water heater 75 gallon",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one water heater",
  },
  "22-domestic-water-pipe": {
    // Home Depot stocks copper in 5 ft lengths, not 10.
    query: "3/4 in type L copper pipe 5 ft",
    coveragePerPackage: 5,
    unit: "LF",
    wasteFactor: 0.1,
    packageNote: "one 5 ft length",
  },
  "26-lighting-fixture": {
    query: "LED troffer 2x4 commercial",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one fixture",
  },
  "26-branch-circuit": {
    query: "12-2 romex nm-b wire 250 ft",
    coveragePerPackage: 250,
    unit: "LF",
    wasteFactor: 0.15,
    packageNote: "one 250 ft coil",
  },
  "26-panelboard": {
    query: "200 amp main breaker load center panel",
    coveragePerPackage: 1,
    unit: "EA",
    wasteFactor: 0,
    packageNote: "one panelboard",
  },
  "32-chain-link-fence": {
    query: "chain link fence fabric 50 ft roll",
    coveragePerPackage: 50,
    unit: "LF",
    wasteFactor: 0.08,
    packageNote: "one 50 ft roll of fabric",
  },
};

export interface MaterialQuote {
  key: string;
  /** Derived cost per catalog unit, after waste and the retail factor. */
  unitCost: Cents;
  /** What the listing itself charged for one package. */
  packagePrice: Cents;
  coveragePerPackage: number;
  wasteFactor: number;
  retailFactor: number;
  unit: Unit;
  productTitle: string;
  productId: string | null;
  link: string | null;
  query: string;
  packageNote: string;
  fetchedAt: string;
  /** ZIP the listing was priced for; Home Depot prices vary by store. */
  zip: string;
}

export interface PriceLookupResult {
  quotes: Record<string, MaterialQuote>;
  /** Keys that were asked for but could not be sourced, with the reason. */
  unsourced: Array<{ key: string; reason: string }>;
  warnings: string[];
}

export interface HomeDepotOptions {
  apiKey: string;
  /** Store pricing is ZIP-specific. Use the job site ZIP, not the office. */
  zip: string;
  /** Your account discount off retail. 0.75 = you pay 75% of shelf price. */
  retailFactor?: number;
  /** Restrict to these catalog keys; defaults to everything HD_SOURCING covers. */
  keys?: string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; the pipeline is the only place allowed to read a clock. */
  now?: string;
}

interface SerpProduct {
  title?: string;
  price?: number | string;
  product_id?: string | number;
  link?: string;
}

/** SerpApi returns price as a number, occasionally as a "$12.34" string. */
export function parsePrice(raw: unknown): Cents | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return fromDollars(raw);
  }
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    const n = Number.parseFloat(cleaned);
    if (Number.isFinite(n) && n > 0) return fromDollars(n);
  }
  return null;
}

/**
 * Picks the listing to price from.
 *
 * The cheapest result is usually a fitting, a sample or an accessory that
 * matched the words but not the product, and the most expensive is usually a
 * bulk pallet. The median of what came back is a duller but far more stable
 * choice than either, and it does not swing when Home Depot reorders results.
 */
export function chooseListing(
  products: SerpProduct[],
): { product: SerpProduct; price: Cents } | null {
  const priced = products
    .map((p) => ({ product: p, price: parsePrice(p.price) }))
    .filter((x): x is { product: SerpProduct; price: Cents } => x.price !== null)
    .sort((a, b) => a.price - b.price);

  if (priced.length === 0) return null;
  return priced[Math.floor((priced.length - 1) / 2)];
}

async function searchOne(
  rule: SourcingRule,
  key: string,
  opts: HomeDepotOptions,
): Promise<MaterialQuote | { key: string; reason: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL(SERPAPI_ENDPOINT);
  url.searchParams.set("engine", "home_depot");
  url.searchParams.set("q", rule.query);
  url.searchParams.set("delivery_zip", opts.zip);
  url.searchParams.set("api_key", opts.apiKey);

  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    return { key, reason: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { key, reason: `SerpApi ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}` };
  }

  let json: { products?: SerpProduct[]; error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { key, reason: "SerpApi returned a body that is not JSON" };
  }

  if (json.error) return { key, reason: `SerpApi: ${json.error}` };

  const chosen = chooseListing(json.products ?? []);
  if (!chosen) return { key, reason: `no priced listing for "${rule.query}"` };

  const retailFactor = opts.retailFactor ?? 1.0;
  const perUnit =
    (chosen.price / rule.coveragePerPackage) * (1 + rule.wasteFactor) * retailFactor;

  return {
    key,
    unitCost: cents(perUnit),
    packagePrice: chosen.price,
    coveragePerPackage: rule.coveragePerPackage,
    wasteFactor: rule.wasteFactor,
    retailFactor,
    unit: rule.unit,
    productTitle: chosen.product.title ?? "",
    productId: chosen.product.product_id != null ? String(chosen.product.product_id) : null,
    link: chosen.product.link ?? null,
    query: rule.query,
    packageNote: rule.packageNote,
    fetchedAt: opts.now ?? new Date().toISOString(),
    zip: opts.zip,
  };
}

const isQuote = (v: MaterialQuote | { key: string; reason: string }): v is MaterialQuote =>
  "unitCost" in v;

export async function fetchMaterialPrices(
  opts: HomeDepotOptions,
): Promise<PriceLookupResult> {
  const keys = opts.keys ?? Object.keys(HD_SOURCING);
  const quotes: Record<string, MaterialQuote> = {};
  const unsourced: Array<{ key: string; reason: string }> = [];
  const warnings: string[] = [];

  // Sequential on purpose: SerpApi bills per search and rate-limits, and a
  // refresh is a background chore, not something a user waits on.
  for (const key of keys) {
    const rule = HD_SOURCING[key];
    if (!rule) {
      unsourced.push({ key, reason: "not a retail SKU; no Home Depot sourcing rule" });
      continue;
    }
    const result = await searchOne(rule, key, opts);
    if (isQuote(result)) quotes[key] = result;
    else unsourced.push(result);
  }

  const retailFactor = opts.retailFactor ?? 1.0;
  if (retailFactor === 1.0 && Object.keys(quotes).length > 0) {
    warnings.push(
      "Material prices are Home Depot retail at full shelf price. A commercial " +
        "contractor buying through a supply house account typically pays 20–40% less. " +
        "Set retailFactor to your own discount, or replace these with supplier quotes.",
    );
  }

  return { quotes, unsourced, warnings };
}

/**
 * How far a retail quote may sit from the catalog default before it is refused.
 *
 * A search can only return what the store stocks. Ask for 60-mil TPO membrane
 * and Home Depot offers a $128 patch roll, which works out to $0.14 per square
 * foot against a real installed material cost nearer $3.40 — a twenty-fourfold
 * error that would sail into the estimate looking like a bargain. Commercial
 * rolling doors, commercial panelboards and commercial fixtures fail the same
 * way: the query matches an accessory or a residential equivalent.
 *
 * A catalog default is a placeholder, so it cannot adjudicate a 30% difference.
 * It is perfectly good at catching a factor of three, which is what separates
 * "retail is cheaper than my placeholder" from "this is not the product".
 */
const PLAUSIBLE_LOW = 1 / 3;
const PLAUSIBLE_HIGH = 3;

/**
 * Folds quotes into an assumption set, leaving unsourced and implausible keys
 * at their catalog default. Returns a new set; the input is not mutated,
 * because the caller snapshots both.
 */
export function applyMaterialQuotes(
  set: AssumptionSet,
  quotes: Record<string, MaterialQuote>,
): { assumptions: AssumptionSet; applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];

  const material: MaterialRate[] = set.material.map((m) => {
    const q = quotes[m.key];
    if (!q) return m;

    if (q.unit !== m.unit) {
      // Should be impossible given HD_SOURCING carries the unit, but a bad
      // edit here would silently corrupt every estimate that follows.
      skipped.push(`${m.key}: quote unit ${q.unit} does not match catalog unit ${m.unit}`);
      return m;
    }

    const ratio = m.unitCost > 0 ? q.unitCost / m.unitCost : 1;
    if (ratio < PLAUSIBLE_LOW || ratio > PLAUSIBLE_HIGH) {
      skipped.push(
        `${m.key}: retail listing "${q.productTitle}" works out to ` +
          `$${(q.unitCost / 100).toFixed(2)}/${m.unit} against a catalog default of ` +
          `$${(m.unitCost / 100).toFixed(2)}/${m.unit} (${ratio < 1 ? "" : "+"}${((ratio - 1) * 100).toFixed(0)}%). ` +
          `That is too far apart to be a price difference — the search most likely matched ` +
          `an accessory or a residential equivalent rather than the specified product. ` +
          `Keeping the catalog default; enter a supplier quote for this item.`,
      );
      return m;
    }

    applied.push(m.key);
    return { ...m, unitCost: q.unitCost, pricedAsOf: q.fetchedAt.slice(0, 10) };
  });

  return { assumptions: { ...set, material }, applied, skipped };
}
