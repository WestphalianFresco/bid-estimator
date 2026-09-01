import { toDollars, type Cents } from "../money";
import type { BidBandSet, MarketStats } from "../bands";
import type { CompositionSummary, CostSlice } from "../rollups";
import type { EstimateSnapshot, EstimateTotals, PricedEstimate, PricedLine } from "../schema";

/**
 * What an API caller is allowed to see.
 *
 * ## The decision this file encodes
 *
 * A customer of this API is buying **answers**, not the machinery that produces
 * them. The assumption set — labour productivity in hours per unit, material
 * unit costs, the markup schedule — is the entire product. It is what the
 * README calls the contractor's own asset, it took real work to assemble, and a
 * caller who obtained it would no longer need the API at all.
 *
 * So `assumptionsSnapshot` never leaves this process. It is stored, because an
 * estimate that cannot be reproduced is an estimate that cannot be defended in
 * a dispute. It is not published.
 *
 * ## The leak that detail levels exist to control
 *
 * Publishing labour hours alongside quantities is publishing productivity:
 * divide one by the other and you have the rate card, line by line. No clever
 * encoding avoids this — if the caller can see both numbers, they can do the
 * division.
 *
 * That is a real trade, not a bug, so it is made explicit:
 *
 *   `summary` (default) — totals, bid band, cost composition, cross-check.
 *       Enough to answer "what should I bid, and is that sane", which is the
 *       question the product exists to answer. Says nothing about how any
 *       single line was derived.
 *
 *   `lines`             — adds per-item costs, labour hours and match
 *       confidence. Genuinely more useful: it is what an estimator needs in
 *       order to argue with a number. It also lets a determined caller
 *       reconstruct the productivity factors over enough requests. Grant it to
 *       customers you would be willing to hand the rate card to, and price it
 *       accordingly.
 *
 * Neither level exposes material unit costs directly; `lines` gives a material
 * cost per scope item, from which a unit cost falls out if the quantity is
 * known. Same trade, same reasoning.
 *
 * ## Money on the wire
 *
 * Every amount is published twice: `cents` as an integer, which is the
 * authoritative value, and `dollars` beside it for humans reading the JSON.
 * Callers must compute on the integer. A float dollar amount is exactly the
 * drift this codebase keeps cents to avoid, and publishing only the float would
 * push that problem onto every consumer.
 */

export type DetailLevel = "summary" | "lines";

export const DETAIL_LEVELS: readonly DetailLevel[] = ["summary", "lines"];

export const isDetailLevel = (v: unknown): v is DetailLevel =>
  typeof v === "string" && (DETAIL_LEVELS as readonly string[]).includes(v);

/** An amount, published as an authoritative integer plus a readable float. */
export interface Money {
  cents: number;
  dollars: number;
}

const money = (c: Cents): Money => ({ cents: c as number, dollars: toDollars(c) });
const moneyOrNull = (c: Cents | null): Money | null => (c === null ? null : money(c));

// ── Public shapes ───────────────────────────────────────────────────

export interface PublicTotals {
  direct_cost: Money;
  field_overhead: Money;
  field_cost: Money;
  home_office_overhead: Money;
  general_admin: Money;
  cost_before_fee: Money;
  fee: Money;
  insurance: Money;
  contingency: Money;
  cost_before_bond: Money;
  bond_premium: Money;
  bid_price: Money;
}

export interface PublicSlice {
  key: string;
  label: string;
  amount: Money;
  share: number;
}

export interface PublicBand {
  id: string;
  label: string;
  headline: string;
  rationale: string;
  fee_pct: number;
  contingency_pct: number;
  bid_price: Money;
  totals: PublicTotals;
  delta_vs_recommended: Money;
  delta_vs_market: Money | null;
  ratio_vs_market: number | null;
}

export interface PublicMarket {
  comparable_count: number;
  min: Money | null;
  p25: Money | null;
  p50: Money | null;
  p75: Money | null;
  max: Money | null;
  mean: Money | null;
}

export interface PublicComposition {
  by_cost_type: PublicSlice[];
  by_division: PublicSlice[];
  build_up: PublicSlice[];
  direct_cost: Money;
  bid_price: Money;
  per_square_foot: Money | null;
  per_month: Money | null;
  unpriced_line_count: number;
  /** Present only at detail=lines. See the note on productivity above. */
  labor_hours?: number;
}

export interface PublicLine {
  description: string;
  csi_division: string;
  quantity: number;
  unit: string;
  work_type: string;
  labor_cost: Money;
  material_cost: Money;
  equipment_cost: Money;
  subcontract_cost: Money;
  direct_cost: Money;
  labor_hours: number;
  /** How well the catalogue entry actually described this work. */
  match_confidence: string;
  /** Whether the quantity was stated in the document, inferred, or assumed. */
  quantity_confidence: string;
  /**
   * Priced from a real assumption, a system default, or not at all. A caller
   * summing an estimate containing `unpriced` lines is summing an incomplete
   * number, and needs to be told rather than left to discover it.
   */
  basis: PricedLine["basis"];
}

export interface PublicEstimate {
  id: string;
  object: "estimate";
  created_at: string;
  engine_version: string;
  /** Stated in the payload so it cannot be lost on the way to a bid room. */
  accuracy_class: string;
  expected_accuracy: string;
  disclaimer: string;
  project: {
    title: string;
    naics_code: string;
    state: string | null;
    county: string | null;
    gross_square_feet: number | null;
    duration_months: number | null;
    delivery_method: string;
    davis_bacon_applies: boolean;
    bonding_required: boolean;
  };
  totals: PublicTotals;
  bands: PublicBand[];
  band_spread: Money;
  market: PublicMarket;
  composition: PublicComposition;
  cross_check: {
    comparable_count: number;
    p25: Money | null;
    p50: Money | null;
    p75: Money | null;
    verdict: string;
  };
  wage_determination_id: string;
  material_pricing: {
    source: string;
    fetched_at: string | null;
    priced_from_quotes: number;
    unsourced: number;
  };
  /**
   * What the document did not say, and what a human should go and ask. These
   * are the difference between an estimate and a guess, so they are published
   * at every detail level.
   */
  missing_information: string[];
  clarification_questions: string[];
  warnings: string[];
  detail: DetailLevel;
  lines?: PublicLine[];
  /** Layer 3 prose. Absent when the caller asked to skip it. */
  explanation?: string;
}

/**
 * The disclaimer travels *inside* the payload, not only in the docs.
 *
 * A downstream product renders the fields it knows about and drops the rest. If
 * the caveat lives only in a PDF nobody opened, the number reaches a bid room
 * looking like a quote. Putting it in the response means the only way to strip
 * it is deliberately.
 */
const DISCLAIMER =
  "Conceptual (ROM) estimate for bid/no-bid screening. Expected accuracy is " +
  "-20% to +30% (AACE Class 4-5). This is not a detailed bid estimate, not a " +
  "quote, and not a guarantee. Verify independently before submitting a price.";

// ── Converters ──────────────────────────────────────────────────────

function publicTotals(t: EstimateTotals): PublicTotals {
  return {
    direct_cost: money(t.directCost),
    field_overhead: money(t.fieldOverhead),
    field_cost: money(t.fieldCost),
    home_office_overhead: money(t.homeOfficeOverhead),
    general_admin: money(t.generalAdmin),
    cost_before_fee: money(t.costBeforeFee),
    fee: money(t.fee),
    insurance: money(t.insurance),
    contingency: money(t.contingency),
    cost_before_bond: money(t.costBeforeBond),
    bond_premium: money(t.bondPremium),
    bid_price: money(t.bidPrice),
  };
}

const publicSlice = (s: CostSlice): PublicSlice => ({
  key: s.key,
  label: s.label,
  amount: money(s.amount),
  share: s.share,
});

function publicMarket(m: MarketStats): PublicMarket {
  return {
    comparable_count: m.count,
    min: moneyOrNull(m.min),
    p25: moneyOrNull(m.p25),
    p50: moneyOrNull(m.p50),
    p75: moneyOrNull(m.p75),
    max: moneyOrNull(m.max),
    mean: moneyOrNull(m.mean),
  };
}

/**
 * `market.awards` — every individual comparable award — is deliberately not
 * carried over. It is public USAspending data, so it is not secret, but it is
 * bulk data the caller can pull themselves and it would multiply the size of
 * every response. Percentiles are what the verdict rests on.
 */
function publicBands(b: BidBandSet): PublicBand[] {
  return b.bands.map((band) => ({
    id: band.id,
    label: band.label,
    headline: band.headline,
    rationale: band.rationale,
    fee_pct: band.feePct,
    contingency_pct: band.contingencyPct,
    bid_price: money(band.bidPrice),
    totals: publicTotals(band.totals),
    delta_vs_recommended: money(band.deltaVsRecommended),
    delta_vs_market: moneyOrNull(band.deltaVsMarket),
    ratio_vs_market: band.ratioVsMarket,
  }));
}

function publicComposition(c: CompositionSummary, detail: DetailLevel): PublicComposition {
  const out: PublicComposition = {
    by_cost_type: c.byCostType.map(publicSlice),
    by_division: c.byDivision.map(publicSlice),
    build_up: c.buildUp.map(publicSlice),
    direct_cost: money(c.directCost),
    bid_price: money(c.bidPrice),
    per_square_foot: moneyOrNull(c.perSquareFoot),
    per_month: moneyOrNull(c.perMonth),
    unpriced_line_count: c.unpricedCount,
  };
  // Total crew hours over a known floor area is an aggregate productivity
  // figure. Weaker than the per-line version, but the same kind of disclosure,
  // so it follows the same gate.
  if (detail === "lines") out.labor_hours = c.laborHours;
  return out;
}

function publicLine(l: PricedLine): PublicLine {
  return {
    description: l.item.description,
    csi_division: l.item.csi_division,
    quantity: l.item.quantity,
    unit: l.item.unit,
    work_type: l.item.work_type,
    labor_cost: money(l.laborCost),
    material_cost: money(l.materialCost),
    equipment_cost: money(l.equipmentCost),
    subcontract_cost: money(l.subcontractCost),
    direct_cost: money(l.directCost),
    labor_hours: Number(l.labor.reduce((s, x) => s + x.hours, 0).toFixed(2)),
    match_confidence: l.item.match_confidence,
    quantity_confidence: l.item.confidence,
    basis: l.basis,
  };
}

// ── Entry point ─────────────────────────────────────────────────────

export interface SerializeInput {
  snapshot: EstimateSnapshot;
  bands: BidBandSet;
  composition: CompositionSummary;
  explanation?: string;
  detail: DetailLevel;
  /** Pipeline-level warnings, which are not part of the priced estimate. */
  pipelineWarnings?: string[];
  comparablesCaveat?: string | null;
}

/**
 * Builds the response body.
 *
 * Note what is *not* read from the snapshot: `assumptionsSnapshot` and
 * `inputText`. The first is the product. The second is the caller's own
 * solicitation, which can run to hundreds of kilobytes — echoing it back on
 * every read spends their bandwidth telling them something they already know.
 */
export function toPublicEstimate(input: SerializeInput): PublicEstimate {
  const { snapshot, bands, composition, detail } = input;
  const scope = snapshot.scope;
  const est: PricedEstimate = snapshot.estimate;
  const cc = est.crossCheck;
  const mp = snapshot.materialPricing;

  const body: PublicEstimate = {
    id: snapshot.id,
    object: "estimate",
    created_at: snapshot.createdAt,
    engine_version: snapshot.engineVersion,
    accuracy_class: "AACE Class 4-5",
    expected_accuracy: "-20% to +30%",
    disclaimer: DISCLAIMER,
    project: {
      title: scope.project_title,
      naics_code: scope.naics_code,
      state: scope.state,
      county: scope.county,
      gross_square_feet: scope.gross_square_feet,
      duration_months: scope.duration_months,
      delivery_method: scope.delivery_method,
      davis_bacon_applies: scope.davis_bacon_applies,
      bonding_required: scope.bonding_required,
    },
    totals: publicTotals(est.totals),
    bands: publicBands(bands),
    band_spread: money(bands.spread),
    market: publicMarket(bands.market),
    composition: publicComposition(composition, detail),
    cross_check: {
      comparable_count: cc.comparableCount,
      p25: moneyOrNull(cc.p25),
      p50: moneyOrNull(cc.p50),
      p75: moneyOrNull(cc.p75),
      verdict: cc.verdict,
    },
    wage_determination_id: snapshot.wageDeterminationId,
    material_pricing: {
      source: mp.source,
      fetched_at: mp.fetchedAt,
      priced_from_quotes: mp.appliedKeys.length,
      unsourced: mp.unsourcedKeys.length,
    },
    missing_information: scope.missing_information,
    clarification_questions: scope.clarification_questions,
    warnings: [
      ...est.warnings,
      ...(input.pipelineWarnings ?? []),
      ...(input.comparablesCaveat ? [input.comparablesCaveat] : []),
    ],
    detail,
  };

  if (detail === "lines") body.lines = est.lines.map(publicLine);
  if (input.explanation !== undefined) body.explanation = input.explanation;

  return body;
}

/**
 * Guards against the failure this whole file exists to prevent.
 *
 * Called on the way out, in tests and in the create route. Cheap insurance:
 * someone will eventually add a field to the snapshot and pass the snapshot
 * straight through, and the first sign of it should be a failing test rather
 * than a customer noticing our rate card inside their response.
 */
export function assertNoAssumptionsLeaked(body: unknown): void {
  const json = JSON.stringify(body);
  const banned = [
    "assumptionsSnapshot",
    "assumption_key",
    "productivity",
    "hoursPerUnit",
    "hours_per_unit",
    "materialRates",
    "material_rates",
    "markupSchedule",
    "markup_schedule",
    "loadedRate",
    "loaded_rate",
  ];
  const hit = banned.find((k) => json.includes(`"${k}"`));
  if (hit) {
    throw new Error(
      `Refusing to serve a response containing "${hit}": the assumption set is not public. ` +
        `See src/api/serialize.ts.`,
    );
  }
}
