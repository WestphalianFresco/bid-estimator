import { randomUUID } from "node:crypto";
import { ApiFault } from "./errors";
import type { DetailLevel } from "./serialize";
import { bearerFrom, digestMatches, parseKey, type KeyEnv } from "./keys";
import {
  findKeyByLookup,
  getAccount,
  keyHashFor,
  recordUsage,
  touchKey,
  usageWindow,
  type Account,
  type UsageWindow,
} from "./store";

/**
 * Authentication and metering — the gate every public route passes through.
 *
 * The order matters and is not arbitrary:
 *
 *   1. identify the caller     (401 — no credential, no conversation)
 *   2. check the account       (403 — a disabled account is not a rate problem)
 *   3. check the rate limit    (429 — cheap, so it runs before quota)
 *   4. check the monthly quota (429 — needs a COUNT, so it runs last)
 *
 * Every check that can reject a request runs *before* any expensive work.
 * Authenticating after calling the model would mean paying for unauthorised
 * requests, which is how a public API turns into a way for strangers to spend
 * your token budget.
 */

export interface Caller {
  account: Account;
  env: KeyEnv;
  keyLookup: string;
  usage: UsageWindow;
  /** Echoed in every response and every error, for support and log-joining. */
  requestId: string;
}

/**
 * A generic message, used for every authentication failure.
 *
 * Malformed, unknown, revoked and wrong-secret all return exactly this. The
 * distinctions are real but telling the caller which one applies hands an
 * attacker a free oracle for probing key space, and none of them changes what
 * a legitimate caller should do: get a working key.
 */
const AUTH_FAILED = "Invalid or missing API key. Send it as: Authorization: Bearer sk_live_…";

const authFault = () =>
  new ApiFault("unauthorized", AUTH_FAILED, undefined, {
    "WWW-Authenticate": 'Bearer realm="api"',
  });

/**
 * Authenticates a request and returns the caller, or throws an ApiFault.
 *
 * `billable` describes what the route is about to do, not what it costs to
 * authenticate: an endpoint that will call the model is checked against the
 * monthly quota, one that is pure arithmetic is not.
 */
export function authenticate(req: Request, opts: { billable: boolean }): Caller {
  const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const presented = bearerFrom(req.headers.get("authorization"));
  if (!presented) throw authFault();

  const parsed = parseKey(presented);
  if (!parsed) throw authFault();

  const row = findKeyByLookup(parsed.lookup);
  if (!row || row.revokedAt) throw authFault();
  if (!digestMatches(keyHashFor(presented), row.hash)) throw authFault();

  const account = getAccount(row.accountId);
  if (!account) throw authFault();

  if (account.disabledAt) {
    throw new ApiFault(
      "forbidden",
      "This account is disabled. Contact support to re-enable it.",
    );
  }

  const usage = usageWindow(account);

  // ── Rate limit ────────────────────────────────────────────────────
  // A fixed window, not a token bucket. It is coarse — a caller can fire two
  // full windows back to back across a boundary — but it is one indexed COUNT
  // and it needs no shared state beyond the table we already write. Swap it
  // for a bucket when the burst actually hurts, not before.
  if (usage.requestsThisMinute >= account.ratePerMin) {
    recordUsage(account.id, "rate_limited", false, 429);
    throw new ApiFault(
      "rate_limited",
      `Rate limit is ${account.ratePerMin} requests per minute. Retry shortly.`,
      undefined,
      { "Retry-After": "60", ...rateHeaders(usage, 0) },
    );
  }

  // ── Monthly quota ─────────────────────────────────────────────────
  if (opts.billable && usage.billableUsed >= account.monthlyQuota) {
    recordUsage(account.id, "quota_exceeded", false, 429);
    const resets = nextPeriodStart(usage.periodStart);
    throw new ApiFault(
      "quota_exceeded",
      `Monthly allowance of ${account.monthlyQuota} estimates is spent. It resets at ${resets}.`,
      undefined,
      { "Retry-After": String(secondsUntil(resets)), ...quotaHeaders(usage) },
    );
  }

  touchKey(row.lookup);
  return { account, env: parsed.env, keyLookup: row.lookup, usage, requestId };
}

/**
 * Headers a caller can use to pace themselves without parsing an error body.
 * A client that has to hit 429 to discover a limit is a client that hits 429.
 */
export function rateHeaders(usage: UsageWindow, spentThisRequest = 1): Record<string, string> {
  const remaining = Math.max(usage.ratePerMin - usage.requestsThisMinute - spentThisRequest, 0);
  return {
    "RateLimit-Limit": String(usage.ratePerMin),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": "60",
  };
}

export function quotaHeaders(usage: UsageWindow, spentThisRequest = 0): Record<string, string> {
  const remaining = Math.max(usage.quota - usage.billableUsed - spentThisRequest, 0);
  return {
    "X-Quota-Limit": String(usage.quota),
    "X-Quota-Remaining": String(remaining),
    "X-Quota-Period-Start": usage.periodStart,
  };
}

/**
 * Resolves the detail level for a request against what the account may have.
 *
 * Asking for more than you are entitled to is a 403, not a silent downgrade.
 * Quietly returning `summary` to a caller who asked for `lines` would have them
 * parsing a response missing the fields they built against, and they would
 * blame their own code before they blamed our entitlement.
 */
export function resolveDetail(caller: Caller, requested: DetailLevel | undefined): DetailLevel {
  const want = requested ?? "summary";
  if (want === "lines" && caller.account.maxDetail !== "lines") {
    throw new ApiFault(
      "forbidden",
      'This key is not entitled to detail="lines". It returns totals, the bid band and cost ' +
        "composition; per-line costs and labour hours require a line-detail plan.",
    );
  }
  return want;
}

/**
 * Whether this caller may send overrides that reveal the rate card.
 *
 * A quantity or a markup is the caller's own number and discloses nothing. A
 * wage rate or a material unit cost is different: with a published labour or
 * material subtotal, setting a known rate and reading the resulting total
 * solves for hours or quantities consumed. That is the assumption set, obtained
 * by arithmetic instead of by request, so it sits behind the same entitlement.
 */
export function assertMayOverrideRates(caller: Caller): void {
  if (caller.account.maxDetail !== "lines") {
    throw new ApiFault(
      "forbidden",
      "wage_rates and material_unit_costs overrides require a line-detail plan. " +
        "quantities and markups are available on every plan.",
    );
  }
}

export const nextPeriodStart = (periodStart: string): string => {
  const d = new Date(periodStart);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

const secondsUntil = (iso: string) => Math.max(Math.ceil((Date.parse(iso) - Date.now()) / 1000), 1);
