import { describe, expect, it } from "vitest";
import { STARTING_DEFAULTS, type AssumptionSet } from "./assumptions";
import { POSTURES, priceBands, summarizeMarket } from "./bands";
import { fromDollars, type Cents } from "./money";
import { priceEstimate, type PriceInput } from "./price";
import { summarizeComposition } from "./rollups";
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

const roofScope = scope([
  item(),
  item({
    csi_division: "09",
    description: "Interior repaint",
    quantity: 24_000,
    assumption_key: "09-painting",
    work_type: "painting",
  }),
]);

const input = (over: Partial<PriceInput> = {}): PriceInput => ({
  scope: roofScope,
  assumptions: STARTING_DEFAULTS,
  wages,
  ...over,
});

const byId = (id: string) => (b: { id: string }) => b.id === id;

describe("bid band", () => {
  it("prices the recommended column to exactly the headline estimate", () => {
    const i = input();
    const headline = priceEstimate(i);
    const { bands } = priceBands(i);

    const recommended = bands.find(byId("recommended"))!;
    // Not "close to" — the report shows one number in two places and a reader
    // who spots a cent of difference stops trusting the whole document.
    expect(recommended.bidPrice).toBe(headline.totals.bidPrice);
    expect(recommended.totals).toEqual(headline.totals);
  });

  it("moves only fee and contingency; every cost line is identical", () => {
    const { bands } = priceBands(input());

    const first = bands[0].totals;
    for (const b of bands) {
      expect(b.totals.directCost).toBe(first.directCost);
      expect(b.totals.fieldOverhead).toBe(first.fieldOverhead);
      expect(b.totals.fieldCost).toBe(first.fieldCost);
      expect(b.totals.homeOfficeOverhead).toBe(first.homeOfficeOverhead);
      expect(b.totals.generalAdmin).toBe(first.generalAdmin);
      expect(b.totals.costBeforeFee).toBe(first.costBeforeFee);
      expect(b.totals.insurance).toBe(first.insurance);
    }
  });

  it("orders aggressive below recommended below conservative", () => {
    const { bands, spread } = priceBands(input());

    expect(bands.map((b) => b.id)).toEqual([
      "aggressive",
      "recommended",
      "conservative",
    ]);
    expect(bands[0].bidPrice).toBeLessThan(bands[1].bidPrice);
    expect(bands[1].bidPrice).toBeLessThan(bands[2].bidPrice);
    expect(spread).toBe(bands[2].bidPrice - bands[0].bidPrice);
  });

  it("scales with the estimator's own schedule rather than a hardcoded rate", () => {
    // A contractor who works at a 4% fee should get a band centred on 4%, not
    // on whatever number the default schedule happens to carry.
    const thin: AssumptionSet = {
      ...STARTING_DEFAULTS,
      markups: { ...STARTING_DEFAULTS.markups, feePct: 0.04, contingencyPct: 0.05 },
    };
    const { bands } = priceBands(input({ assumptions: thin }));

    expect(bands.find(byId("recommended"))!.feePct).toBeCloseTo(0.04, 10);
    expect(bands.find(byId("aggressive"))!.feePct).toBeCloseTo(0.02, 10);
    expect(bands.find(byId("conservative"))!.feePct).toBeCloseTo(0.06, 10);
    expect(bands.find(byId("conservative"))!.contingencyPct).toBeCloseTo(0.09, 10);
  });

  it("clamps a scaled percentage below 1 so the roll-up stays finite", () => {
    // 0.6 contingency x the conservative factor of 1.8 is 1.08 — a markup rate
    // at or above 1 is meaningless, and the bond gross-up rejects it outright.
    const heavy: AssumptionSet = {
      ...STARTING_DEFAULTS,
      markups: { ...STARTING_DEFAULTS.markups, contingencyPct: 0.6 },
    };
    const { bands } = priceBands(input({ assumptions: heavy }));

    const conservative = bands.find(byId("conservative"))!;
    expect(conservative.contingencyPct).toBe(0.95);
    expect(Number.isFinite(conservative.bidPrice)).toBe(true);
  });

  it("reports each posture against the local median, and omits it when absent", () => {
    const comparables = [1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6].map((m) =>
      fromDollars(m * 1_000_000),
    );
    const withMarket = priceBands(input({ comparables }));
    const withoutMarket = priceBands(input({ comparables: [] }));

    const median = withMarket.market.p50!;
    expect(median).toBe(fromDollars(2_000_000));

    for (const b of withMarket.bands) {
      expect(b.deltaVsMarket).toBe(b.bidPrice - median);
      expect(b.ratioVsMarket).toBeCloseTo(b.bidPrice / median, 10);
    }
    for (const b of withoutMarket.bands) {
      expect(b.deltaVsMarket).toBeNull();
      expect(b.ratioVsMarket).toBeNull();
    }
  });

  it("keeps the recommended posture a true no-op on the schedule", () => {
    const recommended = POSTURES.find(byId("recommended"))!;
    expect(recommended.feeFactor).toBe(1);
    expect(recommended.contingencyFactor).toBe(1);
  });
});

describe("market summary", () => {
  it("refuses to publish percentiles from too few awards", () => {
    const four = [1, 2, 3, 4].map((m) => fromDollars(m * 1_000_000));
    const m = summarizeMarket(four);

    expect(m.count).toBe(4);
    expect(m.p25).toBeNull();
    expect(m.p50).toBeNull();
    expect(m.p75).toBeNull();
    expect(m.mean).toBeNull();
    // The awards themselves survive — the chart can still plot them.
    expect(m.awards).toHaveLength(4);
  });

  it("sorts, and computes the mean and quartiles once there are five", () => {
    const unsorted = [5, 1, 3, 2, 4].map((m) => fromDollars(m * 1_000_000));
    const m = summarizeMarket(unsorted);

    expect(m.awards).toEqual([...m.awards].sort((a, b) => a - b));
    expect(m.min).toBe(fromDollars(1_000_000));
    expect(m.max).toBe(fromDollars(5_000_000));
    expect(m.p50).toBe(fromDollars(3_000_000));
    expect(m.mean).toBe(fromDollars(3_000_000));
  });
});

describe("report roll-ups", () => {
  const estimate = priceEstimate(input());
  const composition = summarizeComposition(estimate, roofScope);

  it("splits the bid price into parts that sum back to it exactly", () => {
    const sum = composition.buildUp.reduce((a, s) => a + s.amount, 0);
    expect(sum).toBe(estimate.totals.bidPrice);
    expect(composition.bidPrice).toBe(estimate.totals.bidPrice);
  });

  it("splits direct cost by type and by division, both summing to direct cost", () => {
    const byType = composition.byCostType.reduce((a, s) => a + s.amount, 0);
    const byDivision = composition.byDivision.reduce((a, s) => a + s.amount, 0);

    expect(byType).toBe(estimate.totals.directCost);
    expect(byDivision).toBe(estimate.totals.directCost);
    expect(composition.directCost).toBe(estimate.totals.directCost);
  });

  it("orders divisions largest first and shares them against direct cost", () => {
    const amounts = composition.byDivision.map((s) => s.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));

    const shareSum = composition.byDivision.reduce((a, s) => a + s.share, 0);
    expect(shareSum).toBeCloseTo(1, 6);
  });

  it("drops slices worth nothing rather than plotting an empty segment", () => {
    // This engine prices no equipment or subcontract, so neither should appear.
    expect(composition.byCostType.map((s) => s.key)).toEqual(["labor", "material"]);
  });

  it("omits unit costs the solicitation gave no basis for", () => {
    const noMetrics = scope([item()], { gross_square_feet: null, duration_months: null });
    const bare = summarizeComposition(priceEstimate(input({ scope: noMetrics })), noMetrics);

    expect(bare.perSquareFoot).toBeNull();
    expect(bare.perMonth).toBeNull();
  });

  it("derives per-unit costs from the bid price when the basis is stated", () => {
    const perSf = composition.perSquareFoot as Cents;
    expect(perSf).toBeGreaterThan(0);
    // 10,000 SF stated on the fixture scope.
    expect(perSf).toBe(Math.round(estimate.totals.bidPrice / 10_000));
  });
});
