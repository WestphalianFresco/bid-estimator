import { nextPeriodStart } from "@/lib/api/auth";
import { usageWindow } from "@/lib/api/store";
import { route, type RouteContext } from "../_lib/handler";

/**
 * GET /v1/usage — where this account stands against its limits.
 *
 * Free, and not rate-limit-exempt on purpose: a client polling this in a tight
 * loop is a client with a bug, and it should hit the same ceiling as anything
 * else rather than get a private fast path.
 *
 * The limits are already on every response as headers. This endpoint exists
 * because a caller wanting to show "82 of 100 estimates used" on their own
 * dashboard should not have to make a billable request to read a header.
 */

export const runtime = "nodejs";

async function usage({ caller }: RouteContext): Promise<Response> {
  const u = usageWindow(caller.account);
  return Response.json({
    object: "usage",
    account: {
      id: caller.account.id,
      name: caller.account.name,
      /** Which tier this key is on. See serialize.ts for what each discloses. */
      detail_level: caller.account.maxDetail,
    },
    key: {
      /** live or test — the same account can hold both. */
      environment: caller.env,
    },
    period: {
      start: u.periodStart,
      resets_at: nextPeriodStart(u.periodStart),
    },
    estimates: {
      used: u.billableUsed,
      limit: u.quota,
      remaining: Math.max(u.quota - u.billableUsed, 0),
    },
    rate_limit: {
      requests_last_minute: u.requestsThisMinute,
      limit_per_minute: u.ratePerMin,
    },
  });
}

export const GET = route({ name: "usage.retrieve", billable: false, handler: usage });
