import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateKey, hashKey, maskKey, type KeyEnv } from "./keys";
import type { DetailLevel } from "./serialize";

/**
 * Persistence for the public API.
 *
 * SQLite, through Node's built-in driver — no dependency, no server to run, and
 * a real transactional store rather than a JSON file that corrupts the first
 * time two requests write at once.
 *
 * ## What this is and is not suited for
 *
 * SQLite is a genuinely good fit here: the write volume is one row per estimate
 * and one counter bump per request, and reads are all single-row indexed
 * lookups. It will carry this API a long way on one machine.
 *
 * It will not survive a platform with an ephemeral or per-instance filesystem —
 * Vercel, Lambda, or anything that scales past one container. There the file
 * either vanishes between requests or forks into one divergent copy per
 * instance, and the quota counters quietly stop meaning anything. Every query
 * lives behind this module for exactly that reason: moving to Postgres is
 * rewriting this file, not touching the routes.
 *
 * ## Money and time
 *
 * Amounts are integer cents, as everywhere else in this codebase. Timestamps
 * are ISO-8601 UTC strings, which sort lexicographically — so "usage this
 * period" is a string range scan rather than date arithmetic in SQL.
 */

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  monthly_quota INTEGER NOT NULL DEFAULT 100,
  rate_per_min  INTEGER NOT NULL DEFAULT 60,
  max_detail    TEXT NOT NULL DEFAULT 'summary' CHECK (max_detail IN ('summary','lines')),
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  lookup       TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  env          TEXT NOT NULL CHECK (env IN ('live','test')),
  hash         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys(account_id);

CREATE TABLE IF NOT EXISTS estimates (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  env        TEXT NOT NULL,
  snapshot   TEXT NOT NULL,
  extras     TEXT NOT NULL,
  bid_price  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS estimates_account_time ON estimates(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  at         TEXT NOT NULL,
  route      TEXT NOT NULL,
  billable   INTEGER NOT NULL,
  status     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_account_time ON usage_events(account_id, at);

CREATE TABLE IF NOT EXISTS idempotency (
  account_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  estimate_id  TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
`;

// Notes on three columns that are not self-explanatory:
//
// accounts.monthly_quota — estimates allowed per calendar month. Each one
//   spends real model tokens, so an account without a ceiling is an account
//   that can hand us an unbounded bill.
//
// estimates.snapshot — the full snapshot as stored, which includes the
//   assumption set. See serialize.ts: the assumption set does not go out over
//   the wire. Storing it is what makes an estimate reproducible; publishing it
//   would be giving away the thing customers are paying to use.
//
// usage_events.billable — only billable events count against the monthly
//   quota. A reprice is pure arithmetic with no model call behind it, so
//   charging for it would be charging for nothing.
//
// accounts.max_detail — the tier this account is entitled to. It is a property
//   of the account and not of the request, because a caller who could simply
//   ask for the higher tier would always ask for it. See serialize.ts for what
//   the two tiers disclose, and reprice for why wage overrides live behind the
//   same gate as line detail: given a published labour subtotal, overriding a
//   wage rate and watching the total move solves for hours, which is the rate
//   card by another route.

// ── Types ───────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  createdAt: string;
  monthlyQuota: number;
  ratePerMin: number;
  /** The highest detail level this account may request. */
  maxDetail: DetailLevel;
  disabledAt: string | null;
}

export interface ApiKeyRow {
  lookup: string;
  accountId: string;
  env: KeyEnv;
  hash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface StoredEstimate {
  id: string;
  accountId: string;
  createdAt: string;
  env: KeyEnv;
  snapshot: unknown;
  extras: unknown;
  bidPrice: number;
}

export interface UsageWindow {
  periodStart: string;
  billableUsed: number;
  quota: number;
  requestsThisMinute: number;
  ratePerMin: number;
}

// ── Connection ──────────────────────────────────────────────────────

/** `YYYY-MM` — the calendar month a timestamp falls in, UTC. */
export const periodOf = (iso: string): string => iso.slice(0, 7);

let db: DatabaseSync | null = null;

/**
 * Opens (once) the database file.
 *
 * Override with API_DB_PATH; tests pass ":memory:". The default sits inside the
 * repo under data/, which the root .gitignore excludes as client data — it
 * holds solicitation text and customer bid prices.
 */
export function openDb(
  path = process.env.API_DB_PATH ?? join(process.cwd(), "data", "api.db"),
): DatabaseSync {
  if (db) return db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  // WAL lets a read run while a write is in flight; without it a slow estimate
  // write blocks every concurrent auth lookup.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** Test seam: drop the cached handle so the next openDb() starts clean. */
export function resetDb(): void {
  db?.close();
  db = null;
}

const nowIso = () => new Date().toISOString();

// ── Accounts ────────────────────────────────────────────────────────

const toAccount = (r: Record<string, unknown>): Account => ({
  id: r.id as string,
  name: r.name as string,
  createdAt: r.created_at as string,
  monthlyQuota: r.monthly_quota as number,
  ratePerMin: r.rate_per_min as number,
  maxDetail: (r.max_detail as DetailLevel) ?? "summary",
  disabledAt: (r.disabled_at as string | null) ?? null,
});

export function createAccount(
  name: string,
  opts: { monthlyQuota?: number; ratePerMin?: number; maxDetail?: DetailLevel } = {},
): Account {
  const account: Account = {
    id: `acct_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    name,
    createdAt: nowIso(),
    monthlyQuota: opts.monthlyQuota ?? 100,
    ratePerMin: opts.ratePerMin ?? 60,
    maxDetail: opts.maxDetail ?? "summary",
    disabledAt: null,
  };
  openDb()
    .prepare(
      `INSERT INTO accounts (id, name, created_at, monthly_quota, rate_per_min, max_detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      account.id,
      account.name,
      account.createdAt,
      account.monthlyQuota,
      account.ratePerMin,
      account.maxDetail,
    );
  return account;
}

/** Changes an account's entitlement or limits. Used by the admin CLI. */
export function updateAccount(
  id: string,
  patch: { monthlyQuota?: number; ratePerMin?: number; maxDetail?: DetailLevel; disabled?: boolean },
): Account | null {
  const current = getAccount(id);
  if (!current) return null;
  openDb()
    .prepare(
      `UPDATE accounts SET monthly_quota = ?, rate_per_min = ?, max_detail = ?, disabled_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.monthlyQuota ?? current.monthlyQuota,
      patch.ratePerMin ?? current.ratePerMin,
      patch.maxDetail ?? current.maxDetail,
      patch.disabled === undefined
        ? current.disabledAt
        : patch.disabled
          ? (current.disabledAt ?? nowIso())
          : null,
      id,
    );
  return getAccount(id);
}

export function getAccount(id: string): Account | null {
  const row = openDb().prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toAccount(row) : null;
}

export function listAccounts(): Account[] {
  const rows = openDb()
    .prepare(`SELECT * FROM accounts ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(toAccount);
}

// ── Keys ────────────────────────────────────────────────────────────

/**
 * Issues a key. The plaintext in the return value is the only place it ever
 * exists outside the caller's hands — nothing here writes it anywhere.
 */
export function issueKey(
  accountId: string,
  env: KeyEnv,
  label = "",
): { plaintext: string; masked: string; lookup: string } {
  if (!getAccount(accountId)) throw new Error(`No such account: ${accountId}`);
  const k = generateKey(env);
  openDb()
    .prepare(
      `INSERT INTO api_keys (lookup, account_id, env, hash, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(k.lookup, accountId, env, k.hash, label, nowIso());
  return { plaintext: k.plaintext, masked: maskKey(env, k.lookup), lookup: k.lookup };
}

export function findKeyByLookup(lookup: string): ApiKeyRow | null {
  const r = openDb().prepare(`SELECT * FROM api_keys WHERE lookup = ?`).get(lookup) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    lookup: r.lookup as string,
    accountId: r.account_id as string,
    env: r.env as KeyEnv,
    hash: r.hash as string,
    label: r.label as string,
    createdAt: r.created_at as string,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

export function touchKey(lookup: string): void {
  openDb().prepare(`UPDATE api_keys SET last_used_at = ? WHERE lookup = ?`).run(nowIso(), lookup);
}

export function revokeKey(lookup: string): boolean {
  const res = openDb()
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE lookup = ? AND revoked_at IS NULL`)
    .run(nowIso(), lookup);
  return Number(res.changes) > 0;
}

export function listKeys(accountId: string): ApiKeyRow[] {
  const rows = openDb()
    .prepare(`SELECT lookup FROM api_keys WHERE account_id = ? ORDER BY created_at DESC`)
    .all(accountId) as { lookup: string }[];
  return rows.map((r) => findKeyByLookup(r.lookup)).filter((k): k is ApiKeyRow => k !== null);
}

/** Re-exported so routes never import the crypto module directly. */
export const keyHashFor = hashKey;

// ── Estimates ───────────────────────────────────────────────────────

export function saveEstimate(e: {
  id: string;
  accountId: string;
  env: KeyEnv;
  snapshot: unknown;
  extras: unknown;
  bidPrice: number;
}): void {
  openDb()
    .prepare(
      `INSERT INTO estimates (id, account_id, created_at, env, snapshot, extras, bid_price)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      e.accountId,
      nowIso(),
      e.env,
      JSON.stringify(e.snapshot),
      JSON.stringify(e.extras),
      e.bidPrice,
    );
}

const toEstimate = (r: Record<string, unknown>): StoredEstimate => ({
  id: r.id as string,
  accountId: r.account_id as string,
  createdAt: r.created_at as string,
  env: r.env as KeyEnv,
  snapshot: JSON.parse(r.snapshot as string),
  extras: JSON.parse(r.extras as string),
  bidPrice: r.bid_price as number,
});

/**
 * Scoped by account on purpose. An id is a UUID and therefore unguessable, but
 * unguessable is not an authorisation model — the account predicate is what
 * actually stops one customer reading another's bid, and it belongs in the
 * query rather than in a caller who might forget it.
 */
export function getEstimate(accountId: string, id: string): StoredEstimate | null {
  const r = openDb()
    .prepare(`SELECT * FROM estimates WHERE id = ? AND account_id = ?`)
    .get(id, accountId) as Record<string, unknown> | undefined;
  return r ? toEstimate(r) : null;
}

export function listEstimates(
  accountId: string,
  opts: { limit?: number; before?: string } = {},
): StoredEstimate[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = opts.before
    ? (openDb()
        .prepare(
          `SELECT * FROM estimates WHERE account_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(accountId, opts.before, limit) as Record<string, unknown>[])
    : (openDb()
        .prepare(`SELECT * FROM estimates WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(accountId, limit) as Record<string, unknown>[]);
  return rows.map(toEstimate);
}

// ── Metering ────────────────────────────────────────────────────────

export function recordUsage(
  accountId: string,
  route: string,
  billable: boolean,
  status: number,
): void {
  openDb()
    .prepare(
      `INSERT INTO usage_events (id, account_id, at, route, billable, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), accountId, nowIso(), route, billable ? 1 : 0, status);
}

/**
 * Current standing against both limits.
 *
 * Failed requests do not consume monthly quota — a caller should not lose a
 * paid estimate because our model provider timed out. They do consume rate
 * limit, because the point of a rate limit is to bound load, and a request
 * that fails still cost us the work of failing it.
 */
export function usageWindow(account: Account, at = nowIso()): UsageWindow {
  const d = openDb();
  const period = periodOf(at);
  const billable = d
    .prepare(
      `SELECT COUNT(*) AS n FROM usage_events
       WHERE account_id = ? AND billable = 1 AND at >= ? AND status < 400`,
    )
    .get(account.id, `${period}-01T00:00:00.000Z`) as { n: number };

  const minuteAgo = new Date(Date.parse(at) - 60_000).toISOString();
  const recent = d
    .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ? AND at >= ?`)
    .get(account.id, minuteAgo) as { n: number };

  return {
    periodStart: `${period}-01T00:00:00.000Z`,
    billableUsed: Number(billable.n),
    quota: account.monthlyQuota,
    requestsThisMinute: Number(recent.n),
    ratePerMin: account.ratePerMin,
  };
}

// ── Idempotency ─────────────────────────────────────────────────────

export type IdempotencyLookup =
  | { state: "fresh" }
  | { state: "replay"; estimateId: string | null }
  | { state: "conflict" };

/**
 * Claims an idempotency key, or reports what happened last time.
 *
 * The INSERT is the lock: two concurrent requests carrying the same key race
 * to the primary key, exactly one wins, and the loser reads the winner's row.
 * Checking first and inserting second would leave a window where both pass the
 * check — which on this endpoint means two model calls and two charges for one
 * customer intent.
 *
 * An in-flight request is a claimed row with a null estimate_id. A caller that
 * retries while the first attempt is still running gets `replay` with a null
 * id, which the route answers as 409 rather than starting a second run.
 */
export function claimIdempotency(
  accountId: string,
  key: string,
  requestHash: string,
): IdempotencyLookup {
  const d = openDb();
  try {
    d.prepare(
      `INSERT INTO idempotency (account_id, key, request_hash, estimate_id, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(accountId, key, requestHash, nowIso());
    return { state: "fresh" };
  } catch {
    const row = d
      .prepare(`SELECT request_hash, estimate_id FROM idempotency WHERE account_id = ? AND key = ?`)
      .get(accountId, key) as { request_hash: string; estimate_id: string | null } | undefined;
    if (!row) return { state: "fresh" };
    // Same key, different body: the caller has a bug, and silently returning
    // the first result would hide it behind a wrong answer.
    if (row.request_hash !== requestHash) return { state: "conflict" };
    return { state: "replay", estimateId: row.estimate_id };
  }
}

export function completeIdempotency(accountId: string, key: string, estimateId: string): void {
  openDb()
    .prepare(`UPDATE idempotency SET estimate_id = ? WHERE account_id = ? AND key = ?`)
    .run(estimateId, accountId, key);
}

/** Releases a claim whose request failed, so the caller can retry the same key. */
export function releaseIdempotency(accountId: string, key: string): void {
  openDb()
    .prepare(`DELETE FROM idempotency WHERE account_id = ? AND key = ? AND estimate_id IS NULL`)
    .run(accountId, key);
}
