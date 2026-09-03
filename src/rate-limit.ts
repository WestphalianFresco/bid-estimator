/**
 * Per-address cap on expensive endpoints.
 *
 * /api/estimate makes two Opus calls per request and there is no sign-in, so
 * without this anyone holding the URL can spend the API budget in a loop. The
 * cap is deliberately generous for a human estimator and ruinous for a script.
 *
 * ponytail: counters live in this process's memory — correct for one Node
 * process on one box, which is how this is deployed. Two instances would each
 * allow the full quota; move to a shared store (Redis, Cloudflare KV) only if
 * that day comes.
 */

/** Requests allowed per address per window. */
export const RATE_LIMIT = Number(process.env.ESTIMATE_RATE_LIMIT ?? 12);
const WINDOW_MS = 60 * 60 * 1000;
/** Bound the map so a spray of addresses can't grow it without limit. */
const MAX_TRACKED = 10_000;

const hits = new Map<string, number[]>();

/**
 * Cloudflare terminates TLS and forwards the real client address; behind the
 * tunnel, the socket address is always localhost, so the header is the only
 * signal. A caller can forge it, but forging costs them their own quota — the
 * budget stays bounded either way.
 */
export function clientAddress(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** Records a request and reports whether it exceeds the cap. */
export function isRateLimited(headers: Headers, now = Date.now()): boolean {
  if (hits.size > MAX_TRACKED) hits.clear();

  const key = clientAddress(headers);
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= RATE_LIMIT) {
    hits.set(key, recent);
    return true;
  }

  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Test seam — the counters are module state. */
export function resetRateLimits(): void {
  hits.clear();
}
