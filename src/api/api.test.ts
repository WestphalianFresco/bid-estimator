import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bearerFrom, digestMatches, generateKey, hashKey, maskKey, parseKey } from "./keys";
import {
  claimIdempotency,
  completeIdempotency,
  createAccount,
  findKeyByLookup,
  getEstimate,
  issueKey,
  listEstimates,
  openDb,
  recordUsage,
  releaseIdempotency,
  resetDb,
  revokeKey,
  saveEstimate,
  updateAccount,
  usageWindow,
} from "./store";
import { assertNoAssumptionsLeaked, toPublicEstimate } from "./serialize";
import { STARTING_DEFAULTS } from "../assumptions";
import { priceEstimate, type PriceInput } from "../price";
import { priceBands } from "../bands";
import { summarizeComposition } from "../rollups";
import { makeFixtureWageTable } from "../data/wage-determinations";
import type { EstimateSnapshot, ExtractedScope } from "../schema";

/**
 * Tests for the public API layer.
 *
 * Two things are being protected here, and they are not the same thing.
 *
 * **Credentials.** A key must not be readable back out of storage, a revoked
 * key must stop working, and one account must not be able to read another's
 * estimates. These are the failures that end a business rather than annoy a
 * customer.
 *
 * **The rate card.** `serialize.ts` exists to keep the assumption set inside
 * this process. The leak tests below are the reason it can be trusted: the
 * check is not "did we remember", it is "does the suite fail if we forget".
 */

beforeEach(() => {
  process.env.API_DB_PATH = ":memory:";
  resetDb();
  openDb(":memory:");
});

afterEach(() => {
  resetDb();
});

// ── Key material ────────────────────────────────────────────────────

describe("api keys", () => {
  it("issues a key matching the documented shape", () => {
    const k = generateKey("live");
    expect(k.plaintext.startsWith("sk_live_")).toBe(true);
    expect(parseKey(k.plaintext)).toEqual({ env: "live", lookup: k.lookup });
  });

  it("never stores anything the plaintext can be recovered from", () => {
    const account = createAccount("Acme");
    const issued = issueKey(account.id, "live");
    const row = findKeyByLookup(issued.lookup)!;

    expect(row.hash).not.toContain(issued.plaintext);
    expect(row.hash).toBe(hashKey(issued.plaintext));
    // The lookup segment is public by design; the secret half is not present.
    expect(issued.plaintext).toContain(row.lookup);
    expect(row.hash).toHaveLength(64);
  });

  it("rejects malformed credentials without distinguishing the failure", () => {
    expect(parseKey("")).toBeNull();
    expect(parseKey("sk_live_short")).toBeNull();
    expect(parseKey("pk_live_aaaaaaaabbbbbbbbccccccccdddddddd")).toBeNull();
    expect(parseKey("Bearer sk_live_aaaaaaaabbbbbbbbccccccccdddddddd")).toBeNull();
  });

  it("reads only a Bearer credential, never a query parameter", () => {
    expect(bearerFrom("Bearer sk_live_abc")).toBe("sk_live_abc");
    expect(bearerFrom("bearer sk_live_abc")).toBe("sk_live_abc");
    expect(bearerFrom("Basic sk_live_abc")).toBeNull();
    expect(bearerFrom(null)).toBeNull();
  });

  it("compares digests without leaking length or content", () => {
    const a = hashKey("one");
    expect(digestMatches(a, a)).toBe(true);
    expect(digestMatches(a, hashKey("two"))).toBe(false);
    expect(digestMatches(a, "short")).toBe(false);
  });

  it("masks a key for display", () => {
    expect(maskKey("test", "abcd1234")).toBe("sk_test_abcd1234…");
  });

  it("revokes a key once and reports the second attempt honestly", () => {
    const account = createAccount("Acme");
    const issued = issueKey(account.id, "live");
    expect(revokeKey(issued.lookup)).toBe(true);
    expect(revokeKey(issued.lookup)).toBe(false);
    expect(findKeyByLookup(issued.lookup)!.revokedAt).not.toBeNull();
  });
});

// ── Tenant isolation ────────────────────────────────────────────────

describe("account isolation", () => {
  const stub = (id: string) => ({
    id,
    accountId: "",
    env: "live" as const,
    snapshot: { id },
    extras: {},
    bidPrice: 123_45,
  });

  it("does not return one account's estimate to another", () => {
    const a = createAccount("Acme");
    const b = createAccount("Rival");
    saveEstimate({ ...stub("est_1"), accountId: a.id });

    expect(getEstimate(a.id, "est_1")).not.toBeNull();
    // The id is correct and exists; the account is not. This must be a miss,
    // not a hit, or an unguessable id becomes the only thing standing between
    // two customers.
    expect(getEstimate(b.id, "est_1")).toBeNull();
  });

  it("scopes listing by account", () => {
    const a = createAccount("Acme");
    const b = createAccount("Rival");
    saveEstimate({ ...stub("est_a"), accountId: a.id });
    saveEstimate({ ...stub("est_b"), accountId: b.id });

    expect(listEstimates(a.id).map((e) => e.id)).toEqual(["est_a"]);
    expect(listEstimates(b.id).map((e) => e.id)).toEqual(["est_b"]);
  });
});

// ── Metering ────────────────────────────────────────────────────────

describe("quota and rate accounting", () => {
  it("counts only successful billable events against the monthly quota", () => {
    const a = createAccount("Acme", { monthlyQuota: 10 });
    recordUsage(a.id, "estimates.create", true, 201);
    recordUsage(a.id, "estimates.create", true, 201);
    // Failed on our side: the caller got nothing, so it costs them nothing.
    recordUsage(a.id, "estimates.create", true, 500);
    // Free endpoints never touch the allowance.
    recordUsage(a.id, "estimates.retrieve", false, 200);

    const u = usageWindow(a);
    expect(u.billableUsed).toBe(2);
    expect(u.quota).toBe(10);
  });

  it("counts every request against the rate limit, successful or not", () => {
    const a = createAccount("Acme", { ratePerMin: 60 });
    recordUsage(a.id, "estimates.create", true, 201);
    recordUsage(a.id, "estimates.create", true, 500);
    recordUsage(a.id, "usage.retrieve", false, 200);
    // A request that fails still cost us the work of failing it.
    expect(usageWindow(a).requestsThisMinute).toBe(3);
  });

  it("excludes events from an earlier period", () => {
    const a = createAccount("Acme");
    recordUsage(a.id, "estimates.create", true, 201);
    // Look at the window from a month in the future: last month's usage is not
    // in it, which is what makes the allowance monthly rather than lifetime.
    const future = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    expect(usageWindow(a, future).billableUsed).toBe(0);
  });
});

describe("plan changes", () => {
  it("raises a limit without disturbing the others", () => {
    const a = createAccount("Acme", { monthlyQuota: 100, ratePerMin: 60 });
    const updated = updateAccount(a.id, { monthlyQuota: 1000 })!;
    expect(updated.monthlyQuota).toBe(1000);
    expect(updated.ratePerMin).toBe(60);
    expect(updated.maxDetail).toBe("summary");
  });

  it("disables and re-enables an account", () => {
    const a = createAccount("Acme");
    expect(updateAccount(a.id, { disabled: true })!.disabledAt).not.toBeNull();
    expect(updateAccount(a.id, { disabled: false })!.disabledAt).toBeNull();
  });
});

// ── Idempotency ─────────────────────────────────────────────────────

describe("idempotency", () => {
  it("claims a fresh key, then replays it", () => {
    const a = createAccount("Acme");
    expect(claimIdempotency(a.id, "k1", "hash-1")).toEqual({ state: "fresh" });

    // Second call while the first is in flight: no estimate id yet.
    expect(claimIdempotency(a.id, "k1", "hash-1")).toEqual({ state: "replay", estimateId: null });

    completeIdempotency(a.id, "k1", "est_1");
    expect(claimIdempotency(a.id, "k1", "hash-1")).toEqual({
      state: "replay",
      estimateId: "est_1",
    });
  });

  it("reports a conflict when the same key carries a different body", () => {
    const a = createAccount("Acme");
    claimIdempotency(a.id, "k1", "hash-1");
    expect(claimIdempotency(a.id, "k1", "hash-2")).toEqual({ state: "conflict" });
  });

  it("frees a key whose request failed, so the retry works", () => {
    const a = createAccount("Acme");
    claimIdempotency(a.id, "k1", "hash-1");
    releaseIdempotency(a.id, "k1");
    expect(claimIdempotency(a.id, "k1", "hash-1")).toEqual({ state: "fresh" });
  });

  it("does not let one account's key collide with another's", () => {
    const a = createAccount("Acme");
    const b = createAccount("Rival");
    claimIdempotency(a.id, "shared-key", "hash-1");
    expect(claimIdempotency(b.id, "shared-key", "hash-1")).toEqual({ state: "fresh" });
  });
});

// ── Disclosure ──────────────────────────────────────────────────────

/** A small real estimate, priced by the engine, for the serializer tests. */
function realEstimate() {
  const scope: ExtractedScope = {
    project_title: "Roof replacement, Building 12",
    naics_code: "236220",
    psc_code: null,
    state: "CA",
    county: "Sacramento",
    location_quote: "Sacramento County, California",
    gross_square_feet: 20_000,
    duration_months: 6,
    delivery_method: "design_bid_build",
    davis_bacon_applies: true,
    bonding_required: true,
    items: [
      {
        csi_division: "07",
        description: "Remove and replace built-up roofing",
        quantity: 20_000,
        unit: "SF",
        assumption_key: "07-roof-membrane-epdm",
        work_type: "roof_membrane",
        match_confidence: "close",
        confidence: "stated",
        source_quote: "Replace roofing throughout, approx. 20,000 SF",
      },
    ],
    missing_information: ["Roof deck condition was not described"],
    clarification_questions: ["Is tear-off to deck or overlay?"],
  };

  const input: PriceInput = {
    scope,
    assumptions: STARTING_DEFAULTS,
    wages: makeFixtureWageTable("CA"),
    comparables: [],
  };
  const estimate = priceEstimate(input);

  const snapshot: EstimateSnapshot = {
    id: "est_test",
    createdAt: "2026-01-15T00:00:00.000Z",
    engineVersion: "test",
    inputText: "Replace roofing throughout, approx. 20,000 SF, Sacramento County CA.",
    scope,
    assumptionsSnapshot: STARTING_DEFAULTS,
    wageDeterminationId: "FIXTURE-DO-NOT-USE-IN-PROD",
    materialPricing: {
      source: "catalog_default",
      fetchedAt: null,
      zip: null,
      retailFactor: null,
      appliedKeys: [],
      unsourcedKeys: [],
    },
    estimate,
  };

  return {
    snapshot,
    bands: priceBands(input),
    composition: summarizeComposition(estimate, scope),
  };
}

describe("what a caller is allowed to see", () => {
  it("never publishes the assumption set, at any detail level", () => {
    const { snapshot, bands, composition } = realEstimate();

    for (const detail of ["summary", "lines"] as const) {
      const body = toPublicEstimate({ snapshot, bands, composition, detail });
      const json = JSON.stringify(body);

      // Checked as JSON *keys*, not as substrings. A warning that reads "has
      // no productivity assumption" is prose explaining why a line went
      // unpriced, and the caller needs it; a field literally named
      // "productivity" would be the rate card.
      expect(json).not.toContain('"assumptionsSnapshot"');
      expect(json).not.toContain('"hoursPerUnit"');
      expect(json).not.toContain('"productivity"');
      expect(json).not.toContain('"markupSchedule"');
      expect(json).not.toContain('"loadedRate"');
      expect(json).not.toContain('"crew"');
      // The input document is the caller's own, but echoing it back on every
      // read is wasted bandwidth, so it is not carried either.
      expect(json).not.toContain(snapshot.inputText);
      expect(() => assertNoAssumptionsLeaked(body)).not.toThrow();
    }
  });

  it("withholds labour hours at summary detail and includes them at lines", () => {
    const { snapshot, bands, composition } = realEstimate();

    const summary = toPublicEstimate({ snapshot, bands, composition, detail: "summary" });
    expect(summary.lines).toBeUndefined();
    expect(summary.composition.labor_hours).toBeUndefined();

    const lines = toPublicEstimate({ snapshot, bands, composition, detail: "lines" });
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines![0].labor_hours).toBeGreaterThan(0);
    expect(lines.composition.labor_hours).toBeGreaterThan(0);
  });

  it("publishes the bid price identically at both detail levels", () => {
    const { snapshot, bands, composition } = realEstimate();
    const s = toPublicEstimate({ snapshot, bands, composition, detail: "summary" });
    const l = toPublicEstimate({ snapshot, bands, composition, detail: "lines" });
    // Detail controls disclosure, never the answer. A caller on the cheaper
    // plan gets less explanation, not a different number.
    expect(s.totals.bid_price.cents).toBe(l.totals.bid_price.cents);
  });

  it("publishes every amount as an integer cents value alongside the float", () => {
    const { snapshot, bands, composition } = realEstimate();
    const body = toPublicEstimate({ snapshot, bands, composition, detail: "summary" });

    expect(Number.isInteger(body.totals.bid_price.cents)).toBe(true);
    expect(body.totals.bid_price.dollars).toBeCloseTo(body.totals.bid_price.cents / 100, 6);
    for (const band of body.bands) {
      expect(Number.isInteger(band.bid_price.cents)).toBe(true);
    }
  });

  it("carries the disclaimer and the accuracy class inside the payload", () => {
    const { snapshot, bands, composition } = realEstimate();
    const body = toPublicEstimate({ snapshot, bands, composition, detail: "summary" });
    // In the body, not only in the docs: a downstream renderer drops what it
    // does not know about, and this must not be droppable by accident.
    expect(body.disclaimer).toMatch(/not a detailed bid estimate/i);
    expect(body.accuracy_class).toBe("AACE Class 4-5");
    expect(body.wage_determination_id).toBe("FIXTURE-DO-NOT-USE-IN-PROD");
  });

  it("passes through the questions a human still has to answer", () => {
    const { snapshot, bands, composition } = realEstimate();
    const body = toPublicEstimate({ snapshot, bands, composition, detail: "summary" });
    expect(body.missing_information.length).toBeGreaterThan(0);
    expect(body.clarification_questions.length).toBeGreaterThan(0);
  });

  it("fails loudly if the assumption set is ever attached to a response", () => {
    // The guard is the point: someone will eventually pass a snapshot straight
    // through, and this is what turns that into a failing test.
    expect(() =>
      assertNoAssumptionsLeaked({ estimate: { assumptionsSnapshot: STARTING_DEFAULTS } }),
    ).toThrow(/not public/);
    expect(() => assertNoAssumptionsLeaked({ line: { hours_per_unit: 0.02 } })).toThrow(
      /not public/,
    );
  });
});
