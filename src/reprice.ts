import { z } from "zod";
import { cents, fromDollars } from "./money";
import type { AssumptionSet, MarkupSchedule } from "./assumptions";
import { priceEstimate, type PriceInput } from "./price";
import { ExtractedScopeSchema, TRADES, type PricedEstimate } from "./schema";
import type { WageTable, WageRate } from "./data/wage-determinations";

/**
 * Re-pricing with manual adjustments.
 *
 * The estimator disagrees with a rate — a roofer costs more than the
 * determination says, the light fixtures were quoted at half the retail price,
 * the takeoff missed a hundred square feet. They need to change it and see the
 * bid price move.
 *
 * **The browser still produces no dollar amounts.** It sends inputs — a
 * quantity, a unit cost, a base wage, a markup percentage — and this runs the
 * same Layer 2 function that produced the original figure. That keeps the
 * invariant intact: one code path makes every number in the system, and an
 * adjusted estimate is as reproducible and auditable as an unadjusted one,
 * because the overrides are part of the input record.
 *
 * Nothing here reads a clock, touches the network, or calls a model.
 */

/** Dollar amounts arrive from the client as decimal dollars, not cents. */
const dollars = z.number().finite().min(0).max(10_000_000);
const percent = z.number().finite().min(0).max(0.95);

export const OverridesSchema = z.object({
  /** Scope line index -> quantity. */
  quantities: z.record(z.string(), z.number().finite().min(0).max(100_000_000)).optional(),
  /** Assumption key -> material cost per catalog unit, in dollars. */
  materialUnitCosts: z.record(z.string(), dollars).optional(),
  /**
   * Trade -> Davis-Bacon base rate and fringe, in dollars per hour.
   *
   * partialRecord, not record: with an enum key, `z.record` requires every
   * member to be present, so overriding one trade would fail validation because
   * the other fourteen are absent.
   */
  wageRates: z
    .partialRecord(z.enum(TRADES), z.object({ baseRate: dollars, fringe: dollars }))
    .optional(),
  markups: z
    .object({
      fieldOverheadPct: percent.optional(),
      homeOfficeOverheadPct: percent.optional(),
      generalAdminPct: percent.optional(),
      feePct: percent.optional(),
      insurancePct: percent.optional(),
      contingencyPct: percent.optional(),
      bondRatePct: percent.optional(),
      laborBurdenPct: percent.optional(),
    })
    .optional(),
});
export type Overrides = z.infer<typeof OverridesSchema>;

export const RepriceRequestSchema = z.object({
  scope: ExtractedScopeSchema,
  assumptions: z.custom<AssumptionSet>((v) => typeof v === "object" && v !== null),
  wages: z.custom<WageTable>((v) => typeof v === "object" && v !== null),
  comparables: z.array(z.number().finite()).optional(),
  overrides: OverridesSchema,
});
export type RepriceRequest = z.infer<typeof RepriceRequestSchema>;

export interface RepriceResult {
  estimate: PricedEstimate;
  /**
   * The merged input the estimate was priced from. Returned so the caller can
   * re-derive the bid band from exactly the same figures without rebuilding the
   * override merge, which is the only place the three sources are reconciled.
   */
  input: PriceInput;
  /** Which fields the estimator actually changed, for the audit trail. */
  changed: {
    quantities: number;
    materialUnitCosts: number;
    wageRates: number;
    markups: string[];
  };
}

/** Applies overrides to a scope, assumption set and wage table, then prices. */
export function repriceEstimate(req: RepriceRequest): RepriceResult {
  const o = req.overrides;

  // ── Quantities ────────────────────────────────────────────────────
  let quantityChanges = 0;
  const items = req.scope.items.map((item, i) => {
    const q = o.quantities?.[String(i)];
    if (q === undefined || q === item.quantity) return item;
    quantityChanges++;
    return { ...item, quantity: q };
  });
  const scope = { ...req.scope, items };

  // ── Material unit costs ───────────────────────────────────────────
  let materialChanges = 0;
  const material = req.assumptions.material.map((m) => {
    const d = o.materialUnitCosts?.[m.key];
    if (d === undefined) return m;
    const unitCost = fromDollars(d);
    if (unitCost === m.unitCost) return m;
    materialChanges++;
    return { ...m, unitCost };
  });

  // ── Markups ───────────────────────────────────────────────────────
  const markupChanges: string[] = [];
  const markups: MarkupSchedule = { ...req.assumptions.markups };
  for (const [k, v] of Object.entries(o.markups ?? {})) {
    if (v === undefined) continue;
    const key = k as keyof MarkupSchedule;
    if (markups[key] === v) continue;
    markups[key] = v;
    markupChanges.push(key);
  }

  const assumptions: AssumptionSet = { ...req.assumptions, material, markups };

  // ── Wage rates ────────────────────────────────────────────────────
  let wageChanges = 0;
  const rates: WageTable["rates"] = { ...req.wages.rates };
  for (const [trade, v] of Object.entries(o.wageRates ?? {})) {
    if (!v) continue;
    const t = trade as keyof WageTable["rates"];
    const existing = rates[t];
    const baseRate = fromDollars(v.baseRate);
    const fringe = fromDollars(v.fringe);
    if (existing && existing.baseRate === baseRate && existing.fringe === fringe) continue;
    wageChanges++;
    const next: WageRate = {
      trade: t,
      baseRate,
      fringe,
      classification: existing?.classification ?? `${t} (manually entered)`,
    };
    rates[t] = next;
  }
  const wages: WageTable = { ...req.wages, rates };

  const input: PriceInput = {
    scope,
    assumptions,
    wages,
    comparables: req.comparables?.map((c) => cents(c)),
  };

  const estimate = priceEstimate(input);

  return {
    estimate,
    input,
    changed: {
      quantities: quantityChanges,
      materialUnitCosts: materialChanges,
      wageRates: wageChanges,
      markups: markupChanges,
    },
  };
}

/** True when nothing was actually changed from the baseline. */
export const isUnchanged = (c: RepriceResult["changed"]): boolean =>
  c.quantities === 0 &&
  c.materialUnitCosts === 0 &&
  c.wageRates === 0 &&
  c.markups.length === 0;
