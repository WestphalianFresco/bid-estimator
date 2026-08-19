import { STARTING_DEFAULTS } from "./assumptions";
import { streamExplanation } from "./explain";
import { formatUSD } from "./money";
import { waterfallRows } from "./price";
import { runEstimate } from "./pipeline";

const SAMPLE_RFP = `
SOLICITATION NO. W912DQ-26-B-0043
DEPARTMENT OF THE ARMY — CORPS OF ENGINEERS

PROJECT: Renovation of Building 214, Vehicle Maintenance Facility
LOCATION: Los Angeles County, California
NAICS: 236220 — Commercial and Institutional Building Construction

SCOPE OF WORK:
The Contractor shall provide all labor, materials, and equipment to renovate
approximately 18,500 gross square feet of existing vehicle maintenance space.

1. Demolish and replace the existing concrete slab on grade throughout the
   maintenance bay area, approximately 12,000 square feet.
2. Furnish and install new CMU partition walls, approximately 3,200 square feet
   of wall area.
3. Replace the roofing membrane over the entire building footprint.
4. Replace all interior lighting and branch circuit wiring throughout the
   18,500 SF facility.
5. Replace the HVAC system serving the office area.
6. Install thirty-two (32) new hollow metal doors with hardware.
7. Repaint all interior wall surfaces, approximately 24,000 square feet.

PERIOD OF PERFORMANCE: 240 calendar days from Notice to Proceed.

WAGE DETERMINATION: This contract is subject to the Davis-Bacon Act.
Wage Determination CA20260012 applies.

BONDS: Performance and Payment Bonds are required in the amount of 100% of
the contract price.

LIQUIDATED DAMAGES: $1,850 per calendar day of delay.
`;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  console.log("Extracting scope and pricing...\n");

  const { snapshot, comparablesCaveat, pipelineWarnings } = await runEstimate({
    rfpText: SAMPLE_RFP,
    assumptions: STARTING_DEFAULTS,
    id: "demo-001",
    now: "2026-08-17T00:00:00Z",
    useFixtureWages: true,
  });

  const { scope, estimate } = snapshot;

  console.log("=".repeat(70));
  console.log(`Project:  ${scope.project_title}`);
  console.log(`Location: ${scope.county} County, ${scope.state}`);
  console.log(`Area:     ${scope.gross_square_feet?.toLocaleString() ?? "not provided"} SF`);
  console.log(`Davis-Bacon: ${scope.davis_bacon_applies ? "applies" : "does not apply"}`);
  console.log(`Bonding:  ${scope.bonding_required ? "required" : "not required"}`);
  console.log("=".repeat(70));

  console.log("\nLINE DETAIL");
  for (const line of estimate.lines) {
    const flag =
      line.basis === "unpriced" ? " [UNPRICED]" : line.basis === "system_default" ? " [default]" : "";
    console.log(
      `  Div ${line.item.csi_division}  ${line.item.description}\n` +
        `    ${line.item.quantity.toLocaleString()} ${line.item.unit}` +
        ` -> ${formatUSD(line.directCost)}${flag}`,
    );
  }

  console.log("\nMARKUP WATERFALL");
  for (const row of waterfallRows(estimate.totals, STARTING_DEFAULTS.markups)) {
    const prefix = row.isSubtotal ? "=" : "+";
    const rate = row.rate ? ` (${row.rate})`.padEnd(11) : "".padEnd(11);
    console.log(
      `  ${prefix} ${row.label.padEnd(48)}${rate}${formatUSD(row.amount).padStart(14)}`,
    );
  }

  const allWarnings = [...pipelineWarnings, ...estimate.warnings];
  if (allWarnings.length > 0) {
    console.log("\nWARNINGS");
    allWarnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  }

  if (scope.missing_information.length > 0) {
    console.log("\nMISSING FROM SOLICITATION");
    scope.missing_information.forEach((m) => console.log(`  - ${m}`));
  }

  if (scope.clarification_questions.length > 0) {
    console.log("\nSUGGESTED CLARIFICATION QUESTIONS");
    scope.clarification_questions.forEach((q) => console.log(`  - ${q}`));
  }

  console.log("\n" + "=".repeat(70));
  console.log("EXPLANATION\n");
  for await (const chunk of streamExplanation(
    scope,
    estimate,
    STARTING_DEFAULTS,
    comparablesCaveat,
  )) {
    process.stdout.write(chunk);
  }
  console.log("\n" + "=".repeat(70));
  console.log(`Engine ${snapshot.engineVersion} | Snapshot ${snapshot.id}`);
  console.log("Fixture wage rates in use. Not valid for bidding.");
}

main().catch((e) => {
  console.error("\nEstimate failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
