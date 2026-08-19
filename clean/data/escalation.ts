import type { AssumptionSet } from "../assumptions";

export const PPI_SERIES: Record<string, string> = {};

export interface EscalationOptions {
  apiKey: string;
  asOf: string;
}

export async function computeEscalation(
  assumptions: AssumptionSet,
  opts: EscalationOptions,
): Promise<Record<string, number>> {
  const keys = assumptions.material
    .map((m) => m.key)
    .filter((k) => PPI_SERIES[k]);

  if (keys.length === 0) return {};

  const seriesIds = [...new Set(keys.map((k) => PPI_SERIES[k]))];
  const asOfYear = new Date(opts.asOf).getFullYear();
  const earliest = Math.min(
    ...assumptions.material
      .filter((m) => PPI_SERIES[m.key])
      .map((m) => new Date(m.pricedAsOf).getFullYear()),
  );

  const res = await fetch(
    "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seriesid: seriesIds,
        startyear: String(earliest),
        endyear: String(asOfYear),
        registrationkey: opts.apiKey,
      }),
    },
  );

  if (!res.ok) {
    console.warn(`BLS PPI query failed ${res.status}; skipping material escalation`);
    return {};
  }

  const index = parseSeries(await res.json());
  const factors: Record<string, number> = {};

  for (const mat of assumptions.material) {
    const series = PPI_SERIES[mat.key];
    if (!series) continue;
    const base = lookupMonthly(index, series, mat.pricedAsOf);
    const now = lookupMonthly(index, series, opts.asOf);
    if (base && now && base > 0) {
      factors[mat.key] = now / base;
    }
  }

  return factors;
}

type IndexTable = Record<string, Record<string, number>>;

function parseSeries(raw: unknown): IndexTable {
  const doc = raw as {
    Results?: {
      series?: Array<{
        seriesID?: string;
        data?: Array<{ year?: string; period?: string; value?: string }>;
      }>;
    };
  };

  const table: IndexTable = {};
  for (const s of doc.Results?.series ?? []) {
    const id = s.seriesID;
    if (!id) continue;
    table[id] ??= {};
    for (const d of s.data ?? []) {
      if (!d.year || !d.period?.startsWith("M") || d.period === "M13") continue;
      const month = d.period.slice(1).padStart(2, "0");
      const value = Number(d.value);
      if (Number.isFinite(value)) table[id][`${d.year}-${month}`] = value;
    }
  }
  return table;
}

function lookupMonthly(
  table: IndexTable,
  seriesId: string,
  isoDate: string,
): number | null {
  const series = table[seriesId];
  if (!series) return null;

  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;

  for (let back = 0; back < 12; back++) {
    const probe = new Date(d.getFullYear(), d.getMonth() - back, 1);
    const key = `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, "0")}`;
    if (series[key] !== undefined) return series[key];
  }
  return null;
}

export function escalationWarnings(
  factors: Record<string, number>,
  assumptions: AssumptionSet,
): string[] {
  const out: string[] = [];
  for (const [key, f] of Object.entries(factors)) {
    if (f > 1.15 || f < 0.9) {
      const mat = assumptions.material.find((m) => m.key === key);
      out.push(
        `"${mat?.label ?? key}" was priced on ${mat?.pricedAsOf} and has been ` +
          `escalated ${((f - 1) * 100).toFixed(1)}% via BLS PPI. ` +
          `Consider re-quoting with the supplier instead of relying on the index.`,
      );
    }
  }
  return out;
}
