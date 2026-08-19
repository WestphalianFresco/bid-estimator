import { validateAssumptions, type AssumptionSet } from "./assumptions";
import { extractScope } from "./extract";
import { ENGINE_VERSION, assertTotalsConsistent, priceEstimate } from "./price";
import type { EstimateSnapshot } from "./schema";
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

export interface EstimateRequest {
  rfpText: string;
  assumptions: AssumptionSet;
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
}

export async function runEstimate(req: EstimateRequest): Promise<EstimateResponse> {
  const pipelineWarnings: string[] = [];

  const configErrors = validateAssumptions(req.assumptions);
  if (configErrors.length > 0) {
    throw new Error(`Invalid assumption set, refusing to estimate:\n${configErrors.join("\n")}`);
  }

  const extracted = await extractScope(req.rfpText, req.assumptions);
  const scope = extracted.scope;

  if (extracted.unknownKeys.length > 0) {
    pipelineWarnings.push(
      `Model referenced ${extracted.unknownKeys.length} nonexistent assumption key(s): ` +
        `${extracted.unknownKeys.join(", ")}. Those lines are marked unpriced.`,
    );
  }

  let wages: WageTable = EMPTY_WAGE_TABLE;
  if (req.useFixtureWages) {
    wages = makeFixtureWageTable(scope.state, scope.county ?? undefined);
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

  const estimate = priceEstimate({
    scope,
    assumptions: req.assumptions,
    wages,
    escalation,
    comparables,
  });

  assertTotalsConsistent(estimate.totals);

  const snapshot: EstimateSnapshot = {
    id: req.id,
    createdAt: req.now,
    engineVersion: ENGINE_VERSION,
    inputText: req.rfpText,
    scope,
    assumptionsSnapshot: structuredClone(req.assumptions),
    wageDeterminationId: wages.determinationId,
    estimate,
  };

  return { snapshot, comparablesCaveat, pipelineWarnings };
}
