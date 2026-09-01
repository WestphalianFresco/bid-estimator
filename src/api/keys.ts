import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API credentials.
 *
 * ## The two rules this file exists to enforce
 *
 * **1. We never store a key we could read back.** Only a SHA-256 digest goes
 * to the database. If the database leaks, the attacker gets hashes, not
 * working credentials. The consequence is that a key is displayed exactly once
 * — at creation — and "I lost my key" is answered by issuing a new one, never
 * by looking the old one up. That trade is worth taking and it is not
 * reversible later, which is why it is decided here at the start.
 *
 * A password KDF (bcrypt/argon2) is the right answer for *passwords*, which
 * are short, low-entropy and human-chosen. These are 256 bits from a CSPRNG.
 * Brute force is not the threat, so a plain fast digest is correct — and it
 * has to be fast, because it runs on every single request.
 *
 * **2. Comparison is constant-time.** A byte-by-byte early-exit comparison
 * leaks the digest through timing, one byte at a time.
 *
 * ## Key shape
 *
 *     sk_live_7f3a2b1c   9d4e...  (32 more chars)
 *     └──┬───┘└──┬───┘   └──┬──┘
 *     env prefix  lookup     secret
 *
 * The lookup segment is stored in the clear and indexed, so verification is a
 * single indexed read rather than a scan-and-hash over every key in the table.
 * It is not a secret: it identifies which row to check, and the check still
 * requires the secret half.
 *
 * The `sk_live_` / `sk_test_` prefix is there so that a key pasted into a
 * GitHub issue is greppable — ours and GitHub's secret scanners both key off
 * a recognisable prefix, and a key that looks like generic base64 gets leaked
 * silently forever.
 */

export type KeyEnv = "live" | "test";

const LOOKUP_CHARS = 8;
const SECRET_BYTES = 24; // 192 bits, base64url → 32 chars

export interface GeneratedKey {
  /** The full credential. Shown once, at creation, and never recoverable. */
  plaintext: string;
  /** Stored in the clear; identifies the row to check. */
  lookup: string;
  /** Stored instead of the key. */
  hash: string;
  env: KeyEnv;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function generateKey(env: KeyEnv): GeneratedKey {
  const lookup = b64url(randomBytes(6)).slice(0, LOOKUP_CHARS);
  const secret = b64url(randomBytes(SECRET_BYTES));
  const plaintext = `sk_${env}_${lookup}${secret}`;
  return { plaintext, lookup, hash: hashKey(plaintext), env };
}

export const hashKey = (plaintext: string): string =>
  createHash("sha256").update(plaintext, "utf8").digest("hex");

export interface ParsedKey {
  env: KeyEnv;
  lookup: string;
}

/**
 * Splits a presented credential far enough to find its row.
 *
 * Returns null for anything malformed. The caller must answer a malformed key
 * and an unknown key identically — "unauthorized", no further detail. Telling
 * the difference between "that is not a key" and "that key does not exist"
 * hands an attacker a free oracle.
 */
export function parseKey(plaintext: string): ParsedKey | null {
  const m = /^sk_(live|test)_([A-Za-z0-9_-]{8})([A-Za-z0-9_-]{24,})$/.exec(plaintext);
  if (!m) return null;
  return { env: m[1] as KeyEnv, lookup: m[2] };
}

/** Constant-time digest comparison. */
export function digestMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(stored, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reads the credential out of an Authorization header.
 *
 * Bearer only. Some APIs also accept the key in a query parameter for
 * convenience; we do not, because query strings end up in access logs, browser
 * history, referrer headers and CDN caches, and a credential that lands in any
 * of those is a credential that has to be rotated.
 */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/**
 * How a key is shown once it can no longer be shown in full — in a dashboard
 * list, an audit log, or an error message.
 */
export const maskKey = (env: KeyEnv, lookup: string): string => `sk_${env}_${lookup}…`;
