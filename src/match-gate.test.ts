import { describe, expect, it } from "vitest";
import { STARTING_DEFAULTS } from "./assumptions";
import { toDollars } from "./money";
import { priceEstimate } from "./price";
import type { ExtractedScope, ScopeItem } from "./schema";
import { makeFixtureWageTable } from "./data/wage-determinations";

/**
 * Regression tests for the match confidence gate.
 *
 * These come from a real run. A residential renovation returned $147,647, of
 * which $50,603 — half the direct cost — was a single line: 120 LF of interior
 * baseboard costed off `06-casework`, the cabinet rate, at $422 per linear
 * foot. Nothing rejected it. The unit agreed (LF), the CSI division agreed
 * (06), and the result was a plausible-looking number a contractor could have
 * bid on.
 *
 * The lesson is not "add more rates". It is that the engine must decline when
 * the rate does not describe the work, because a missing rate announces itself
 * and a wrong rate does not. Every test below is a specific wrong answer that
 * must never come back.
 */

const item = (over: Partial<ScopeItem>): ScopeItem => ({
  csi_division: "06",
  description: "Interior trim and baseboard",
  quantity: 120,
  unit: "LF",
  assumption_key: "06-finish-trim",
  work_type: "finish_carpentry_trim",
  match_confidence: "exact",
  confidence: "stated",
  source_quote: "120 LF of baseboard",
  ...over,
});

const scope = (items: ScopeItem[]): ExtractedScope => ({
  project_title: "Residential renovation",
  naics_code: "236118",
  psc_code: null,
  state: "MD",
  county: "Baltimore",
  location_quote: "Baltimore County, Maryland",
  gross_square_feet: 850,
  duration_months: 2,
  delivery_method: "design_bid_build",
  davis_bacon_applies: false,
  bonding_required: false,
  items,
  missing_information: [],
  clarification_questions: [],
});

const price = (items: ScopeItem[]) =>
  priceEstimate({
    scope: scope(items),
    assumptions: STARTING_DEFAULTS,
    wages: makeFixtureWageTable("MD", "Baltimore"),
  });

describe("120 LF of baseboard is never $50,603", () => {
  it("refuses the casework rate for trim, however well the unit lines up", () => {
    const est = price([
      item({ assumption_key: "06-casework", work_type: "finish_carpentry_trim" }),
    ]);

    expect(est.lines[0].basis).toBe("unpriced");
    expect(toDollars(est.lines[0].directCost)).toBe(0);
    expect(est.warnings.join(" ")).toMatch(/work-type mismatch/i);
    expect(est.warnings.join(" ")).toMatch(/casework/i);
  });

  it("prices trim against the trim rate at a believable per-foot cost", () => {
    const est = price([item({})]);
    const perLf = toDollars(est.lines[0].directCost) / 120;

    expect(est.lines[0].basis).not.toBe("unpriced");
    // Installed baseboard runs a few dollars a foot, not a few hundred.
    expect(perLf).toBeGreaterThan(2);
    expect(perLf).toBeLessThan(15);
  });

  it("keeps the original wrong answer out of reach entirely", () => {
    for (const key of ["06-casework", "06-finish-trim"]) {
      const est = price([item({ assumption_key: key })]);
      expect(toDollars(est.lines[0].directCost)).not.toBeCloseTo(50_603, 0);
    }
  });
});

describe("loose matches are not priced at all", () => {
  it("declines even when the key, unit and work type all line up", () => {
    const est = price([item({ match_confidence: "loose" })]);

    expect(est.lines[0].basis).toBe("unpriced");
    expect(toDollars(est.lines[0].directCost)).toBe(0);
    expect(est.warnings.join(" ")).toMatch(/no rate in the catalog describes this work/i);
  });

  it("names the work type and unit that need a rate", () => {
    const est = price([
      item({
        description: "Quartz countertops",
        quantity: 45,
        unit: "SF",
        work_type: "countertop",
        assumption_key: "01-general-allowance",
        match_confidence: "loose",
      }),
    ]);
    expect(est.warnings.join(" ")).toMatch(/countertop/i);
    expect(est.warnings.join(" ")).toMatch(/measured in SF/i);
  });

  it("still prices a close match, with a warning", () => {
    const est = price([item({ match_confidence: "close" })]);
    expect(est.lines[0].basis).not.toBe("unpriced");
    expect(est.warnings.join(" ")).toMatch(/close but inexact/i);
  });
});

describe("45 SF of quartz is never a lump-sum allowance", () => {
  it("rejects the generic allowance rate for a countertop", () => {
    const est = price([
      item({
        csi_division: "12",
        description: "Quartz countertops",
        quantity: 1,
        unit: "LS",
        work_type: "countertop",
        assumption_key: "01-general-allowance",
        match_confidence: "close",
      }),
    ]);
    expect(est.lines[0].basis).toBe("unpriced");
    expect(est.warnings.join(" ")).toMatch(/work-type mismatch/i);
  });

  it("prices quartz by the square foot at a believable rate", () => {
    const est = price([
      item({
        csi_division: "12",
        description: "Quartz countertops",
        quantity: 45,
        unit: "SF",
        work_type: "countertop",
        assumption_key: "12-countertop-quartz",
        match_confidence: "exact",
      }),
    ]);
    const perSf = toDollars(est.lines[0].directCost) / 45;
    expect(perSf).toBeGreaterThan(40);
    expect(perSf).toBeLessThan(150);
  });
});

describe("device work is counted, not measured in feet", () => {
  it("rejects branch wiring for receptacle replacement", () => {
    const est = price([
      item({
        csi_division: "26",
        description: "Replace 12 receptacles and switches",
        quantity: 500,
        unit: "LF",
        work_type: "electrical_device",
        assumption_key: "26-branch-circuit",
        match_confidence: "close",
      }),
    ]);
    expect(est.lines[0].basis).toBe("unpriced");
    expect(est.warnings.join(" ")).toMatch(/work-type mismatch/i);
  });

  it("prices devices by the each", () => {
    const est = price([
      item({
        csi_division: "26",
        description: "Replace receptacles and switches",
        quantity: 12,
        unit: "EA",
        work_type: "electrical_device",
        assumption_key: "26-device-replace",
        match_confidence: "exact",
      }),
    ]);
    const perEa = toDollars(est.lines[0].directCost) / 12;
    expect(perEa).toBeGreaterThan(20);
    expect(perEa).toBeLessThan(120);
  });
});

describe("gate ordering", () => {
  it("reports the work type before the unit when both disagree", () => {
    // Both are wrong; the work type is the more useful thing to tell someone.
    const est = price([
      item({ assumption_key: "09-painting", work_type: "finish_carpentry_trim" }),
    ]);
    expect(est.warnings.join(" ")).toMatch(/work-type mismatch/i);
    expect(est.warnings.join(" ")).not.toMatch(/unit mismatch/i);
  });

  it("flags a division disagreement without refusing the line", () => {
    const est = price([
      item({
        csi_division: "09",
        assumption_key: "06-finish-trim",
        work_type: "finish_carpentry_trim",
      }),
    ]);
    expect(est.lines[0].basis).not.toBe("unpriced");
    expect(est.warnings.join(" ")).toMatch(/filed under Div 09/i);
  });
});

describe("bond row when no bond is required", () => {
  it("shows no rate rather than a rate against zero dollars", async () => {
    const { waterfallRows } = await import("./price");
    const est = price([item({})]);
    const row = waterfallRows(est.totals, STARTING_DEFAULTS.markups, false).find((r) =>
      r.label.startsWith("Bond premium"),
    )!;

    expect(row.amount).toBe(0);
    expect(row.rate).toBeNull();
    expect(row.label).toMatch(/not required/i);
  });

  it("shows the rate when a bond is required", async () => {
    const { waterfallRows } = await import("./price");
    const est = price([item({})]);
    const row = waterfallRows(est.totals, STARTING_DEFAULTS.markups, true).find((r) =>
      r.label.startsWith("Bond premium"),
    )!;
    expect(row.rate).toBe("1.50%");
  });
});

describe("catalog integrity", () => {
  it("gives trim and casework different work types", () => {
    const trim = STARTING_DEFAULTS.productivity.find((p) => p.key === "06-finish-trim")!;
    const casework = STARTING_DEFAULTS.productivity.find((p) => p.key === "06-casework")!;

    expect(trim.unit).toBe(casework.unit); // the trap: same unit
    expect(trim.csiDivision).toBe(casework.csiDivision); // same division
    expect(trim.workType).not.toBe(casework.workType); // what separates them
  });

  it("declares a work type on every rate", () => {
    for (const p of STARTING_DEFAULTS.productivity) {
      expect(p.workType, `${p.key} has no work type`).toBeTruthy();
    }
  });
});
