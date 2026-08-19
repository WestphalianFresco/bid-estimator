import { fromDollars, type Cents } from "../money";

export interface ComparableAward {
  awardId: string;
  recipient: string;
  amount: Cents;
  naics: string | null;
  state: string | null;
  startDate: string | null;
}

export interface ComparablesResult {
  awards: ComparableAward[];
  caveat: string;
  query: { naics: string; psc: string | null; state: string; years: number };
}

const CONTRACT_AWARD_TYPES = ["A", "B", "C", "D"];

export async function fetchComparables(opts: {
  naics: string;
  psc?: string | null;
  state: string;
  years?: number;
  limit?: number;
}): Promise<ComparablesResult> {
  const years = opts.years ?? 3;
  const limit = Math.min(opts.limit ?? 100, 100);

  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - years);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const body = {
    filters: {
      award_type_codes: CONTRACT_AWARD_TYPES,
      naics_codes: [opts.naics],
      ...(opts.psc ? { psc_codes: [opts.psc] } : {}),
      place_of_performance_locations: [{ country: "USA", state: opts.state }],
      time_period: [{ start_date: iso(start), end_date: iso(end) }],
    },
    fields: [
      "Award ID",
      "Recipient Name",
      "Award Amount",
      "NAICS",
      "Place of Performance State Code",
      "Start Date",
    ],
    page: 1,
    limit,
    sort: "Award Amount",
    order: "desc",
  };

  const res = await fetch(
    "https://api.usaspending.gov/api/v2/search/spending_by_award/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    throw new Error(
      `USAspending query failed ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }

  const json = (await res.json()) as {
    results?: Array<Record<string, unknown>>;
  };

  const awards: ComparableAward[] = (json.results ?? [])
    .map((r) => ({
      awardId: String(r["Award ID"] ?? ""),
      recipient: String(r["Recipient Name"] ?? ""),
      amount: fromDollars(Number(r["Award Amount"] ?? 0)),
      naics: r["NAICS"] ? String(r["NAICS"]) : null,
      state: r["Place of Performance State Code"]
        ? String(r["Place of Performance State Code"])
        : null,
      startDate: r["Start Date"] ? String(r["Start Date"]) : null,
    }))
    .filter((a) => a.amount > 0);

  return {
    awards,
    caveat:
      `Federal contract awards from the last ${years} years in ${opts.state} for ` +
      `NAICS ${opts.naics}${opts.psc ? ` / PSC ${opts.psc}` : ""}. ` +
      `Project sizes vary widely; USAspending does not publish square footage or ` +
      `line-item quantities, so this is an order-of-magnitude check only. ` +
      `Award amounts include the contractor's profit and risk premium and are not costs.`,
    query: { naics: opts.naics, psc: opts.psc ?? null, state: opts.state, years },
  };
}

export const amountsOf = (r: ComparablesResult): Cents[] =>
  r.awards.map((a) => a.amount);

export function removeOutliers(amounts: Cents[]): Cents[] {
  if (amounts.length < 8) return amounts;
  const sorted = [...amounts].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter((a) => a >= lo && a <= hi);
}
