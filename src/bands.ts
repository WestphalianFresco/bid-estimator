import { add, percentile, scale, sub, type Cents } from "./money";
import { priceEstimate, type PriceInput } from "./price";
import type { EstimateTotals } from "./schema";

/**
 * The bid band — one estimate, three commercial postures.
 *
 * An estimator does not walk into a bid room with a single number. They walk in
 * with a floor, a target and a ceiling, and the decision of where inside that
 * band to land is commercial, not technical. This module produces that band.
 *
 * **The cost does not move.** Direct cost, field overhead, home office, G&A,
 * insurance and the bond schedule are identical across all three; the takeoff
 * and the wage determination do not change because the estimator feels
 * differently about the job. Only the two levers that are genuinely a choice
 * move:
 *
 *   - **Fee** — what you are willing to make on the work.
 *   - **Contingency** — how much unknown you are willing to carry yourself.
 *
 * That restriction is the whole point. A "low bid" produced by quietly shaving
 * quantities or wage rates is not a low bid, it is a wrong estimate, and it is
 * exactly how contractors lose money on work they won. Here the low number is
 * the same estimate at a thinner margin and a thinner risk allowance, and the
 * report says so in those words.
 *
 * Every figure is produced by `priceEstimate` — the same Layer 2 function that
 * produced the headline number — so the band is as reproducible and auditable
 * as the estimate it brackets. Nothing here reads a clock or touches the
 * network.
 */

export type BidPosture = "aggressive" | "recommended" | "conservative";

export interface PostureSpec {
  id: BidPosture;
  /** Column label in the report. */
  label: string;
  /** One line the client can read without knowing what a markup schedule is. */
  headline: string;
  /** What the contractor is accepting by bidding here. */
  rationale: string;
  /** Multiplier applied to the estimate's own fee percentage. */
  feeFactor: number;
  /** Multiplier applied to the estimate's own contingency percentage. */
  contingencyFactor: number;
}

/**
 * Factors, not absolute percentages.
 *
 * A contractor who has calibrated their fee to 6% because that is what their
 * market bears should get a band centred on 6%, not on whatever number was
 * hardcoded here. The band scales with the schedule the estimate actually used,
 * including any markup the estimator overrode by hand.
 */
export const POSTURES: readonly PostureSpec[] = [
  {
    id: "aggressive",
    label: "Aggressive",
    headline: "Priced to win",
    rationale:
      "Half the usual fee and half the usual contingency — a bid to keep crews working. " +
      "Every unknown that surfaces after award comes out of margin.",
    feeFactor: 0.5,
    contingencyFactor: 0.5,
  },
  {
    id: "recommended",
    label: "Recommended",
    headline: "The balanced position",
    rationale:
      "The contractor's own fee and contingency schedule, unchanged. Use this unless there " +
      "is a reason to move.",
    feeFactor: 1,
    contingencyFactor: 1,
  },
  {
    id: "conservative",
    label: "Conservative",
    headline: "Priced to absorb surprises",
    rationale:
      "Fee up by half, contingency up by four-fifths. For loosely written scope, an unseen " +
      "site, a compressed schedule, or inferred quantities.",
    feeFactor: 1.5,
    contingencyFactor: 1.8,
  },
] as const;

/** A markup percentage is a rate applied to a running total; it cannot reach 1. */
const clampPct = (v: number) => Math.min(Math.max(v, 0), 0.95);

export interface BidBand {
  id: BidPosture;
  label: string;
  headline: string;
  rationale: string;
  /** The effective rates this column was priced at. */
  feePct: number;
  contingencyPct: number;
  totals: EstimateTotals;
  bidPrice: Cents;
  /** Signed difference against the recommended column. */
  deltaVsRecommended: Cents;
  /** Signed difference against the local median award; null when unavailable. */
  deltaVsMarket: Cents | null;
  /** bidPrice / local median, e.g. 1.08 = eight percent above. */
  ratioVsMarket: number | null;
}

/**
 * What comparable local awards actually looked like.
 *
 * Computed here rather than in the browser for the same reason every other
 * amount is: the client renders figures, it does not derive them.
 */
export interface MarketStats {
  count: number;
  min: Cents | null;
  p25: Cents | null;
  p50: Cents | null;
  p75: Cents | null;
  max: Cents | null;
  mean: Cents | null;
  /** Every comparable award, sorted, so the report can plot the distribution. */
  awards: Cents[];
}

export interface BidBandSet {
  bands: BidBand[];
  market: MarketStats;
  /** Conservative minus aggressive — the width of the commercial decision. */
  spread: Cents;
}

/**
 * Percentiles need enough points to mean anything.
 *
 * Five is the same threshold the cross-check uses; keeping them equal means the
 * chart and the verdict paragraph can never disagree about whether there was a
 * market to compare against.
 */
const MIN_COMPARABLES = 5;

export function summarizeMarket(comparables: readonly Cents[]): MarketStats {
  const sorted = [...comparables].sort((a, b) => a - b);
  if (sorted.length < MIN_COMPARABLES) {
    return {
      count: sorted.length,
      min: null,
      p25: null,
      p50: null,
      p75: null,
      max: null,
      mean: null,
      awards: sorted,
    };
  }
  return {
    count: sorted.length,
    min: sorted[0],
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1],
    mean: scale(add(...sorted), 1 / sorted.length),
    awards: sorted,
  };
}

/**
 * Prices the same scope at three commercial postures.
 *
 * Takes the identical `PriceInput` that produced the headline estimate, so the
 * recommended column is guaranteed to equal it to the cent.
 */
export function priceBands(input: PriceInput): BidBandSet {
  const market = summarizeMarket(input.comparables ?? []);
  const base = input.assumptions.markups;

  const priced = POSTURES.map((p) => {
    const feePct = clampPct(base.feePct * p.feeFactor);
    const contingencyPct = clampPct(base.contingencyPct * p.contingencyFactor);
    const estimate = priceEstimate({
      ...input,
      assumptions: {
        ...input.assumptions,
        markups: { ...base, feePct, contingencyPct },
      },
    });
    return { spec: p, feePct, contingencyPct, totals: estimate.totals };
  });

  const recommended = priced.find((b) => b.spec.id === "recommended")!;

  const bands: BidBand[] = priced.map((b) => ({
    id: b.spec.id,
    label: b.spec.label,
    headline: b.spec.headline,
    rationale: b.spec.rationale,
    feePct: b.feePct,
    contingencyPct: b.contingencyPct,
    totals: b.totals,
    bidPrice: b.totals.bidPrice,
    deltaVsRecommended: sub(b.totals.bidPrice, recommended.totals.bidPrice),
    deltaVsMarket: market.p50 === null ? null : sub(b.totals.bidPrice, market.p50),
    ratioVsMarket:
      market.p50 === null || market.p50 === 0 ? null : b.totals.bidPrice / market.p50,
  }));

  const lo = bands[0].bidPrice;
  const hi = bands[bands.length - 1].bidPrice;

  return { bands, market, spread: sub(hi, lo) };
}

/** Zero-comparable placeholder, for the paths where no estimate ran. */
export const EMPTY_MARKET: MarketStats = {
  count: 0,
  min: null,
  p25: null,
  p50: null,
  p75: null,
  max: null,
  mean: null,
  awards: [],
};
