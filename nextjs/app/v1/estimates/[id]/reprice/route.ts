import { z } from "zod";

import { priceBands } from "@/lib/bands";
import { assertTotalsConsistent } from "@/lib/price";
import { isUnchanged, repriceEstimate, type Overrides } from "@/lib/reprice";
import { summarizeComposition } from "@/lib/rollups";
import { TRADES } from "@/lib/schema";

import { assertMayOverrideRates, resolveDetail } from "@/lib/api/auth";
import { ApiFault } from "@/lib/api/errors";
import { getEstimate } from "@/lib/api/store";
import {
  assertNoAssumptionsLeaked,
  isDetailLevel,
  toPublicEstimate,
  type DetailLevel,
} from "@/lib/api/serialize";
import { readJson, route, type RouteContext } from "../../../_lib/handler";

/**
 * POST /v1/estimates/{id}/reprice — apply adjustments and re-price.
 *
 * Free and instant: no model call, no network, no token spend. This is Layer 2
 * and nothing else, so it can be called on every slider drag in a caller's own
 * UI without costing either side anything.
 *
 * ## What the caller sends, and what they conspicuously do not
 *
 * The in-app reprice route takes the scope, the assumption set and the wage
 * table in the request body, because the browser already received them with the
 * estimate. **This one takes none of those.** The caller sends overrides and an
 * estimate id; the server reloads the original basis from storage.
 *
 * That is not a convenience. It is the whole distinction between this API and
 * handing someone the library: an API caller never possesses the assumption set,
 * so they cannot supply it, and re-pricing against a basis they could edit would
 * hand them the ability to forge an estimate that carries our engine version and
 * our disclaimer.
 *
 * It also removes a real correctness trap. Repricing against the stored basis
 * guarantees the adjusted total is comparable to the one originally quoted; a
 * caller who round-tripped a slightly stale assumption set would get a number
 * that silently disagreed with the estimate it claims to adjust.
 *
 * ## Why the result is not persisted
 *
 * An adjustment is a what-if. Storing every one would turn one estimate into an
 * unbounded row count and make "which number did we quote" ambiguous. The
 * original stays the record; the caller keeps whichever variation they acted on.
 */

export const runtime = "nodejs";

/**
 * The public override shape — snake_case, matching the rest of the surface,
 * and deliberately narrower than the internal `OverridesSchema`.
 */
const PublicOverrides = z
  .object({
    /** Scope line index (as a string key) to a replacement quantity. */
    quantities: z.record(z.string(), z.number().finite().min(0).max(100_000_000)).optional(),
    /** Assumption key to a material cost per catalogue unit, in dollars. */
    material_unit_costs: z.record(z.string(), z.number().finite().min(0)).optional(),
    /** Trade to Davis-Bacon base rate and fringe, in dollars per hour. */
    wage_rates: z
      .partialRecord(
        z.enum(TRADES),
        z.object({
          base_rate: z.number().finite().min(0),
          fringe: z.number().finite().min(0),
        }),
      )
      .optional(),
    markups: z
      .object({
        field_overhead_pct: z.number().finite().min(0).max(1).optional(),
        home_office_overhead_pct: z.number().finite().min(0).max(1).optional(),
        general_admin_pct: z.number().finite().min(0).max(1).optional(),
        fee_pct: z.number().finite().min(0).max(1).optional(),
        insurance_pct: z.number().finite().min(0).max(1).optional(),
        contingency_pct: z.number().finite().min(0).max(1).optional(),
        bond_rate_pct: z.number().finite().min(0).max(1).optional(),
        labor_burden_pct: z.number().finite().min(0).max(1).optional(),
      })
      .optional(),
  })
  .strict();

type PublicOverrideInput = z.infer<typeof PublicOverrides>;

/** Translates the public snake_case overrides into the engine's shape. */
function toEngineOverrides(o: PublicOverrideInput): Overrides {
  const out: Overrides = {};
  if (o.quantities) out.quantities = o.quantities;
  if (o.material_unit_costs) out.materialUnitCosts = o.material_unit_costs;
  if (o.wage_rates) {
    out.wageRates = Object.fromEntries(
      Object.entries(o.wage_rates).map(([trade, v]) => [
        trade,
        { baseRate: v!.base_rate, fringe: v!.fringe },
      ]),
    ) as Overrides["wageRates"];
  }
  if (o.markups) {
    const m = o.markups;
    out.markups = {
      ...(m.field_overhead_pct !== undefined ? { fieldOverheadPct: m.field_overhead_pct } : {}),
      ...(m.home_office_overhead_pct !== undefined
        ? { homeOfficeOverheadPct: m.home_office_overhead_pct }
        : {}),
      ...(m.general_admin_pct !== undefined ? { generalAdminPct: m.general_admin_pct } : {}),
      ...(m.fee_pct !== undefined ? { feePct: m.fee_pct } : {}),
      ...(m.insurance_pct !== undefined ? { insurancePct: m.insurance_pct } : {}),
      ...(m.contingency_pct !== undefined ? { contingencyPct: m.contingency_pct } : {}),
      ...(m.bond_rate_pct !== undefined ? { bondRatePct: m.bond_rate_pct } : {}),
      ...(m.labor_burden_pct !== undefined ? { laborBurdenPct: m.labor_burden_pct } : {}),
    };
  }
  return out;
}

async function reprice({ caller, req }: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  // .../v1/estimates/{id}/reprice
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 2] ?? "";

  const body = await readJson(req);

  const rawDetail = body.detail;
  if (rawDetail !== undefined && !isDetailLevel(rawDetail)) {
    throw new ApiFault("invalid_request", `detail must be "summary" or "lines".`);
  }
  const detail: DetailLevel = resolveDetail(caller, rawDetail as DetailLevel | undefined);

  const parsed = PublicOverrides.safeParse(body.overrides ?? {});
  if (!parsed.success) {
    throw new ApiFault(
      "invalid_request",
      "The overrides object failed validation.",
      parsed.error.issues.slice(0, 8).map((i) => `overrides.${i.path.join(".")}: ${i.message}`),
    );
  }

  // Rate-revealing overrides are gated; quantities and markups are not.
  if (parsed.data.wage_rates || parsed.data.material_unit_costs) {
    assertMayOverrideRates(caller);
  }

  const stored = getEstimate(caller.account.id, id);
  if (!stored) throw new ApiFault("not_found", `No estimate with id "${id}".`);

  const snapshot = stored.snapshot as {
    scope: never;
    assumptionsSnapshot: never;
    id: string;
    createdAt: string;
    engineVersion: string;
    inputText: string;
    wageDeterminationId: string;
    materialPricing: never;
    estimate: never;
  };
  const extras = stored.extras as {
    wages?: never;
    comparables?: number[];
    pipelineWarnings?: string[];
    comparablesCaveat?: string | null;
    explanation?: string;
  };

  if (!extras.wages) {
    // Estimates written before wages were stored cannot be repriced against
    // their original basis, and repricing against a different one would produce
    // a number that quietly disagrees with what the customer was quoted.
    throw new ApiFault(
      "invalid_request",
      "This estimate predates reprice support and cannot be adjusted. Create a new estimate.",
    );
  }

  const result = repriceEstimate({
    scope: snapshot.scope,
    assumptions: snapshot.assumptionsSnapshot,
    wages: extras.wages,
    comparables: extras.comparables,
    overrides: toEngineOverrides(parsed.data),
  });
  // The same invariant the engine holds internally. If an override could break
  // the build-up, the caller must hear about it as a 500 rather than receive an
  // internally inconsistent set of totals.
  assertTotalsConsistent(result.estimate.totals);

  const composition = summarizeComposition(result.estimate, result.input.scope);
  const bands = priceBands(result.input);

  const publicBody = toPublicEstimate({
    // A repriced estimate is presented as the same estimate adjusted, carrying
    // the original id and creation time, so a caller can tell which record it
    // belongs to. It is not stored and does not get an id of its own.
    snapshot: { ...snapshot, estimate: result.estimate, scope: result.input.scope } as never,
    bands,
    composition,
    explanation: undefined,
    detail,
    pipelineWarnings: extras.pipelineWarnings,
    comparablesCaveat: extras.comparablesCaveat,
  });
  assertNoAssumptionsLeaked(publicBody);

  return Response.json({
    ...publicBody,
    object: "estimate.repriced",
    /**
     * What actually moved. A caller that sent an override for a key the scope
     * does not contain gets a zero here rather than a silent no-op, which is
     * the difference between finding a typo and shipping one.
     */
    adjustments_applied: {
      quantities: result.changed.quantities,
      material_unit_costs: result.changed.materialUnitCosts,
      wage_rates: result.changed.wageRates,
      markups: result.changed.markups,
    },
    unchanged: isUnchanged(result.changed),
    /** The explanation belongs to the original; prose is not re-generated here. */
    explanation_stale: extras.explanation !== undefined,
  });
}

export const POST = route({ name: "estimates.reprice", billable: false, handler: reprice });
