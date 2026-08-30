import { validateAssumptions, type AssumptionSet } from "./assumptions";
import { priceBands, type BidBandSet } from "./bands";
import { summarizeComposition, type CompositionSummary } from "./rollups";
import { describeSource, extractScope, type ScopeSource } from "./extract";
import { ENGINE_VERSION, assertTotalsConsistent, priceEstimate, type PriceInput } from "./price";
import type { EstimateSnapshot, MaterialPricingProvenance, UsState } from "./schema";
import { applyMaterialQuotes, type MaterialQuote } from "./data/home-depot";
import {
  EMPTY_WAGE_TABLE,
  fetchWageDetermination,
  isStale,
  makeFixtureWageTable,
  type WageTable,
} from "./data/wage-determinations";
import {
  amountsOf,
  fetchComparables,
  removeOutliers,
} from "./data/comparables";
import { computeEscalation, escalationWarnings } from "./data/escalation";

/**
 * Where the work is. Supplied by the user, and authoritative over whatever the
 * extractor found in the document.
 *
 * Solicitations routinely omit the state — "Jefferson County" with no further
 * qualifier is common in county and municipal work. Rather than guess, the
 * engine takes the answer from whoever is running the estimate, because they
 * know which job they are bidding.
 */
export interface LocationOverride {
  state?: UsState | null;
  county?: string | null;
}

export interface EstimateRequest {
  source: ScopeSource;
  location?: LocationOverride;
  assumptions: AssumptionSet;
  /**
   * Material unit costs fetched ahead of time (see data/home-depot.ts). Passed
   * in rather than fetched here so that pricing stays reproducible: the quotes
   * that were used are folded into the assumption set and captured in the
   * snapshot, so an estimate can be re-derived after every listing has changed.
   */
  materialQuotes?: Record<string, MaterialQuote>;
  id: string;
  now: string;
  samApiKey?: string;
  blsApiKey?: string;
  useFixtureWages?: boolean;
}

export interface EstimateResponse {
  snapshot: EstimateSnapshot;
  comparablesCaveat: string | null;
  pipelineWarnings: string[];
  /**
   * The wage table the estimate was priced against. Returned so the adjustment
   * panel can show the rates and hand edited ones back to /api/reprice; the
   * snapshot only records which determination was used, not its contents.
   */
  wages: WageTable;
  /** Comparable award amounts, so a re-price keeps the same cross-check basis. */
  comparables: number[];
  /**
   * The same scope priced at three commercial postures. Derived from the exact
   * `PriceInput` that produced `snapshot.estimate`, so the recommended column
   * equals the headline figure to the cent.
   */
  bands: BidBandSet;
  /** Cost-by-type and cost-by-division subtotals for the report's charts. */
  composition: CompositionSummary;
}

export async function runEstimate(req: EstimateRequest): Promise<EstimateResponse> {
  const pipelineWarnings: string[] = [];

  const configErrors = validateAssumptions(req.assumptions);
  if (configErrors.length > 0) {
    throw new Error(`Invalid assumption set, refusing to estimate:\n${configErrors.join("\n")}`);
  }

  const extracted = await extractScope(req.source, req.assumptions);
  const scope = extracted.scope;

  // ── Location ──────────────────────────────────────────────────────
  // Applied before anything reads scope.state, so the wage lookup, the
  // comparables query and the snapshot all agree on one answer.
  const override = req.location;
  if (override?.state !== undefined && override.state !== scope.state) {
    if (scope.state && override.state) {
      pipelineWarnings.push(
        `Location overridden: the document indicated ${scope.state}, the estimate was run ` +
          `for ${override.state}. Wage rates and comparables reflect ${override.state}.`,
      );
    }
    scope.state = override.state;
  }
  if (override?.county !== undefined && override.county !== scope.county) {
    scope.county = override.county;
  }

  if (!scope.state) {
    pipelineWarnings.push(
      "The state could not be determined from the document and none was supplied. " +
        "Labor rates cannot be localized, sales tax is unknown, and no state prevailing " +
        "wage statute can be checked. Set the location and re-run before using this figure.",
    );
  }

  if (extracted.unknownKeys.length > 0) {
    pipelineWarnings.push(
      `Model referenced ${extracted.unknownKeys.length} nonexistent assumption key(s): ` +
        `${extracted.unknownKeys.join(", ")}. Those lines are marked unpriced.`,
    );
  }

  let wages: WageTable = EMPTY_WAGE_TABLE;
  if (req.useFixtureWages) {
    wages = makeFixtureWageTable(scope.state ?? undefined, scope.county ?? undefined);
    pipelineWarnings.push(
      "Using fixture wage rates, not a real Davis-Bacon determination. Not valid for bidding.",
    );
  } else if (req.samApiKey) {
    try {
      wages = await fetchWageDetermination({
        state: scope.state,
        county: scope.county,
        apiKey: req.samApiKey,
      });
      if (isStale(wages, req.now)) {
        pipelineWarnings.push(
          `Wage determination ${wages.determinationId} is effective ${wages.effectiveDate}, ` +
            `over a year old. Check for a newer revision.`,
        );
      }
    } catch (e) {
      if (scope.davis_bacon_applies) {
        throw new Error(
          `Davis-Bacon applies but the wage determination could not be retrieved, so ` +
            `labor cost cannot be trusted. Cause: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      pipelineWarnings.push(
        `Wage determination lookup failed; labor cost excluded: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (scope.davis_bacon_applies) {
    throw new Error(
      "Davis-Bacon applies but no SAM.gov API key is configured.",
    );
  }

  let comparables: ReturnType<typeof amountsOf> = [];
  let comparablesCaveat: string | null = null;
  try {
    const result = await fetchComparables({
      naics: scope.naics_code,
      psc: scope.psc_code,
      state: scope.state,
    });
    comparables = removeOutliers(amountsOf(result));
    comparablesCaveat = result.caveat;
  } catch (e) {
    pipelineWarnings.push(
      `Comparable award lookup failed; no independent cross-check this run: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let escalation: Record<string, number> = {};
  if (req.blsApiKey) {
    try {
      escalation = await computeEscalation(req.assumptions, {
        apiKey: req.blsApiKey,
        asOf: req.now,
      });
      pipelineWarnings.push(...escalationWarnings(escalation, req.assumptions));
    } catch (e) {
      pipelineWarnings.push(
        `BLS index lookup failed; material prices not escalated: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── Material prices ───────────────────────────────────────────────
  // Applied to a copy; req.assumptions is never mutated, and the copy is what
  // gets snapshotted, so the estimate stays reproducible from the record alone.
  let assumptions = req.assumptions;
  let materialPricing: MaterialPricingProvenance = {
    source: "catalog_default",
    fetchedAt: null,
    zip: null,
    retailFactor: null,
    appliedKeys: [],
    unsourcedKeys: [],
  };

  if (req.materialQuotes && Object.keys(req.materialQuotes).length > 0) {
    const first = Object.values(req.materialQuotes)[0];
    const { assumptions: withQuotes, applied, skipped } = applyMaterialQuotes(
      req.assumptions,
      req.materialQuotes,
    );
    assumptions = withQuotes;
    materialPricing = {
      source: "home_depot_retail",
      fetchedAt: first.fetchedAt,
      zip: first.zip,
      retailFactor: first.retailFactor,
      appliedKeys: applied,
      unsourcedKeys: assumptions.material
        .map((m) => m.key)
        .filter((k) => !applied.includes(k)),
    };
    pipelineWarnings.push(
      `Material unit costs for ${applied.length} of ${assumptions.material.length} catalog ` +
        `items came from Home Depot retail listings priced for ZIP ${first.zip} on ` +
        `${first.fetchedAt.slice(0, 10)}` +
        (first.retailFactor === 1
          ? " at full shelf price. A supply house account typically costs 20–40% less."
          : ` with a ${(first.retailFactor * 100).toFixed(0)}% retail factor applied.`),
    );
    if (materialPricing.unsourcedKeys.length > 0) {
      pipelineWarnings.push(
        `${materialPricing.unsourcedKeys.length} material item(s) are not retail SKUs ` +
          `(ready-mix, fabricated metal, commercial equipment, site utilities) and keep ` +
          `their uncalibrated catalog default.`,
      );
    }
    for (const s of skipped) pipelineWarnings.push(`Material quote skipped — ${s}`);
  }

  const priceInput: PriceInput = { scope, assumptions, wages, escalation, comparables };
  const estimate = priceEstimate(priceInput);

  assertTotalsConsistent(estimate.totals);

  const snapshot: EstimateSnapshot = {
    id: req.id,
    createdAt: req.now,
    engineVersion: ENGINE_VERSION,
    inputText: describeSource(req.source),
    scope,
    assumptionsSnapshot: structuredClone(assumptions),
    wageDeterminationId: wages.determinationId,
    materialPricing,
    estimate,
  };

  return {
    snapshot,
    comparablesCaveat,
    pipelineWarnings,
    wages,
    comparables,
    bands: priceBands(priceInput),
    composition: summarizeComposition(estimate, scope),
  };
}
