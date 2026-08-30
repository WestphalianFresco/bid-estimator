import { add, cents, scale, type Cents } from "./money";
import type { CsiDivision, ExtractedScope, PricedEstimate } from "./schema";

/**
 * Report roll-ups.
 *
 * The charts in the report need subtotals the pricing engine does not publish
 * directly — cost by type, cost by CSI division, dollars per square foot. Those
 * are still dollar amounts, so they are summed here, on the server, and sent to
 * the browser finished. The browser converts them to pixel coordinates and
 * nothing else.
 *
 * Every figure below is a sum or a ratio of amounts `priceEstimate` produced.
 * Nothing new is invented, no rate is applied, and no assumption is read.
 */

export interface CostSlice {
  key: string;
  label: string;
  amount: Cents;
  /** Fraction of the total this slice belongs to, 0–1. */
  share: number;
}

export interface CompositionSummary {
  /** Labour / material / equipment / subcontract. Zero-value slices are dropped. */
  byCostType: CostSlice[];
  /** Direct cost per CSI division, largest first. */
  byDivision: CostSlice[];
  directCost: Cents;
  /** Total crew hours across every priced line. */
  laborHours: number;
  /** Lines the engine declined to price; they contribute nothing to the sums. */
  unpricedCount: number;
  /** Bid price per gross square foot; null when the solicitation gave no area. */
  perSquareFoot: Cents | null;
  /** Bid price per month of stated duration; null when no duration was stated. */
  perMonth: Cents | null;
  /**
   * The bid price as four parts that sum to it exactly.
   *
   * Grouped rather than line-by-line because a part-to-whole chart stops being
   * readable past four or five segments — the exact eleven-row waterfall is
   * printed as a table beside it, so nothing is lost by grouping here.
   */
  buildUp: CostSlice[];
  bidPrice: Cents;
}

/** MasterFormat division titles, for the divisions this catalog can price. */
export const DIVISION_TITLES: Record<CsiDivision, string> = {
  "01": "General Requirements",
  "02": "Existing Conditions",
  "03": "Concrete",
  "04": "Masonry",
  "05": "Metals",
  "06": "Wood, Plastics & Composites",
  "07": "Thermal & Moisture Protection",
  "08": "Openings",
  "09": "Finishes",
  "10": "Specialties",
  "11": "Equipment",
  "12": "Furnishings",
  "13": "Special Construction",
  "14": "Conveying Equipment",
  "21": "Fire Suppression",
  "22": "Plumbing",
  "23": "Heating, Ventilating & Air Conditioning",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic Safety & Security",
  "31": "Earthwork",
  "32": "Exterior Improvements",
  "33": "Utilities",
};

const ZERO = cents(0);

/** Division of two amounts, guarding the empty-estimate case. */
const shareOf = (part: Cents, whole: Cents): number => (whole === 0 ? 0 : part / whole);

export function summarizeComposition(
  estimate: PricedEstimate,
  scope: ExtractedScope,
): CompositionSummary {
  const direct = estimate.totals.directCost;

  const labor = add(...estimate.lines.map((l) => l.laborCost));
  const material = add(...estimate.lines.map((l) => l.materialCost));
  const equipment = add(...estimate.lines.map((l) => l.equipmentCost));
  const subcontract = add(...estimate.lines.map((l) => l.subcontractCost));

  const byCostType: CostSlice[] = (
    [
      { key: "labor", label: "Labor", amount: labor },
      { key: "material", label: "Material", amount: material },
      { key: "equipment", label: "Equipment", amount: equipment },
      { key: "subcontract", label: "Subcontract", amount: subcontract },
    ] as const
  )
    .filter((s) => s.amount > 0)
    .map((s) => ({ ...s, share: shareOf(s.amount, direct) }));

  const perDivision = new Map<CsiDivision, Cents>();
  for (const line of estimate.lines) {
    const div = line.item.csi_division;
    perDivision.set(div, add(perDivision.get(div) ?? ZERO, line.directCost));
  }

  const byDivision: CostSlice[] = [...perDivision.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([div, amount]) => ({
      key: div,
      label: `${div} · ${DIVISION_TITLES[div]}`,
      amount,
      share: shareOf(amount, direct),
    }));

  const laborHours = estimate.lines.reduce(
    (total, line) => total + line.labor.reduce((h, l) => h + l.hours, 0),
    0,
  );

  const t = estimate.totals;
  const overhead = add(t.fieldOverhead, t.homeOfficeOverhead, t.generalAdmin);
  const risk = add(t.insurance, t.contingency, t.bondPremium);

  const buildUp: CostSlice[] = (
    [
      { key: "direct", label: "Direct cost", amount: t.directCost },
      { key: "overhead", label: "Overhead & G&A", amount: overhead },
      { key: "fee", label: "Fee", amount: t.fee },
      { key: "risk", label: "Insurance, contingency & bond", amount: risk },
    ] as const
  )
    .filter((s) => s.amount > 0)
    .map((s) => ({ ...s, share: shareOf(s.amount, t.bidPrice) }));

  const gsf = scope.gross_square_feet;
  const months = scope.duration_months;

  return {
    byCostType,
    byDivision,
    directCost: direct,
    laborHours,
    unpricedCount: estimate.lines.filter((l) => l.basis === "unpriced").length,
    perSquareFoot: gsf && gsf > 0 ? scale(t.bidPrice, 1 / gsf) : null,
    perMonth: months && months > 0 ? scale(t.bidPrice, 1 / months) : null,
    buildUp,
    bidPrice: t.bidPrice,
  };
}
