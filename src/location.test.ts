import { describe, expect, it, vi } from "vitest";
import { isUsState, US_STATES } from "./schema";
import { fetchComparables } from "./data/comparables";
import {
  EMPTY_WAGE_TABLE,
  fetchWageDetermination,
  makeFixtureWageTable,
} from "./data/wage-determinations";

/**
 * Location is the largest single driver of cost in this model, and the one the
 * document most often fails to state. These tests pin the behaviour that an
 * unresolved location degrades visibly instead of reaching an API as a
 * placeholder string.
 */

describe("state codes", () => {
  it("accepts the fifty states, DC and the territories", () => {
    expect(US_STATES).toHaveLength(56);
    expect(isUsState("CA")).toBe(true);
    expect(isUsState("DC")).toBe(true);
    expect(isUsState("PR")).toBe(true);
  });

  it("rejects the placeholder that reached USAspending as a 422", () => {
    expect(isUsState("UNKNOWN")).toBe(false);
  });

  it("rejects lowercase, full names and empty strings", () => {
    expect(isUsState("ca")).toBe(false);
    expect(isUsState("California")).toBe(false);
    expect(isUsState("")).toBe(false);
    expect(isUsState(null)).toBe(false);
    expect(isUsState(undefined)).toBe(false);
  });
});

describe("comparables with an unresolved location", () => {
  it("returns an empty result without calling the API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await fetchComparables({ naics: "236220", state: null });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.awards).toEqual([]);
    expect(result.query.state).toBeNull();
    fetchSpy.mockRestore();
  });

  it("says why the cross-check is missing rather than reporting a failure", async () => {
    const result = await fetchComparables({ naics: "236220", state: null });
    expect(result.caveat).toMatch(/not resolved to a state/i);
    expect(result.caveat).not.toMatch(/failed|error/i);
  });
});

describe("wage determination with an unresolved location", () => {
  it("refuses the lookup instead of sending a bad state code", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      fetchWageDetermination({ state: null, county: "Jefferson", apiKey: "x" }),
    ).rejects.toThrow(/without a state/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("carries a null state through the empty table", () => {
    expect(EMPTY_WAGE_TABLE.state).toBeNull();
  });

  it("lets the fixture table hold an unresolved location", () => {
    const t = makeFixtureWageTable(null, "Jefferson");
    expect(t.state).toBeNull();
    expect(t.county).toBe("Jefferson");
    // Rates are still returned — the fixture is location-independent, which is
    // exactly why it is not valid for bidding.
    expect(Object.keys(t.rates).length).toBeGreaterThan(0);
  });
});
