import { authenticate, quotaHeaders, rateHeaders, type Caller } from "@/lib/api/auth";
import { ApiFault, apiError } from "@/lib/api/errors";
import { recordUsage } from "@/lib/api/store";

/**
 * The wrapper every /v1 route is built from.
 *
 * It exists so that three things cannot be forgotten one route at a time:
 * authentication, usage recording, and never letting a raw exception reach the
 * caller. A route that forgets any of those is a route that leaks — budget,
 * data, or internal detail — and "remember to call authenticate first" is not a
 * control, it is a hope.
 *
 * ## Why unexpected errors carry no detail
 *
 * An `ApiFault` is a failure we wrote on purpose, so its message is safe to
 * publish. Anything else is an exception whose message may contain a file path,
 * a SQL fragment, a stack, or a piece of somebody's solicitation. Those go to
 * the server log with the request id attached, and the caller gets the id and
 * nothing else. The id is what makes that acceptable: a customer can quote one
 * line in an email and we can find the exact failure.
 */

export interface RouteContext {
  caller: Caller;
  req: Request;
}

export interface RouteConfig {
  /** Route label recorded on the usage event. */
  name: string;
  /**
   * Whether a success consumes monthly quota. True for anything that calls the
   * model; false for pure arithmetic, which costs us nothing to serve.
   */
  billable: boolean;
  handler: (ctx: RouteContext) => Promise<Response>;
}

export function route(config: RouteConfig): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    let caller: Caller;
    try {
      caller = authenticate(req, { billable: config.billable });
    } catch (e) {
      if (e instanceof ApiFault) {
        // No account is known on an auth failure, so there is nothing to meter
        // against; authenticate() has already recorded the rate/quota cases it
        // could attribute.
        return apiError(e.code, e.message, unattributedId(), {
          detail: e.detail,
          headers: e.headers,
        });
      }
      throw e;
    }

    let response: Response;
    try {
      response = await config.handler({ caller, req });
    } catch (e) {
      if (e instanceof ApiFault) {
        response = apiError(e.code, e.message, caller.requestId, {
          detail: e.detail,
          headers: e.headers,
        });
      } else {
        console.error(`[${caller.requestId}] ${config.name} failed:`, e);
        response = apiError(
          "internal_error",
          "The request could not be completed. Quote the request_id if you contact support.",
          caller.requestId,
        );
      }
    }

    // Metered after the fact, on the real status: a request that failed on our
    // side should not spend a customer's monthly allowance.
    const billableNow = config.billable && response.status < 400;
    recordUsage(caller.account.id, config.name, billableNow, response.status);

    return withStandardHeaders(response, caller, billableNow);
  };
}

/**
 * Adds the headers a caller needs to pace themselves and to file a bug.
 *
 * Response objects are immutable once constructed, so this rebuilds one. The
 * body is passed through untouched — including a stream, which must not be
 * buffered here.
 */
function withStandardHeaders(res: Response, caller: Caller, spentBillable: boolean): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Request-Id", caller.requestId);
  for (const [k, v] of Object.entries(rateHeaders(caller.usage))) headers.set(k, v);
  for (const [k, v] of Object.entries(quotaHeaders(caller.usage, spentBillable ? 1 : 0))) {
    headers.set(k, v);
  }
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const unattributedId = () => `req_unauth_${Math.random().toString(36).slice(2, 10)}`;

/** Reads and validates a JSON body, as an ApiFault rather than a throw. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("multipart/form-data")) {
    throw new ApiFault(
      "invalid_request",
      "Content-Type must be application/json or multipart/form-data.",
    );
  }
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiFault("invalid_request", "Request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ApiFault) throw e;
    throw new ApiFault("invalid_request", "Request body is not valid JSON.");
  }
}
