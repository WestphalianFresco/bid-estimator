import { z } from "zod";
import type { Cents } from "./money";

export const UNITS = ["SF", "SY", "CY", "LF", "EA", "LS", "TON", "HR"] as const;
export type Unit = (typeof UNITS)[number];

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
  confidence: z.enum(["stated", "inferred", "assumed"]),
  source_quote: z.string(),
});
export type ScopeItem = z.infer<typeof ScopeItemSchema>;

export const ExtractedScopeSchema = z.object({
  project_title: z.string(),
  naics_code: z.string(),
  psc_code: z.string().nullable(),
  state: z.string(),
  county: z.string().nullable(),
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

export interface EstimateSnapshot {
  id: string;
  createdAt: string;
  engineVersion: string;
  inputText: string;
  scope: ExtractedScope;
  assumptionsSnapshot: unknown;
  wageDeterminationId: string;
  estimate: PricedEstimate;
}
