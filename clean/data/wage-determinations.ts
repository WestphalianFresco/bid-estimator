import { add, fromDollars, scale, type Cents } from "../money";
import type { Trade } from "../schema";

export interface WageRate {
  trade: Trade;
  baseRate: Cents;
  fringe: Cents;
  classification: string;
}

export interface WageTable {
  determinationId: string;
  effectiveDate: string;
  state: string;
  county: string | null;
  rates: Partial<Record<Trade, WageRate>>;
}

export const loadedRate = (r: WageRate, burdenPct: number): Cents =>
  add(scale(r.baseRate, 1 + burdenPct), r.fringe);

export const EMPTY_WAGE_TABLE: WageTable = {
  determinationId: "",
  effectiveDate: "",
  state: "",
  county: null,
  rates: {},
};

export async function fetchWageDetermination(opts: {
  state: string;
  county: string | null;
  apiKey: string;
}): Promise<WageTable> {
  const url = new URL("https://api.sam.gov/prod/wageDetermination/v1/search");
  url.searchParams.set("api_key", opts.apiKey);
  url.searchParams.set("state", opts.state);
  if (opts.county) url.searchParams.set("county", opts.county);
  url.searchParams.set("constructionType", "Building");

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `SAM.gov wage determination lookup failed ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }

  const raw: unknown = await res.json();
  return parseWageDetermination(raw, opts.state, opts.county);
}

export function parseWageDetermination(
  raw: unknown,
  state: string,
  county: string | null,
): WageTable {
  const doc = raw as {
    determinationNumber?: string;
    effectiveDate?: string;
    classifications?: Array<{
      classification?: string;
      basicHourlyRate?: number;
      fringeBenefits?: number;
    }>;
  };

  const rates: Partial<Record<Trade, WageRate>> = {};

  for (const c of doc.classifications ?? []) {
    const label = c.classification ?? "";
    const trade = mapClassificationToTrade(label);
    if (!trade) continue;

    const candidate: WageRate = {
      trade,
      baseRate: fromDollars(c.basicHourlyRate ?? 0),
      fringe: fromDollars(c.fringeBenefits ?? 0),
      classification: label,
    };
    const existing = rates[trade];
    if (!existing || candidate.baseRate > existing.baseRate) {
      rates[trade] = candidate;
    }
  }

  return {
    determinationId: doc.determinationNumber ?? "",
    effectiveDate: doc.effectiveDate ?? "",
    state,
    county,
    rates,
  };
}

export function mapClassificationToTrade(label: string): Trade | null {
  const s = label.toUpperCase();

  if (s.includes("SHEET METAL")) return "sheet_metal_worker";
  if (s.includes("CEMENT MASON") || s.includes("CONCRETE FINISHER")) return "cement_mason";
  if (s.includes("TRUCK DRIVER") || s.includes("TEAMSTER")) return "truck_driver";
  if (s.includes("OPERATING ENGINEER") || s.startsWith("OPERATOR") || s.includes("POWER EQUIPMENT"))
    return "operating_engineer";
  if (s.includes("PIPEFITTER") || s.includes("STEAMFITTER")) return "pipefitter";
  if (s.includes("INSULATION") || s.includes("ASBESTOS WORKER")) return "insulation_worker";
  if (s.includes("IRONWORKER") || s.includes("REINFORCING") || s.includes("STRUCTURAL STEEL"))
    return "ironworker";
  if (s.includes("BRICKLAYER") || s.includes("MASON")) return "bricklayer";
  if (s.includes("ELECTRICIAN")) return "electrician";
  if (s.includes("PLUMBER")) return "plumber";
  if (s.includes("CARPENTER")) return "carpenter";
  if (s.includes("ROOFER")) return "roofer";
  if (s.includes("PAINTER")) return "painter";
  if (s.includes("GLAZIER")) return "glazier";
  if (s.includes("LABORER")) return "laborer";

  return null;
}

export const isStale = (t: WageTable, today: string): boolean => {
  if (!t.effectiveDate) return true;
  const eff = Date.parse(t.effectiveDate);
  const now = Date.parse(today);
  if (Number.isNaN(eff) || Number.isNaN(now)) return true;
  return now - eff > 365 * 24 * 60 * 60 * 1000;
};

export const makeFixtureWageTable = (state = "CA", county = "Los Angeles"): WageTable => ({
  determinationId: "FIXTURE-DO-NOT-USE-IN-PROD",
  effectiveDate: "2026-01-01",
  state,
  county,
  rates: {
    laborer: { trade: "laborer", baseRate: fromDollars(32.5), fringe: fromDollars(14.2), classification: "LABORER: Common or General" },
    carpenter: { trade: "carpenter", baseRate: fromDollars(48.1), fringe: fromDollars(19.8), classification: "CARPENTER" },
    electrician: { trade: "electrician", baseRate: fromDollars(56.4), fringe: fromDollars(23.1), classification: "ELECTRICIAN" },
    plumber: { trade: "plumber", baseRate: fromDollars(55.2), fringe: fromDollars(22.4), classification: "PLUMBER" },
    pipefitter: { trade: "pipefitter", baseRate: fromDollars(56.0), fringe: fromDollars(22.9), classification: "PIPEFITTER" },
    ironworker: { trade: "ironworker", baseRate: fromDollars(51.3), fringe: fromDollars(26.7), classification: "IRONWORKER: Structural" },
    cement_mason: { trade: "cement_mason", baseRate: fromDollars(43.8), fringe: fromDollars(18.5), classification: "CEMENT MASON" },
    bricklayer: { trade: "bricklayer", baseRate: fromDollars(45.6), fringe: fromDollars(17.9), classification: "BRICKLAYER" },
    roofer: { trade: "roofer", baseRate: fromDollars(41.2), fringe: fromDollars(15.3), classification: "ROOFER" },
    sheet_metal_worker: { trade: "sheet_metal_worker", baseRate: fromDollars(52.7), fringe: fromDollars(24.0), classification: "SHEET METAL WORKER" },
    painter: { trade: "painter", baseRate: fromDollars(38.9), fringe: fromDollars(14.8), classification: "PAINTER: Brush" },
    operating_engineer: { trade: "operating_engineer", baseRate: fromDollars(50.4), fringe: fromDollars(25.2), classification: "OPERATOR: Bulldozer" },
    truck_driver: { trade: "truck_driver", baseRate: fromDollars(35.1), fringe: fromDollars(21.6), classification: "TRUCK DRIVER: Dump" },
    glazier: { trade: "glazier", baseRate: fromDollars(46.3), fringe: fromDollars(18.1), classification: "GLAZIER" },
    insulation_worker: { trade: "insulation_worker", baseRate: fromDollars(44.0), fringe: fromDollars(19.2), classification: "INSULATION WORKER" },
  },
});
