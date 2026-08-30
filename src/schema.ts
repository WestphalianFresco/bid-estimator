import { z } from "zod";
import type { Cents } from "./money";

export const UNITS = ["SF", "SY", "CY", "LF", "EA", "LS", "TON", "HR", "SQ", "GAL"] as const;
export type Unit = (typeof UNITS)[number];

/**
 * Two-letter codes accepted by SAM.gov and USAspending, including DC and the
 * territories that appear in federal construction contracting.
 *
 * The enum exists because location is the single largest driver of cost in this
 * model — it selects the wage determination, the sales tax, the prevailing wage
 * statute and the licensing regime. A free-form string let the extractor emit
 * "UNKNOWN", which then reached USAspending and came back 422. A location the
 * engine cannot resolve must be `null` and visible, never a placeholder word.
 */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
  "WY", "PR", "VI", "GU", "AS", "MP",
] as const;
export type UsState = (typeof US_STATES)[number];

export const isUsState = (s: unknown): s is UsState =>
  typeof s === "string" && (US_STATES as readonly string[]).includes(s);

export const TRADES = [
  "laborer",
  "carpenter",
  "electrician",
  "plumber",
  "pipefitter",
  "ironworker",
  "cement_mason",
  "bricklayer",
  "roofer",
  "sheet_metal_worker",
  "painter",
  "operating_engineer",
  "truck_driver",
  "glazier",
  "insulation_worker",
] as const;
export type Trade = (typeof TRADES)[number];

/**
 * What kind of work a line is, independent of which rate gets applied to it.
 *
 * This exists because of a specific failure. A 120 LF run of interior baseboard
 * was matched to `06-casework` — cabinets and countertops at $320/LF. The unit
 * agreed (LF), the CSI division agreed (06), so nothing rejected it, and the
 * line priced at $50,603, half the direct cost of the whole job. A missing rate
 * that returns zero announces itself; a wrong rate that returns a plausible
 * number does not.
 *
 * The fix is a two-sided declaration. Extraction states what the work *is* from
 * this list, without reference to the catalog; every catalog entry declares what
 * it *prices*. The engine compares the two as strings and refuses the line when
 * they disagree. Judging "this is trim" is a much easier call than judging
 * "casework is close enough to trim", and the engine no longer has to take the
 * match on trust.
 *
 * Granularity rule: two operations share a work type only when the same
 * subcontractor would quote them off the same unit rate.
 */
export const WORK_TYPES = [
  "general_allowance",
  "demolition",
  "hazmat_abatement",
  "concrete_flatwork",
  "concrete_structural",
  "masonry_wall",
  "masonry_veneer",
  "masonry_restoration",
  "structural_steel",
  "metal_fabrication",
  "metal_railing",
  "rough_carpentry",
  "finish_carpentry_trim",
  "casework",
  "countertop",
  "roof_demolition",
  "roof_insulation",
  "roof_membrane",
  "roof_sheet_metal",
  "roof_accessory",
  "building_insulation",
  "fireproofing",
  "sealant",
  "door",
  "overhead_door",
  "glazing",
  "gypsum_board",
  "ceiling",
  "painting",
  "flooring_resilient",
  "flooring_carpet",
  "flooring_coating",
  "tile",
  "specialty_item",
  "conveying",
  "fire_suppression",
  "plumbing_piping",
  "plumbing_fixture",
  "plumbing_equipment",
  "hvac_equipment",
  "hvac_ductwork",
  "hvac_controls",
  "electrical_distribution",
  "electrical_branch_wiring",
  "electrical_device",
  "electrical_fixture",
  "electrical_equipment",
  "communications",
  "fire_alarm",
  "security",
  "earthwork",
  "site_paving",
  "site_improvement",
  "site_utilities",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/**
 * How well the chosen rate actually describes the line.
 *
 * `loose` is not a soft warning — the engine declines to price the line. That
 * is the whole point: an unpriced line the estimator has to fill in is far
 * cheaper than a confident wrong number they do not notice.
 */
export const MATCH_CONFIDENCE = ["exact", "close", "loose"] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCE)[number];

export const CSI_DIVISIONS = [
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
  "11", "12", "13", "14", "21", "22", "23", "26", "27", "28",
  "31", "32", "33",
] as const;
export type CsiDivision = (typeof CSI_DIVISIONS)[number];

export const ScopeItemSchema = z.object({
  csi_division: z.enum(CSI_DIVISIONS),
  description: z.string(),
  quantity: z.number(),
  unit: z.enum(UNITS),
  assumption_key: z.string(),
  /** What this work is, decided from the document, not from the catalog. */
  work_type: z.enum(WORK_TYPES),
  /** How well assumption_key actually describes this work. */
  match_confidence: z.enum(MATCH_CONFIDENCE),
  /** Where the quantity came from. */
  confidence: z.enum(["stated", "inferred", "assumed"]),
  source_quote: z.string(),
});
export type ScopeItem = z.infer<typeof ScopeItemSchema>;

export const ExtractedScopeSchema = z.object({
  project_title: z.string(),
  naics_code: z.string(),
  psc_code: z.string().nullable(),
  /** null when the document does not identify the state unambiguously. */
  state: z.enum(US_STATES).nullable(),
  /** County or independent city, without the word "County". */
  county: z.string().nullable(),
  /** What the document actually said about where the work is, verbatim. */
  location_quote: z.string().nullable(),
  gross_square_feet: z.number().nullable(),
  duration_months: z.number().nullable(),
  delivery_method: z.enum([
    "design_bid_build",
    "design_build",
    "cmar",
    "idiq",
    "unknown",
  ]),
  davis_bacon_applies: z.boolean(),
  bonding_required: z.boolean(),
  items: z.array(ScopeItemSchema),
  missing_information: z.array(z.string()),
  clarification_questions: z.array(z.string()),
});
export type ExtractedScope = z.infer<typeof ExtractedScopeSchema>;

export interface LaborLine {
  trade: Trade;
  hours: number;
  loadedRate: Cents;
  cost: Cents;
}

export interface PricedLine {
  item: ScopeItem;
  labor: LaborLine[];
  laborCost: Cents;
  materialCost: Cents;
  equipmentCost: Cents;
  subcontractCost: Cents;
  directCost: Cents;
  basis: "user_assumption" | "system_default" | "unpriced";
}

export interface EstimateTotals {
  directCost: Cents;
  fieldOverhead: Cents;
  fieldCost: Cents;
  homeOfficeOverhead: Cents;
  generalAdmin: Cents;
  costBeforeFee: Cents;
  fee: Cents;
  insurance: Cents;
  contingency: Cents;
  costBeforeBond: Cents;
  bondPremium: Cents;
  bidPrice: Cents;
}

export interface CrossCheck {
  comparableCount: number;
  p25: Cents | null;
  p50: Cents | null;
  p75: Cents | null;
  verdict:
    | "within_range"
    | "below_range"
    | "above_range"
    | "insufficient_data";
}

export interface PricedEstimate {
  lines: PricedLine[];
  totals: EstimateTotals;
  crossCheck: CrossCheck;
  warnings: string[];
}

/** Where the material unit costs in this estimate came from. */
export interface MaterialPricingProvenance {
  source: "catalog_default" | "home_depot_retail";
  fetchedAt: string | null;
  zip: string | null;
  retailFactor: number | null;
  appliedKeys: string[];
  unsourcedKeys: string[];
}

export interface EstimateSnapshot {
  id: string;
  createdAt: string;
  engineVersion: string;
  inputText: string;
  scope: ExtractedScope;
  assumptionsSnapshot: unknown;
  wageDeterminationId: string;
  materialPricing: MaterialPricingProvenance;
  estimate: PricedEstimate;
}
