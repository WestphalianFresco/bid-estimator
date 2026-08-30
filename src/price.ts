import {
  add,
  cents,
  formatUSD,
  grossUp,
  markup,
  percentile,
  scale,
  sub,
  type Cents,
} from "./money";
import {
  findMaterial,
  findProductivity,
  isCalibrated,
  type AssumptionSet,
} from "./assumptions";
import type {
  CrossCheck,
  EstimateTotals,
  ExtractedScope,
  LaborLine,
  PricedEstimate,
  PricedLine,
  ScopeItem,
  Trade,
} from "./schema";
import { loadedRate, type WageTable } from "./data/wage-determinations";

export const ENGINE_VERSION = "1.0.0";

export interface PriceInput {
  scope: ExtractedScope;
  assumptions: AssumptionSet;
  wages: WageTable;
  escalation?: Record<string, number>;
  equipment?: Record<string, Cents>;
  subcontract?: Record<string, Cents>;
  comparables?: Cents[];
}

const ZERO = cents(0);

function priceLine(
  item: ScopeItem,
  input: PriceInput,
  warnings: string[],
): PricedLine {
  const { assumptions, wages, escalation = {}, equipment = {}, subcontract = {} } = input;
  const key = item.assumption_key;

  const empty = (basis: PricedLine["basis"]): PricedLine => ({
    item,
    labor: [],
    laborCost: ZERO,
    materialCost: ZERO,
    equipmentCost: equipment[key] ?? ZERO,
    subcontractCost: subcontract[key] ?? ZERO,
    directCost: add(equipment[key] ?? ZERO, subcontract[key] ?? ZERO),
    basis,
  });

  const prod = findProductivity(assumptions, key);

  if (!prod) {
    warnings.push(
      `[UNPRICED] "${item.description}" has no productivity assumption (key: ${key}). ` +
        `Labor and material for this line are excluded from the total.`,
    );
    return empty("unpriced");
  }

  // ── Match confidence gate ──────────────────────────────────────────
  //
  // A missing rate returning zero is loud. A wrong rate returning a plausible
  // number is silent, and it is the more expensive failure: a 120 LF baseboard
  // run priced off the casework rate came to $50,603 — $422 per linear foot,
  // half the direct cost of the job — and nothing rejected it, because the unit
  // (LF) and the CSI division (06) both agreed.
  //
  // So the engine declines rather than approximates. An unpriced line the
  // estimator has to fill in costs them five minutes; a confident wrong number
  // they do not notice costs them the job.

  if (item.match_confidence === "loose") {
    warnings.push(
      `[UNPRICED] "${item.description}": no rate in the catalog describes this work. ` +
        `Extraction reported the closest key as "${key}" (${prod.label}) but flagged the ` +
        `match as loose, so the engine declined to price it. Add a rate for ` +
        `${item.work_type.replace(/_/g, " ")} measured in ${item.unit}, or enter a price for ` +
        `this line manually.`,
    );
    return empty("unpriced");
  }

  if (prod.workType !== item.work_type) {
    warnings.push(
      `[UNPRICED] "${item.description}" work-type mismatch: the line is ` +
        `${item.work_type.replace(/_/g, " ")}, but "${key}" (${prod.label}) prices ` +
        `${prod.workType.replace(/_/g, " ")}. Matching units do not make these the same ` +
        `work. Add a rate for ${item.work_type.replace(/_/g, " ")}, or price this line manually.`,
    );
    return empty("unpriced");
  }

  if (prod.unit !== item.unit) {
    warnings.push(
      `[UNPRICED] "${item.description}" unit mismatch: scope is ${item.unit}, ` +
        `assumption is ${prod.unit}. The engine does not convert units.`,
    );
    return empty("unpriced");
  }

  // Division is advisory — countertops sit in Div 06 or Div 12 depending on who
  // is writing — so a disagreement is worth surfacing but not worth refusing.
  if (prod.csiDivision !== item.csi_division) {
    warnings.push(
      `"${item.description}" is filed under Div ${item.csi_division} but "${key}" is a ` +
        `Div ${prod.csiDivision} rate. Priced anyway; check that this is the intended rate.`,
    );
  }

  if (item.match_confidence === "close") {
    warnings.push(
      `"${item.description}" was priced off "${key}" (${prod.label}), which extraction ` +
        `judged a close but inexact match. Confirm the rate before relying on this line.`,
    );
  }

  const totalHours = item.quantity * prod.hoursPerUnit;
  const labor: LaborLine[] = [];
  const missingTrades: Trade[] = [];

  for (const mix of prod.crew) {
    const rate = wages.rates[mix.trade];
    if (!rate) {
      missingTrades.push(mix.trade);
      continue;
    }
    const hours = totalHours * mix.share;
    const loaded = loadedRate(rate, assumptions.markups.laborBurdenPct);
    labor.push({
      trade: mix.trade,
      hours,
      loadedRate: loaded,
      cost: scale(loaded, hours),
    });
  }

  if (missingTrades.length > 0) {
    warnings.push(
      `"${item.description}": trades not found in wage determination ` +
        `${wages.determinationId} for ${wages.county ?? wages.state}: ` +
        `${missingTrades.join(", ")}. Those hours are unpriced.`,
    );
  }

  const laborCost = add(...labor.map((l) => l.cost));

  const mat = findMaterial(assumptions, key);
  let materialCost = ZERO;
  if (mat) {
    if (mat.unit !== item.unit) {
      warnings.push(
        `"${item.description}": material unit ${mat.unit} does not match scope unit ${item.unit}; material excluded.`,
      );
    } else {
      const factor = escalation[key] ?? 1.0;
      materialCost = scale(mat.unitCost, item.quantity * factor);
    }
  } else {
    warnings.push(
      `"${item.description}" has no material rate (key: ${key}). ` +
        `Ignore if labor-only; otherwise the total is understated.`,
    );
  }

  const equipmentCost = equipment[key] ?? ZERO;
  const subcontractCost = subcontract[key] ?? ZERO;

  return {
    item,
    labor,
    laborCost,
    materialCost,
    equipmentCost,
    subcontractCost,
    directCost: add(laborCost, materialCost, equipmentCost, subcontractCost),
    basis: isCalibrated(assumptions, key) ? "user_assumption" : "system_default",
  };
}

function rollUp(
  directCost: Cents,
  m: AssumptionSet["markups"],
  bondingRequired: boolean,
): EstimateTotals {
  const fieldOverhead = markup(directCost, m.fieldOverheadPct);
  const fieldCost = add(directCost, fieldOverhead);

  const homeOfficeOverhead = markup(fieldCost, m.homeOfficeOverheadPct);
  const generalAdmin = markup(fieldCost, m.generalAdminPct);
  const costBeforeFee = add(fieldCost, homeOfficeOverhead, generalAdmin);

  const fee = markup(costBeforeFee, m.feePct);
  const insurance = markup(costBeforeFee, m.insurancePct);
  const contingency = markup(costBeforeFee, m.contingencyPct);
  const costBeforeBond = add(costBeforeFee, fee, insurance, contingency);

  const bond = bondingRequired
    ? grossUp(costBeforeBond, m.bondRatePct)
    : { total: costBeforeBond, premium: ZERO };

  return {
    directCost,
    fieldOverhead,
    fieldCost,
    homeOfficeOverhead,
    generalAdmin,
    costBeforeFee,
    fee,
    insurance,
    contingency,
    costBeforeBond,
    bondPremium: bond.premium,
    bidPrice: bond.total,
  };
}

function computeCrossCheck(bidPrice: Cents, comparables: Cents[]): CrossCheck {
  if (comparables.length < 5) {
    return {
      comparableCount: comparables.length,
      p25: null,
      p50: null,
      p75: null,
      verdict: "insufficient_data",
    };
  }
  const sorted = [...comparables].sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25)!;
  const p50 = percentile(sorted, 0.5)!;
  const p75 = percentile(sorted, 0.75)!;

  const verdict: CrossCheck["verdict"] =
    bidPrice < p25 ? "below_range" : bidPrice > p75 ? "above_range" : "within_range";

  return { comparableCount: comparables.length, p25, p50, p75, verdict };
}

export function priceEstimate(input: PriceInput): PricedEstimate {
  const warnings: string[] = [];
  const { scope, assumptions } = input;

  const lines = scope.items.map((item) => priceLine(item, input, warnings));
  const directCost = add(...lines.map((l) => l.directCost));
  const totals = rollUp(directCost, assumptions.markups, scope.bonding_required);
  const crossCheck = computeCrossCheck(totals.bidPrice, input.comparables ?? []);

  const unpriced = lines.filter((l) => l.basis === "unpriced");
  if (unpriced.length > 0) {
    warnings.unshift(
      `${unpriced.length} scope line(s) could not be priced; the total is incomplete.`,
    );
  }

  const uncalibrated = lines.filter((l) => l.basis === "system_default");
  if (uncalibrated.length > 0) {
    warnings.push(
      `${uncalibrated.length} line(s) use system default rates that have not been ` +
        `calibrated against your historical projects. These are placeholders.`,
    );
  }

  const assumed = scope.items.filter((i) => i.confidence === "assumed");
  if (assumed.length > 0) {
    warnings.push(
      `${assumed.length} quantity/quantities were inferred, not stated in the RFP: ` +
        assumed.map((i) => i.description).join(", "),
    );
  }

  if (scope.davis_bacon_applies && !input.wages.determinationId) {
    warnings.push(
      "Davis-Bacon applies but no wage determination was loaded. Labor cost is unreliable.",
    );
  }

  if (!scope.bonding_required) {
    warnings.push(
      "Extraction found no bonding requirement; no premium is included. If bonding is " +
        `required, the total is understated by roughly ${(assumptions.markups.bondRatePct * 100).toFixed(2)}%.`,
    );
  }

  if (crossCheck.verdict === "above_range") {
    warnings.push(
      `Cross-check: ${formatUSD(totals.bidPrice)} is above the p75 of comparable awards ` +
        `(${formatUSD(crossCheck.p75!)}, n=${crossCheck.comparableCount}).`,
    );
  } else if (crossCheck.verdict === "below_range") {
    warnings.push(
      `Cross-check: ${formatUSD(totals.bidPrice)} is below the p25 of comparable awards ` +
        `(${formatUSD(crossCheck.p25!)}, n=${crossCheck.comparableCount}). Possible missing scope.`,
    );
  }

  if (scope.missing_information.length > 0) {
    warnings.push(
      `${scope.missing_information.length} item(s) of required information are missing from the RFP.`,
    );
  }

  return { lines, totals, crossCheck, warnings };
}

export function waterfallRows(
  t: EstimateTotals,
  m: AssumptionSet["markups"],
  /**
   * Defaults to inferring from the premium. Passing it explicitly matters when
   * the rate is configured but the job does not require a bond: showing
   * "1.50% — $0" invites the reader to wonder whether the calculation failed,
   * when in fact no bond was called for.
   */
  bondingRequired: boolean = t.bondPremium > 0,
): Array<{ label: string; rate: string | null; amount: Cents; isSubtotal: boolean }> {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return [
    { label: "Direct cost (labor + material + equipment + subs)", rate: null, amount: t.directCost, isSubtotal: true },
    { label: "Field overhead", rate: pct(m.fieldOverheadPct), amount: t.fieldOverhead, isSubtotal: false },
    { label: "Field cost", rate: null, amount: t.fieldCost, isSubtotal: true },
    { label: "Home office overhead", rate: pct(m.homeOfficeOverheadPct), amount: t.homeOfficeOverhead, isSubtotal: false },
    { label: "G&A", rate: pct(m.generalAdminPct), amount: t.generalAdmin, isSubtotal: false },
    { label: "Cost before fee", rate: null, amount: t.costBeforeFee, isSubtotal: true },
    { label: "Fee", rate: pct(m.feePct), amount: t.fee, isSubtotal: false },
    { label: "Insurance", rate: pct(m.insurancePct), amount: t.insurance, isSubtotal: false },
    { label: "Contingency", rate: pct(m.contingencyPct), amount: t.contingency, isSubtotal: false },
    { label: "Cost before bond", rate: null, amount: t.costBeforeBond, isSubtotal: true },
    bondingRequired
      ? { label: "Bond premium (grossed up)", rate: pct(m.bondRatePct), amount: t.bondPremium, isSubtotal: false }
      : { label: "Bond premium — not required on this job", rate: null, amount: t.bondPremium, isSubtotal: false },
    { label: "Bid price", rate: null, amount: t.bidPrice, isSubtotal: true },
  ];
}

export function assertTotalsConsistent(t: EstimateTotals): void {
  const checks: Array<[string, Cents, Cents]> = [
    ["fieldCost", t.fieldCost, add(t.directCost, t.fieldOverhead)],
    ["costBeforeFee", t.costBeforeFee, add(t.fieldCost, t.homeOfficeOverhead, t.generalAdmin)],
    ["costBeforeBond", t.costBeforeBond, add(t.costBeforeFee, t.fee, t.insurance, t.contingency)],
    ["bidPrice", t.bidPrice, add(t.costBeforeBond, t.bondPremium)],
  ];
  for (const [name, actual, expected] of checks) {
    if (Math.abs(sub(actual, expected)) > 1) {
      throw new Error(
        `Waterfall does not balance: ${name} = ${actual}, expected ${expected}`,
      );
    }
  }
}
