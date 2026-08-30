import { describe, expect, it } from "vitest";
import { STARTING_DEFAULTS, type AssumptionSet } from "./assumptions";
import { cents, fromDollars, grossUp, percentile, toDollars } from "./money";
import { assertTotalsConsistent, priceEstimate } from "./price";
import type { ExtractedScope, ScopeItem } from "./schema";
import { makeFixtureWageTable } from "./data/wage-determinations";

const wages = makeFixtureWageTable();

const item = (over: Partial<ScopeItem> = {}): ScopeItem => ({
  csi_division: "03",
  description: "Slab on grade",
  quantity: 10_000,
  unit: "SF",
  assumption_key: "03-slab-on-grade",
  work_type: "concrete_flatwork",
  match_confidence: "exact",
  confidence: "stated",
  source_quote: "10,000 SF slab on grade",
  ...over,
});

const scope = (items: ScopeItem[], over: Partial<ExtractedScope> = {}): ExtractedScope => ({
  project_title: "Test project",
  naics_code: "236220",
  psc_code: null,
  state: "CA",
  county: "Los Angeles",
  location_quote: "Los Angeles County, California",
  gross_square_feet: 10_000,
  duration_months: 6,
  delivery_method: "design_bid_build",
  davis_bacon_applies: true,
  bonding_required: true,
  items,
  missing_information: [],
  clarification_questions: [],
  ...over,
});

const run = (s: ExtractedScope, a: AssumptionSet = STARTING_DEFAULTS) =>
  priceEstimate({ scope: s, assumptions: a, wages });

describe("bond gross-up", () => {
  it("premium is computed on the final contract amount, not the pre-bond subtotal", () => {
    const base = fromDollars(1_000_000);
    const { total, premium } = grossUp(base, 0.015);

    const naive = fromDollars(15_000);
    expect(premium).toBeGreaterThan(naive);
    expect(toDollars(premium)).toBeCloseTo(15_228.43, 2);
    expect(total).toBe(cents(base + premium));
  });

  it("premium over final total equals the bond rate", () => {
    const { total, premium } = grossUp(fromDollars(2_500_000), 0.02);
    expect(premium / total).toBeCloseTo(0.02, 6);
  });

  it("no premium when bonding is not required", () => {
    const withBond = run(scope([item()]));
    const without = run(scope([item()], { bonding_required: false }));
    expect(without.totals.bondPremium).toBe(0);
    expect(without.totals.bidPrice).toBe(without.totals.costBeforeBond);
    expect(withBond.totals.bidPrice).toBeGreaterThan(without.totals.bidPrice);
  });
});

describe("markup waterfall", () => {
  it("subtotals add up to totals", () => {
    const r = run(scope([item(), item({ csi_division: "26", assumption_key: "26-electrical", quantity: 10_000 })]));
    expect(() => assertTotalsConsistent(r.totals)).not.toThrow();
  });

  it("overhead is applied to the correct base", () => {
    const r = run(scope([item()]));
    const t = r.totals;
    const m = STARTING_DEFAULTS.markups;

    expect(t.fieldOverhead).toBe(cents(t.directCost * m.fieldOverheadPct));
    expect(t.homeOfficeOverhead).toBe(cents(t.fieldCost * m.homeOfficeOverheadPct));
    expect(t.homeOfficeOverhead).not.toBe(cents(t.directCost * m.homeOfficeOverheadPct));
  });

  it("zero scope produces zeros without throwing", () => {
    const r = run(scope([]));
    expect(r.totals.directCost).toBe(0);
    expect(r.totals.bidPrice).toBe(0);
  });
});

describe("unpriced lines", () => {
  it("unknown assumption key marks the line unpriced and warns", () => {
    const r = run(scope([item({ assumption_key: "nonexistent-key" })]));
    expect(r.lines[0].basis).toBe("unpriced");
    expect(r.lines[0].laborCost).toBe(0);
    expect(r.warnings.some((w) => w.includes("UNPRICED"))).toBe(true);
  });

  it("unit mismatch marks the line unpriced instead of converting", () => {
    const r = run(scope([item({ unit: "CY" })]));
    expect(r.lines[0].basis).toBe("unpriced");
    expect(r.warnings.some((w) => w.includes("unit mismatch"))).toBe(true);
  });

  it("uncalibrated assumptions are flagged", () => {
    const r = run(scope([item()]));
    expect(r.lines[0].basis).toBe("system_default");
    expect(r.warnings.some((w) => w.includes("system default"))).toBe(true);
  });

  it("calibrated assumptions do not raise the default warning", () => {
    const calibrated: AssumptionSet = {
      ...STARTING_DEFAULTS,
      calibratedKeys: ["03-slab-on-grade"],
    };
    const r = run(scope([item()]), calibrated);
    expect(r.lines[0].basis).toBe("user_assumption");
    expect(r.warnings.some((w) => w.includes("system default"))).toBe(false);
  });
});

describe("labor", () => {
  it("hours split by crew share and sum to total hours", () => {
    const r = run(scope([item({ quantity: 10_000 })]));
    const total = r.lines[0].labor.reduce((a, l) => a + l.hours, 0);
    expect(total).toBeCloseTo(350, 6);
  });

  it("loaded rate exceeds the determination base rate", () => {
    const r = run(scope([item()]));
    const laborer = r.lines[0].labor.find((l) => l.trade === "laborer")!;
    const raw = wages.rates.laborer!.baseRate;
    expect(laborer.loadedRate).toBeGreaterThan(raw);
  });

  it("missing trade rates produce a warning", () => {
    const noRates = { ...wages, rates: {} };
    const r = priceEstimate({
      scope: scope([item()]),
      assumptions: STARTING_DEFAULTS,
      wages: noRates,
    });
    expect(r.lines[0].laborCost).toBe(0);
    expect(r.warnings.some((w) => w.includes("trades not found"))).toBe(true);
  });
});

describe("cross-check", () => {
  const many = (n: number, dollars: number) =>
    Array.from({ length: n }, () => fromDollars(dollars));

  it("no verdict below the minimum sample size", () => {
    const r = priceEstimate({
      scope: scope([item()]),
      assumptions: STARTING_DEFAULTS,
      wages,
      comparables: many(4, 500_000),
    });
    expect(r.crossCheck.verdict).toBe("insufficient_data");
    expect(r.crossCheck.p50).toBeNull();
  });

  it("below p25 raises an underbid warning", () => {
    const r = priceEstimate({
      scope: scope([item()]),
      assumptions: STARTING_DEFAULTS,
      wages,
      comparables: [
        ...many(5, 50_000_000),
        ...many(5, 80_000_000),
      ],
    });
    expect(r.crossCheck.verdict).toBe("below_range");
    expect(r.warnings.some((w) => w.includes("below the p25"))).toBe(true);
  });

  it("percentiles interpolate linearly", () => {
    const sorted = [100, 200, 300, 400, 500].map((d) => fromDollars(d));
    expect(toDollars(percentile(sorted, 0.5)!)).toBe(300);
    expect(toDollars(percentile(sorted, 0.25)!)).toBe(200);
  });
});

describe("determinism", () => {
  it("identical input produces identical output", () => {
    const s = scope([
      item(),
      item({ csi_division: "26", assumption_key: "26-electrical" }),
      item({ csi_division: "23", assumption_key: "23-hvac" }),
    ]);
    const a = run(s);
    const b = run(s);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("quantity confidence", () => {
  it("assumed quantities are named in the warnings", () => {
    const r = run(scope([item({ confidence: "assumed", description: "Roof area" })]));
    expect(r.warnings.some((w) => w.includes("Roof area"))).toBe(true);
  });
});
