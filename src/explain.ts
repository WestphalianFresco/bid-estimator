import Anthropic from "@anthropic-ai/sdk";
import type { AssumptionSet } from "./assumptions";
import { formatUSD } from "./money";
import { waterfallRows } from "./price";
import { EXPLANATION_SYSTEM } from "./prompts";
import type { ExtractedScope, PricedEstimate } from "./schema";

const client = new Anthropic();

export function renderEstimateForExplanation(
  scope: ExtractedScope,
  estimate: PricedEstimate,
  assumptions: AssumptionSet,
  comparablesCaveat: string | null,
): string {
  const t = estimate.totals;
  const parts: string[] = [];

  parts.push(`## Project
Title: ${scope.project_title}
Location: ${scope.county ? `${scope.county} County, ` : ""}${scope.state}
NAICS: ${scope.naics_code}${scope.psc_code ? `  PSC: ${scope.psc_code}` : ""}
Gross area: ${scope.gross_square_feet ? `${scope.gross_square_feet.toLocaleString()} SF` : "not provided"}
Duration: ${scope.duration_months ? `${scope.duration_months} months` : "not provided"}
Delivery method: ${scope.delivery_method}
Davis-Bacon applies: ${scope.davis_bacon_applies ? "yes" : "no"}
Bonding required: ${scope.bonding_required ? "yes (premium included)" : "no (premium not included)"}`);

  parts.push(`## Bid price
${formatUSD(t.bidPrice)}`);

  parts.push(`## Markup waterfall
${waterfallRows(t, assumptions.markups, scope.bonding_required)
  .map((r) => {
    const rate = r.rate ? ` (${r.rate})` : "";
    const mark = r.isSubtotal ? "= " : "+ ";
    return `${mark}${r.label}${rate}: ${formatUSD(r.amount)}`;
  })
  .join("\n")}`);

  parts.push(`## Line detail
${estimate.lines
  .map((l) => {
    const basisLabel =
      l.basis === "unpriced"
        ? "[UNPRICED]"
        : l.basis === "system_default"
          ? "[system default, uncalibrated]"
          : "[calibrated]";
    const conf =
      l.item.confidence === "assumed"
        ? "quantity assumed"
        : l.item.confidence === "inferred"
          ? "quantity inferred"
          : "quantity stated";
    const match =
      l.item.match_confidence === "loose"
        ? ", rate match LOOSE — no catalog rate describes this work"
        : l.item.match_confidence === "close"
          ? ", rate match close but inexact"
          : "";
    const hours = l.labor.reduce((a, x) => a + x.hours, 0);
    return (
      `- [Div ${l.item.csi_division}] ${l.item.description}\n` +
      `  ${l.item.quantity.toLocaleString()} ${l.item.unit} (${conf}) ${basisLabel}\n` +
      `  Labor ${formatUSD(l.laborCost)} (${hours.toFixed(0)} hrs) / ` +
      `Material ${formatUSD(l.materialCost)} / ` +
      `Equipment ${formatUSD(l.equipmentCost)} / ` +
      `Subs ${formatUSD(l.subcontractCost)} -> ${formatUSD(l.directCost)}`
    );
  })
  .join("\n")}`);

  const cc = estimate.crossCheck;
  parts.push(`## Cross-check (USAspending comparable awards)
${
  cc.verdict === "insufficient_data"
    ? `Only ${cc.comparableCount} comparable(s); not enough for a range verdict (need at least 5).`
    : `n=${cc.comparableCount}  p25 ${formatUSD(cc.p25!)}  p50 ${formatUSD(cc.p50!)}  p75 ${formatUSD(cc.p75!)}
This estimate at ${formatUSD(t.bidPrice)} falls ${
        cc.verdict === "within_range"
          ? "inside the p25-p75 range"
          : cc.verdict === "above_range"
            ? "above p75"
            : "below p25"
      }`
}
${comparablesCaveat ?? ""}`);

  parts.push(`## Engine warnings (cover all of these)
${
  estimate.warnings.length === 0
    ? "None. All assumptions calibrated, all lines priced."
    : estimate.warnings.map((w, i) => `${i + 1}. ${w}`).join("\n")
}`);

  if (scope.missing_information.length > 0) {
    parts.push(`## Information missing from the solicitation
${scope.missing_information.map((m) => `- ${m}`).join("\n")}`);
  }

  if (scope.clarification_questions.length > 0) {
    parts.push(`## Suggested clarification questions
${scope.clarification_questions.map((q) => `- ${q}`).join("\n")}`);
  }

  parts.push(`## Assumption set status
Version ${assumptions.version} (updated ${assumptions.updatedAt})
Calibrated: ${assumptions.calibratedKeys.length} / ${assumptions.productivity.length}`);

  return parts.join("\n\n");
}

export async function* streamExplanation(
  scope: ExtractedScope,
  estimate: PricedEstimate,
  assumptions: AssumptionSet,
  comparablesCaveat: string | null,
): AsyncGenerator<string, void, unknown> {
  const rendered = renderEstimateForExplanation(
    scope,
    estimate,
    assumptions,
    comparablesCaveat,
  );

  const stream = client.messages.stream({
    model: "claude-opus-5",
    max_tokens: 8000,
    system: [
      { type: "text", text: EXPLANATION_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: { effort: "medium" },
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: rendered }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

export async function explainEstimate(
  scope: ExtractedScope,
  estimate: PricedEstimate,
  assumptions: AssumptionSet,
  comparablesCaveat: string | null,
): Promise<string> {
  let out = "";
  for await (const chunk of streamExplanation(
    scope,
    estimate,
    assumptions,
    comparablesCaveat,
  )) {
    out += chunk;
  }
  return out;
}
