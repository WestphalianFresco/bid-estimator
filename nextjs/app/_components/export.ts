import type { AssumptionSet, MarkupSchedule } from "@/lib/assumptions";
import type { BidBandSet } from "@/lib/bands";
import type { CompositionSummary } from "@/lib/rollups";
import { waterfallRows } from "@/lib/price";
import type { Overrides } from "@/lib/reprice";
import type { PricedEstimate } from "@/lib/schema";
import type { EstimatePayload, Letterhead } from "./types";
import { money, pct, signedMoney, signedPct, titleCase } from "./ui";

/**
 * The report as Markdown.
 *
 * Same content, same numbers, same order as the on-screen document — this is a
 * second rendering of one report, not a summary of it. It exists because a
 * proposal often has to be pasted into an email or a proposal template, and a
 * PDF cannot be.
 *
 * Every amount here is formatted from a figure the engine produced. Nothing is
 * added up on the way out.
 */

const MARKUP_ORDER: Array<[keyof MarkupSchedule, string]> = [
  ["laborBurdenPct", "Labor burden"],
  ["fieldOverheadPct", "Field overhead"],
  ["homeOfficeOverheadPct", "Home office overhead"],
  ["generalAdminPct", "G&A"],
  ["feePct", "Fee"],
  ["insurancePct", "Insurance"],
  ["contingencyPct", "Contingency"],
  ["bondRatePct", "Bond rate"],
];

const dateLong = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

function validUntil(iso: string, days = 30): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return dateLong(d.toISOString());
}

export function buildMarkdown({
  payload,
  estimate,
  bands,
  composition,
  explanation,
  isAdjusted,
  overrides,
  letterhead,
}: {
  payload: EstimatePayload;
  estimate: PricedEstimate;
  bands: BidBandSet;
  composition: CompositionSummary;
  explanation: string;
  isAdjusted: boolean;
  overrides: Overrides;
  letterhead: Letterhead;
}): string {
  const { snapshot, wages } = payload;
  const scope = snapshot.scope;
  const assumptions = snapshot.assumptionsSnapshot as AssumptionSet;
  const markups: MarkupSchedule = { ...assumptions.markups, ...(overrides.markups ?? {}) };
  const recommended = bands.bands.find((b) => b.id === "recommended") ?? bands.bands[0];
  const quoteNo = `Q-${snapshot.id.slice(0, 8).toUpperCase()}`;
  const location = scope.state
    ? `${scope.county ? `${scope.county} County, ` : ""}${scope.state}`
    : "location not resolved";

  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, "");

  push(
    `# Preliminary Bid Proposal — ${scope.project_title}`,
    `**${quoteNo}** · issued ${dateLong(snapshot.createdAt)} · valid until ${validUntil(snapshot.createdAt)}`,
    `Conceptual estimate, AACE Class 4–5, expected accuracy ±20–30%${isAdjusted ? " · manually adjusted" : ""}.`,
  );

  push(
    "| | |",
    "|---|---|",
    `| Prepared for | ${letterhead.preparedFor || "—"} |`,
    `| Prepared by | ${letterhead.preparedBy || "—"}${letterhead.contact ? ` (${letterhead.contact})` : ""} |`,
    `| Place of performance | ${location} |`,
    `| NAICS / PSC | ${scope.naics_code}${scope.psc_code ? ` / ${scope.psc_code}` : ""} |`,
    `| Gross area | ${scope.gross_square_feet ? `${scope.gross_square_feet.toLocaleString()} SF` : "not stated"} |`,
    `| Duration | ${scope.duration_months ? `${scope.duration_months} months` : "not stated"} |`,
  );

  push("## 01 · Quoted price", `## ${money(recommended.bidPrice)}`);
  const unitLines = [
    composition.perSquareFoot !== null ? `${money(composition.perSquareFoot)} per gross SF` : null,
    composition.perMonth !== null ? `${money(composition.perMonth)} per month` : null,
  ].filter(Boolean);
  if (unitLines.length > 0) push(unitLines.join(" · "));

  push(
    "## 02 · Bid band",
    "One estimate at three commercial postures. The cost is identical in all three; only fee and contingency move.",
    "",
    "| Posture | Fee | Contingency | Bid price | vs recommended | vs local median |",
    "|---|---:|---:|---:|---:|---:|",
    ...bands.bands.map(
      (b) =>
        `| ${b.label} — ${b.headline} | ${pct(b.feePct, 2)} | ${pct(b.contingencyPct, 2)} | ${money(b.bidPrice)} | ${b.id === "recommended" ? "—" : signedMoney(b.deltaVsRecommended)} | ${b.ratioVsMarket === null ? "—" : signedPct(b.ratioVsMarket - 1)} |`,
    ),
  );

  for (const b of bands.bands) push(`**${b.label}.** ${b.rationale}`);

  push(
    "### Market position",
    bands.market.p50 !== null
      ? `${bands.market.count} comparable federal awards in ${location}: p25 ${money(bands.market.p25!)}, median ${money(bands.market.p50)}, p75 ${money(bands.market.p75!)}. Verdict: ${estimate.crossCheck.verdict.replace(/_/g, " ")}.`
      : `Too few comparable awards were retrieved (${bands.market.count}) to place this price against the local market.`,
  );
  if (payload.comparablesCaveat) push(`> ${payload.comparablesCaveat}`);

  push(
    "## 03 · How the price is built",
    "| Line | Rate | Amount |",
    "|---|---:|---:|",
    ...waterfallRows(estimate.totals, markups, scope.bonding_required).map(
      (r) => `| ${r.isSubtotal ? `**${r.label}**` : r.label} | ${r.rate ?? ""} | ${money(r.amount)} |`,
    ),
  );

  push(
    "### Composition of the quoted price",
    "| Component | Amount | Share |",
    "|---|---:|---:|",
    ...composition.buildUp.map((s) => `| ${s.label} | ${money(s.amount)} | ${pct(s.share)} |`),
    `| **Bid price** | **${money(composition.bidPrice)}** | 100.0% |`,
  );

  push(
    "## 04 · Schedule of work and direct cost",
    "| Div | Work item | Quantity | Crew hrs | Labor | Material | Direct cost |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...estimate.lines.map((l) => {
      const hours = l.labor.reduce((a, x) => a + x.hours, 0);
      const flags = [
        l.basis === "unpriced" ? "UNPRICED" : null,
        l.basis === "system_default" ? "default rate" : null,
        l.item.confidence !== "stated" ? `qty ${l.item.confidence}` : null,
        l.item.match_confidence === "close" ? "close match" : null,
      ].filter(Boolean);
      return `| ${l.item.csi_division} | ${l.item.description}${flags.length ? ` _(${flags.join(", ")})_` : ""} | ${l.item.quantity.toLocaleString()} ${l.item.unit} | ${hours ? hours.toFixed(0) : "—"} | ${money(l.laborCost)} | ${money(l.materialCost)} | ${money(l.directCost)} |`;
    }),
    `| | **Total direct cost** | | **${composition.laborHours.toFixed(0)}** | | | **${money(estimate.totals.directCost)}** |`,
  );

  push(
    "## 05 · Where the direct cost sits",
    "| CSI division | Direct cost | Share |",
    "|---|---:|---:|",
    ...composition.byDivision.map((s) => `| ${s.label} | ${money(s.amount)} | ${pct(s.share)} |`),
  );
  push(
    "| Cost type | Amount | Share |",
    "|---|---:|---:|",
    ...composition.byCostType.map((s) => `| ${s.label} | ${money(s.amount)} | ${pct(s.share)} |`),
  );

  push(
    "## 06 · Basis of estimate",
    "| | |",
    "|---|---|",
    `| Delivery method | ${titleCase(scope.delivery_method)} |`,
    `| Davis-Bacon | ${scope.davis_bacon_applies ? "applies" : "does not apply"} |`,
    `| Bonding | ${scope.bonding_required ? "required — premium included" : "not required"} |`,
    `| Wage determination | ${wages.determinationId || "not loaded"}${wages.effectiveDate ? ` (effective ${wages.effectiveDate})` : ""} |`,
    `| Material pricing | ${snapshot.materialPricing?.source === "home_depot_retail" ? `Home Depot retail, ZIP ${snapshot.materialPricing.zip}, ${(snapshot.materialPricing.fetchedAt ?? "").slice(0, 10)}` : "uncalibrated catalog defaults"} |`,
    `| Comparable awards | ${bands.market.count} retrieved |`,
    `| Total crew hours | ${composition.laborHours.toFixed(0)} |`,
    `| Assumption set | v${assumptions.version}, ${assumptions.calibratedKeys.length}/${assumptions.productivity.length} rates calibrated |`,
    `| Manual adjustments | ${describeOverrides(overrides)} |`,
    `| Source document | ${payload.sourceLabel} |`,
    `| Engine version | ${snapshot.engineVersion} |`,
    `| Report ID | ${snapshot.id} |`,
  );

  push(
    "### Markup schedule",
    "| Markup | Applied | Catalog default |",
    "|---|---:|---:|",
    ...MARKUP_ORDER.map(
      ([k, label]) =>
        `| ${label}${markups[k] !== assumptions.markups[k] ? " (overridden)" : ""} | ${pct(markups[k], 2)} | ${pct(assumptions.markups[k], 2)} |`,
    ),
  );

  const warnings = [...payload.pipelineWarnings, ...estimate.warnings];
  if (warnings.length > 0) {
    push(
      `## 07 · Qualifications and exclusions (${warnings.length})`,
      ...warnings.map((w, i) => `${i + 1}. ${w}`),
    );
  }

  if (scope.missing_information.length > 0) {
    push(
      "## 08 · Information missing from the solicitation",
      ...scope.missing_information.map((m, i) => `${i + 1}. ${m}`),
    );
  }

  if (scope.clarification_questions.length > 0) {
    push(
      "## 09 · Questions for the contracting officer",
      ...scope.clarification_questions.map((q, i) => `${i + 1}. ${q}`),
    );
  }

  if (explanation) {
    push("## 10 · Estimator's notes", explanation.trim());
  }

  push(
    "---",
    "**This is a conceptual estimate for budgeting and bid-strategy purposes, not a bid guarantee.** " +
      "Expected accuracy ±20–30% (AACE Class 4–5). Quantities, unit prices and assumptions must be " +
      "independently verified, and key items reviewed by a registered estimator, before this figure " +
      "is submitted. Every dollar amount above was produced by the deterministic pricing engine" +
      (isAdjusted ? ", including the manually adjusted figures" : "") +
      "; the narrative sections describe those numbers and do not alter them.",
  );

  return out.join("\n");
}

function describeOverrides(o: Overrides): string {
  const n = (r: Record<string, unknown> | undefined) => Object.keys(r ?? {}).length;
  const parts: string[] = [];
  if (n(o.quantities)) parts.push(`${n(o.quantities)} quantity`);
  if (n(o.materialUnitCosts)) parts.push(`${n(o.materialUnitCosts)} material rate`);
  if (n(o.wageRates)) parts.push(`${n(o.wageRates)} wage rate`);
  if (n(o.markups)) parts.push(`${n(o.markups)} markup`);
  return parts.length === 0 ? "none — engine values as generated" : `${parts.join(", ")} overridden`;
}
