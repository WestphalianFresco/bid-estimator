import type { BidBandSet } from "@/lib/bands";
import type { CompositionSummary } from "@/lib/rollups";
import type { WageTable } from "@/lib/data/wage-determinations";
import type { EstimateSnapshot, PricedEstimate } from "@/lib/schema";

/** The first NDJSON frame from /api/estimate — everything the report needs. */
export interface EstimatePayload {
  snapshot: EstimateSnapshot;
  comparablesCaveat: string | null;
  pipelineWarnings: string[];
  sourceLabel: string;
  wages: WageTable;
  comparables: number[];
  bands: BidBandSet;
  composition: CompositionSummary;
}

/** What /api/reprice returns for a manually adjusted estimate. */
export interface RepriceResponse {
  estimate: PricedEstimate;
  bands: BidBandSet;
  composition: CompositionSummary;
  unchanged: boolean;
}

/**
 * Who the quotation is addressed to.
 *
 * Held in the browser and never sent anywhere: it is letterhead, not an input
 * to the estimate, and the estimate must not change because someone typed a
 * different client name.
 */
export interface Letterhead {
  preparedFor: string;
  preparedBy: string;
  contact: string;
}
