import { describe, expect, it } from "vitest";
import { STARTING_DEFAULTS } from "./assumptions";
import { priceBands } from "./bands";
import { toDollars } from "./money";
import { assertTotalsConsistent } from "./price";
import { RepriceRequestSchema, isUnchanged, repriceEstimate } from "./reprice";
import type { ExtractedScope, ScopeItem } from "./schema";
import { makeFixtureWageTable } from "./data/wage-determinations";

/**
 * The adjustment panel exists so an estimator can overrule a rate they know is
 * wrong. These tests pin the two things that must hold while they do: the
 * arithmetic still runs through the one pricing function, and an untouched
 * field is genuinely untouched.
 */

const item = (over: Partial<ScopeItem> = {}): ScopeItem => ({
  csi_division: "07",
  description: "TPO membrane",
  quantity: 10_000,
  unit: "SF",
  assumption_key: "07-roof-membrane-tpo",
  work_type: "roof_membrane",
  match_confidence: "exact",
  confidence: "stated",
  source_quote: "10,000 SF",
  ...over,
});

const scope = (items: ScopeItem[] = [item()]): ExtractedScope => ({
  project_title: "Test",
  naics_code: "238160",
  psc_code: null,
  state: "MD",
  county: "Baltimore",
  location_quote: "Baltimore County, Maryland",
  gross_square_feet: 10_000,
  duration_months: 2,
  delivery_method: "design_bid_build",
  davis_bacon_applies: false,
  bonding_required: true,
  items,
  missing_information: [],
  clarification_questions: [],
});

const base = (over: Record<string, unknown> = {}) => ({
  scope: scope(),
  assumptions: STARTING_DEFAULTS,
  wages: makeFixtureWageTable("MD", "Baltimore"),
  overrides: {},
  ...over,
});

describe("no overrides", () => {
  it("reproduces the baseline exactly", () => {
    const a = repriceEstimate(base());
    const b = repriceEstimate(base());
    expect(a.estimate.totals).toEqual(b.estimate.totals);
    expect(isUnchanged(a.changed)).toBe(true);
  });

  it("reports nothing changed when a value is set to what it already was", () => {
    const { changed } = repriceEstimate(
      base({ overrides: { quantities: { "0": 10_000 } } }),
    );
    expect(isUnchanged(changed)).toBe(true);
  });
});

describe("quantity override", () => {
  it("scales the line and the bid price with it", () => {
    const before = repriceEstimate(base()).estimate;
    const after = repriceEstimate(
      base({ overrides: { quantities: { "0": 20_000 } } }),
    ).estimate;

    expect(after.lines[0].directCost).toBe(before.lines[0].directCost * 2);
    expect(after.totals.bidPrice).toBeGreaterThan(before.totals.bidPrice);
  });

  it("counts the change", () => {
    const { changed } = repriceEstimate(base({ overrides: { quantities: { "0": 12_000 } } }));
    expect(changed.quantities).toBe(1);
  });

  it("ignores an index that is not in the scope", () => {
    const { changed } = repriceEstimate(base({ overrides: { quantities: { "9": 50 } } }));
    expect(isUnchanged(changed)).toBe(true);
  });
});

describe("material unit cost override", () => {
  it("uses the entered price, in dollars per catalog unit", () => {
    const { estimate, changed } = repriceEstimate(
      base({ overrides: { materialUnitCosts: { "07-roof-membrane-tpo": 2.0 } } }),
    );
    // 10,000 SF at $2.00
    expect(toDollars(estimate.lines[0].materialCost)).toBeCloseTo(20_000, 2);
    expect(changed.materialUnitCosts).toBe(1);
  });

  it("leaves labor alone", () => {
    const before = repriceEstimate(base()).estimate;
    const after = repriceEstimate(
      base({ overrides: { materialUnitCosts: { "07-roof-membrane-tpo": 99 } } }),
    ).estimate;
    expect(after.lines[0].laborCost).toBe(before.lines[0].laborCost);
  });

  it("does not mutate the caller's assumption set", () => {
    const before = STARTING_DEFAULTS.material.find((m) => m.key === "07-roof-membrane-tpo")!.unitCost;
    repriceEstimate(base({ overrides: { materialUnitCosts: { "07-roof-membrane-tpo": 99 } } }));
    expect(
      STARTING_DEFAULTS.material.find((m) => m.key === "07-roof-membrane-tpo")!.unitCost,
    ).toBe(before);
  });
});

describe("wage rate override", () => {
  it("changes labor cost and leaves material alone", () => {
    const before = repriceEstimate(base()).estimate;
    const after = repriceEstimate(
      base({ overrides: { wageRates: { roofer: { baseRate: 60, fringe: 20 } } } }),
    ).estimate;

    expect(after.lines[0].laborCost).not.toBe(before.lines[0].laborCost);
    expect(after.lines[0].materialCost).toBe(before.lines[0].materialCost);
  });

  it("runs the entered base rate through the labor burden", () => {
    const { estimate } = repriceEstimate(
      base({ overrides: { wageRates: { roofer: { baseRate: 100, fringe: 0 } } } }),
    );
    // 100 * (1 + 0.35 burden) + 0 fringe = 135.00/hr loaded
    expect(toDollars(estimate.lines[0].labor[0].loadedRate)).toBeCloseTo(135, 2);
  });

  it("adds fringe on top of the burdened base, not under it", () => {
    const { estimate } = repriceEstimate(
      base({ overrides: { wageRates: { roofer: { baseRate: 100, fringe: 10 } } } }),
    );
    // Fringe is not subject to the burden: 135 + 10, not 110 * 1.35
    expect(toDollars(estimate.lines[0].labor[0].loadedRate)).toBeCloseTo(145, 2);
  });
});

describe("markup override", () => {
  it("re-derives the whole waterfall", () => {
    const before = repriceEstimate(base()).estimate;
    const after = repriceEstimate(base({ overrides: { markups: { feePct: 0.2 } } })).estimate;

    expect(after.totals.directCost).toBe(before.totals.directCost);
    expect(after.totals.fee).toBeGreaterThan(before.totals.fee);
    expect(after.totals.bidPrice).toBeGreaterThan(before.totals.bidPrice);
  });

  it("keeps the bond grossed up on the final amount", () => {
    const { estimate } = repriceEstimate(base({ overrides: { markups: { bondRatePct: 0.03 } } }));
    const ratio = estimate.totals.bondPremium / estimate.totals.bidPrice;
    expect(ratio).toBeCloseTo(0.03, 5);
  });

  it("names which markups moved", () => {
    const { changed } = repriceEstimate(
      base({ overrides: { markups: { feePct: 0.2, contingencyPct: 0.05 } } }),
    );
    expect(changed.markups.sort()).toEqual(["contingencyPct", "feePct"]);
  });

  it("still balances", () => {
    const { estimate } = repriceEstimate(
      base({
        overrides: {
          markups: { feePct: 0.15, contingencyPct: 0.2, bondRatePct: 0.025, laborBurdenPct: 0.5 },
        },
      }),
    );
    expect(() => assertTotalsConsistent(estimate.totals)).not.toThrow();
  });
});

describe("request validation", () => {
  it("rejects a negative quantity", () => {
    const r = RepriceRequestSchema.safeParse(base({ overrides: { quantities: { "0": -1 } } }));
    expect(r.success).toBe(false);
  });

  it("rejects a markup at or above 95%", () => {
    const r = RepriceRequestSchema.safeParse(base({ overrides: { markups: { feePct: 1.5 } } }));
    expect(r.success).toBe(false);
  });

  it("rejects a bond rate of 1, which would divide by zero", () => {
    const r = RepriceRequestSchema.safeParse(
      base({ overrides: { markups: { bondRatePct: 1 } } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects a trade that is not in the trade list", () => {
    const r = RepriceRequestSchema.safeParse(
      base({ overrides: { wageRates: { welder: { baseRate: 50, fringe: 10 } } } }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts an empty override object", () => {
    expect(RepriceRequestSchema.safeParse(base()).success).toBe(true);
  });

  it("accepts one trade without requiring the other fourteen", () => {
    // z.record with an enum key demands every member; the panel only ever sends
    // the trades the estimator actually touched.
    const r = RepriceRequestSchema.safeParse(
      base({ overrides: { wageRates: { roofer: { baseRate: 58, fringe: 15.3 } } } }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a partial markup schedule", () => {
    const r = RepriceRequestSchema.safeParse(base({ overrides: { markups: { feePct: 0.14 } } }));
    expect(r.success).toBe(true);
  });
});

describe("combined adjustments", () => {
  it("applies quantity, material, wage and markup together and stays consistent", () => {
    const { estimate, changed } = repriceEstimate(
      base({
        overrides: {
          quantities: { "0": 12_500 },
          materialUnitCosts: { "07-roof-membrane-tpo": 2.75 },
          wageRates: { roofer: { baseRate: 44, fringe: 17 } },
          markups: { feePct: 0.12 },
        },
      }),
    );

    expect(changed).toMatchObject({
      quantities: 1,
      materialUnitCosts: 1,
      wageRates: 1,
      markups: ["feePct"],
    });
    expect(() => assertTotalsConsistent(estimate.totals)).not.toThrow();
    // 12,500 SF at $2.75
    expect(toDollars(estimate.lines[0].materialCost)).toBeCloseTo(34_375, 2);
  });
});

describe("returned price input", () => {
  /**
   * The report re-derives the bid band and the roll-ups from the merged input.
   * If what comes back here is not the exact thing that was priced, an adjusted
   * report shows a band that disagrees with its own headline figure.
   */
  it("is the merged input the returned estimate was actually priced from", () => {
    const { estimate, input } = repriceEstimate(
      base({
        overrides: {
          quantities: { "0": 12_500 },
          markups: { feePct: 0.11 },
        },
      }),
    );

    expect(input.scope.items[0].quantity).toBe(12_500);
    expect(input.assumptions.markups.feePct).toBe(0.11);

    const bands = priceBands(input);
    const recommended = bands.bands.find((b) => b.id === "recommended")!;
    expect(recommended.bidPrice).toBe(estimate.totals.bidPrice);
    expect(recommended.feePct).toBeCloseTo(0.11, 10);
  });

  it("leaves the caller's own objects untouched", () => {
    const req = base({ overrides: { quantities: { "0": 999 } } });
    repriceEstimate(req);
    expect(req.scope.items[0].quantity).toBe(10_000);
    expect(STARTING_DEFAULTS.markups.feePct).toBe(0.08);
  });
});
