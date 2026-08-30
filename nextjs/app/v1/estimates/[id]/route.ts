import { ApiFault } from "@/lib/api/errors";
import { getEstimate } from "@/lib/api/store";
import {
  assertNoAssumptionsLeaked,
  isDetailLevel,
  toPublicEstimate,
  type DetailLevel,
} from "@/lib/api/serialize";
import { resolveDetail } from "@/lib/api/auth";
import { route, type RouteContext } from "../../_lib/handler";

/**
 * GET /v1/estimates/{id} — retrieve a stored estimate.
 *
 * Free. The estimate was already paid for when it was created; charging again
 * to read it back would push callers into caching our responses themselves,
 * which is worse for them and worse for us.
 *
 * Detail level is a query parameter rather than fixed at creation, so a caller
 * who bought `lines` access can re-read an old estimate at full detail without
 * spending another model call. The gate is the same either way: whatever
 * `serialize.ts` refuses to publish stays unpublished.
 */

export const runtime = "nodejs";

async function retrieve({ caller, req }: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";

  const raw = url.searchParams.get("detail");
  if (raw !== null && !isDetailLevel(raw)) {
    throw new ApiFault("invalid_request", `detail must be "summary" or "lines".`);
  }
  const detail: DetailLevel = resolveDetail(caller, (raw as DetailLevel | null) ?? undefined);

  const stored = getEstimate(caller.account.id, id);
  if (!stored) {
    // Deliberately identical whether the id is unknown or belongs to another
    // account. The alternative turns this endpoint into a way to test whether
    // a given estimate exists somewhere in the system.
    throw new ApiFault("not_found", `No estimate with id "${id}".`);
  }

  const extras = stored.extras as {
    bands: never;
    composition: never;
    pipelineWarnings?: string[];
    comparablesCaveat?: string | null;
    explanation?: string;
  };

  const body = toPublicEstimate({
    snapshot: stored.snapshot as never,
    bands: extras.bands,
    composition: extras.composition,
    explanation: extras.explanation,
    detail,
    pipelineWarnings: extras.pipelineWarnings,
    comparablesCaveat: extras.comparablesCaveat,
  });
  assertNoAssumptionsLeaked(body);

  return Response.json(body);
}

export const GET = route({ name: "estimates.retrieve", billable: false, handler: retrieve });
