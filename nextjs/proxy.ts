import { appendFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { clientAddress } from "@/lib/rate-limit";

// One JSON line per page hit, appended to visits.log in the repo root.
// Read it back with `npm run visits`.
// ponytail: a flat file, not a database; move to SQLite if you ever need
// queries beyond grep/sort.
const LOG = process.env.VISITS_LOG ?? "visits.log";

export function proxy(req: NextRequest) {
  const h = req.headers;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    ip: clientAddress(h),
    country: h.get("cf-ipcountry"),
    path: req.nextUrl.pathname + req.nextUrl.search,
    method: req.method,
    referer: h.get("referer"),
    ua: h.get("user-agent"),
  });
  // fire-and-forget: a logging failure must never break a page
  appendFile(LOG, line + "\n").catch(() => {});
  return NextResponse.next();
}

export const config = {
  // pages and API only; skip Next's own assets, the favicon and prefetches
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
