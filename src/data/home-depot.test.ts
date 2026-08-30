import { describe, expect, it } from "vitest";
import { STARTING_DEFAULTS, findMaterial, validateAssumptions } from "../assumptions";
import { cents, toDollars } from "../money";
import {
  HD_SOURCING,
  applyMaterialQuotes,
  chooseListing,
  fetchMaterialPrices,
  parsePrice,
  type MaterialQuote,
} from "./home-depot";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
  apiKey: "test-key",
  zip: "21201",
  now: "2026-08-22T00:00:00Z",
  fetchImpl,
  ...over,
});

describe("sourcing rules", () => {
  it("only maps keys that exist in the catalog", () => {
    for (const key of Object.keys(HD_SOURCING)) {
      expect(findMaterial(STARTING_DEFAULTS, key), `${key} missing from catalog`).toBeDefined();
    }
  });

  it("declares the same unit the catalog uses", () => {
    for (const [key, rule] of Object.entries(HD_SOURCING)) {
      expect(rule.unit, `${key} unit mismatch`).toBe(findMaterial(STARTING_DEFAULTS, key)!.unit);
    }
  });

  it("leaves non-retail items alone", () => {
    // Ready-mix by the yard, fabricated steel, elevators and commercial rooftop
    // units are not Home Depot SKUs; force-fitting them would be worse than a
    // visibly uncalibrated default.
    for (const key of ["03-footings", "05-structural-steel", "14-elevator-modernization", "23-rtu-replacement", "33-site-sewer-line"]) {
      expect(HD_SOURCING[key], `${key} should not be retail-sourced`).toBeUndefined();
    }
  });

  it("uses a positive coverage and a sane waste factor", () => {
    for (const [key, rule] of Object.entries(HD_SOURCING)) {
      expect(rule.coveragePerPackage, key).toBeGreaterThan(0);
      expect(rule.wasteFactor, key).toBeGreaterThanOrEqual(0);
      expect(rule.wasteFactor, key).toBeLessThan(0.5);
    }
  });
});

describe("parsePrice", () => {
  it("takes numbers and dollar strings", () => {
    expect(parsePrice(12.34)).toBe(1234);
    expect(parsePrice("$1,299.00")).toBe(129900);
  });

  it("rejects zero, negatives and junk", () => {
    expect(parsePrice(0)).toBeNull();
    expect(parsePrice(-5)).toBeNull();
    expect(parsePrice("call for pricing")).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });
});

describe("chooseListing", () => {
  it("takes the median so an accessory or a bulk pallet cannot set the price", () => {
    const chosen = chooseListing([
      { title: "sample swatch", price: 2 },
      { title: "the actual product", price: 48 },
      { title: "bulk pallet", price: 1900 },
    ]);
    expect(chosen?.product.title).toBe("the actual product");
  });

  it("ignores unpriced results", () => {
    const chosen = chooseListing([
      { title: "no price" },
      { title: "priced", price: 30 },
    ]);
    expect(chosen?.product.title).toBe("priced");
  });

  it("returns null when nothing is priced", () => {
    expect(chooseListing([{ title: "nothing" }])).toBeNull();
    expect(chooseListing([])).toBeNull();
  });
});

describe("fetchMaterialPrices", () => {
  it("derives a per-unit cost from the package price, coverage and waste", async () => {
    // 4x8 polyiso board covering 32 SF, 8% waste, no discount.
    const fetchImpl = (async () =>
      json({ products: [{ title: "Polyiso 4x8", price: 64, product_id: "1" }] })) as typeof fetch;

    const { quotes } = await fetchMaterialPrices(
      opts(fetchImpl, { keys: ["07-roof-insulation"] }),
    );
    const q = quotes["07-roof-insulation"];

    // 64 / 32 * 1.08 = 2.16
    expect(toDollars(q.unitCost)).toBeCloseTo(2.16, 2);
    expect(toDollars(q.packagePrice)).toBe(64);
    expect(q.zip).toBe("21201");
    expect(q.fetchedAt).toBe("2026-08-22T00:00:00Z");
  });

  it("applies the retail factor so an account discount can be modelled", async () => {
    const fetchImpl = (async () =>
      json({ products: [{ title: "Polyiso 4x8", price: 64 }] })) as typeof fetch;

    const { quotes } = await fetchMaterialPrices(
      opts(fetchImpl, { keys: ["07-roof-insulation"], retailFactor: 0.7 }),
    );
    // 64 / 32 * 1.08 * 0.7 = 1.512
    expect(toDollars(quotes["07-roof-insulation"].unitCost)).toBeCloseTo(1.51, 2);
  });

  it("warns when retail is taken at full shelf price", async () => {
    const fetchImpl = (async () => json({ products: [{ price: 64 }] })) as typeof fetch;
    const { warnings } = await fetchMaterialPrices(
      opts(fetchImpl, { keys: ["07-roof-insulation"] }),
    );
    expect(warnings.join(" ")).toMatch(/20–40% less|supply house/i);
  });

  it("reports keys with no sourcing rule instead of guessing", async () => {
    const fetchImpl = (async () => json({ products: [] })) as typeof fetch;
    const { quotes, unsourced } = await fetchMaterialPrices(
      opts(fetchImpl, { keys: ["05-structural-steel"] }),
    );
    expect(quotes).toEqual({});
    expect(unsourced[0]).toMatchObject({ key: "05-structural-steel" });
    expect(unsourced[0].reason).toMatch(/not a retail SKU/i);
  });

  it("degrades to unsourced on an API error rather than throwing", async () => {
    const fetchImpl = (async () => json({ error: "Invalid API key" }, 401)) as typeof fetch;
    const { quotes, unsourced } = await fetchMaterialPrices(
      opts(fetchImpl, { keys: ["07-roof-insulation"] }),
    );
    expect(quotes).toEqual({});
    expect(unsourced[0].reason).toMatch(/401/);
  });

  it("degrades to unsourced when the search returns nothing priced", async () => {
    const fetchImpl = (async () => json({ products: [{ title: "no price" }] })) as typeof fetch;
    const { unsourced } = await fetchMaterialPrices(
      opts(fetchImpl, { keys: ["07-roof-insulation"] }),
    );
    expect(unsourced[0].reason).toMatch(/no priced listing/i);
  });
});

describe("applyMaterialQuotes", () => {
  const quote = (over: Partial<MaterialQuote> = {}): MaterialQuote => ({
    key: "07-roof-insulation",
    unitCost: cents(216),
    packagePrice: cents(6400),
    coveragePerPackage: 32,
    wasteFactor: 0.08,
    retailFactor: 1,
    unit: "SF",
    productTitle: "Polyiso 4x8",
    productId: "1",
    link: null,
    query: "polyiso",
    packageNote: "4x8 board",
    fetchedAt: "2026-08-22T00:00:00Z",
    zip: "21201",
    ...over,
  });

  it("replaces the sourced rate and dates it", () => {
    const { assumptions, applied } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "07-roof-insulation": quote(),
    });
    const m = findMaterial(assumptions, "07-roof-insulation")!;
    expect(m.unitCost).toBe(216);
    expect(m.pricedAsOf).toBe("2026-08-22");
    expect(applied).toEqual(["07-roof-insulation"]);
  });

  it("leaves every other rate untouched", () => {
    const { assumptions } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "07-roof-insulation": quote(),
    });
    expect(findMaterial(assumptions, "05-structural-steel")!.unitCost).toBe(
      findMaterial(STARTING_DEFAULTS, "05-structural-steel")!.unitCost,
    );
  });

  it("does not mutate the input set", () => {
    const before = findMaterial(STARTING_DEFAULTS, "07-roof-insulation")!.unitCost;
    applyMaterialQuotes(STARTING_DEFAULTS, { "07-roof-insulation": quote() });
    expect(findMaterial(STARTING_DEFAULTS, "07-roof-insulation")!.unitCost).toBe(before);
  });

  it("refuses a quote whose unit disagrees with the catalog", () => {
    const { assumptions, applied, skipped } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "07-roof-insulation": quote({ unit: "LF" }),
    });
    expect(applied).toEqual([]);
    expect(skipped[0]).toMatch(/does not match catalog unit/i);
    expect(findMaterial(assumptions, "07-roof-insulation")!.unitCost).toBe(
      findMaterial(STARTING_DEFAULTS, "07-roof-insulation")!.unitCost,
    );
  });

  it("refuses a listing that is an order of magnitude off the catalog", () => {
    // The real failure: a $128 TPO patch roll read as a 1,000 SF commercial roll
    // gives $0.14/SF against a $3.40 catalog default.
    const { assumptions, applied, skipped } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "07-roof-membrane-tpo": quote({ key: "07-roof-membrane-tpo", unitCost: cents(14) }),
    });
    expect(applied).toEqual([]);
    expect(skipped[0]).toMatch(/too far apart to be a price difference/i);
    expect(findMaterial(assumptions, "07-roof-membrane-tpo")!.unitCost).toBe(
      findMaterial(STARTING_DEFAULTS, "07-roof-membrane-tpo")!.unitCost,
    );
  });

  it("refuses a listing far above the catalog too", () => {
    const { applied, skipped } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "09-acoustic-ceiling": quote({ key: "09-acoustic-ceiling", unitCost: cents(1603) }),
    });
    expect(applied).toEqual([]);
    expect(skipped[0]).toMatch(/\+417%|too far apart/i);
  });

  it("accepts a difference that is merely a good price", () => {
    const cat = findMaterial(STARTING_DEFAULTS, "09-gypsum-board")!.unitCost;
    const { applied } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "09-gypsum-board": quote({ key: "09-gypsum-board", unit: "SF", unitCost: cents(Math.round(cat * 0.5)) }),
    });
    expect(applied).toEqual(["09-gypsum-board"]);
  });

  it("produces a set that still validates", () => {
    const { assumptions } = applyMaterialQuotes(STARTING_DEFAULTS, {
      "07-roof-insulation": quote(),
    });
    expect(validateAssumptions(assumptions)).toEqual([]);
  });
});
