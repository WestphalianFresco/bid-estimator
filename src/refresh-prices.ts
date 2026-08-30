import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STARTING_DEFAULTS } from "./assumptions";
import { toDollars } from "./money";
import { HD_SOURCING, fetchMaterialPrices } from "./data/home-depot";

/**
 * Refreshes material unit costs from Home Depot retail listings via SerpApi and
 * writes them to material-prices.local.json.
 *
 * This is a chore you run occasionally, not part of an estimate. Pricing has to
 * stay reproducible — the same input and the same assumptions must always give
 * the same figure — so prices are pulled here, written to a file, and folded
 * into the assumption set that gets captured in the estimate snapshot. Calling
 * a live pricing API from inside the pricing engine would break that.
 *
 * Each catalog key costs one SerpApi search, so a full refresh is roughly the
 * number of keys in HD_SOURCING.
 *
 *   $env:SERPAPI_API_KEY = "..."
 *   npm run refresh-prices              # defaults to ZIP 21201, Baltimore MD
 *   npm run refresh-prices -- 20850     # a different job-site ZIP
 *   npm run refresh-prices -- 20850 0.72   # ...with a 28% account discount
 */

const OUT = "material-prices.local.json";
const DEFAULT_ZIP = "21201"; // Baltimore, MD

/**
 * Keys live in .env.local, the same file the web app reads, so there is one
 * place to put them. This script runs from the repo root while the app runs
 * from bid-app/, so both are tried. An already-set environment variable wins.
 */
function loadEnvFiles() {
  for (const rel of [".env.local", join("bid-app", ".env.local")]) {
    try {
      process.loadEnvFile(join(process.cwd(), rel));
    } catch {
      // Missing or unreadable is the normal case for one of the two.
    }
  }
}

async function main() {
  loadEnvFiles();
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    console.error(
      "SERPAPI_API_KEY is not set.\n\n" +
        "  PowerShell:  $env:SERPAPI_API_KEY = \"your-key\"\n" +
        "  Get a key:   https://serpapi.com/manage-api-key",
    );
    process.exit(1);
  }

  const zip = process.argv[2] ?? DEFAULT_ZIP;
  const retailFactor = process.argv[3] ? Number.parseFloat(process.argv[3]) : 1.0;

  if (!/^\d{5}$/.test(zip)) {
    console.error(`"${zip}" is not a five-digit ZIP.`);
    process.exit(1);
  }
  if (!Number.isFinite(retailFactor) || retailFactor <= 0 || retailFactor > 2) {
    console.error(`Retail factor must be between 0 and 2; got "${process.argv[3]}".`);
    process.exit(1);
  }

  const keys = Object.keys(HD_SOURCING);
  console.log(
    `Pricing ${keys.length} catalog items against Home Depot for ZIP ${zip}` +
      (retailFactor === 1 ? " at shelf price." : ` at ${(retailFactor * 100).toFixed(0)}% of shelf price.`),
  );
  console.log(`That is ${keys.length} SerpApi searches. Working...\n`);

  const result = await fetchMaterialPrices({ apiKey, zip, retailFactor });

  const rows = Object.values(result.quotes);
  for (const q of rows) {
    const old = STARTING_DEFAULTS.material.find((m) => m.key === q.key);
    const delta =
      old && old.unitCost > 0
        ? ` (catalog default $${toDollars(old.unitCost).toFixed(2)}, ` +
          `${(((q.unitCost - old.unitCost) / old.unitCost) * 100).toFixed(0)}%)`
        : "";
    console.log(
      `  ${q.key.padEnd(30)} $${toDollars(q.unitCost).toFixed(2).padStart(9)} / ${q.unit.padEnd(3)}` +
        `  <- $${toDollars(q.packagePrice).toFixed(2)} per ${q.packageNote}${delta}`,
    );
  }

  if (result.unsourced.length > 0) {
    console.log(`\nNot sourced (${result.unsourced.length}):`);
    for (const u of result.unsourced) console.log(`  ${u.key.padEnd(30)} ${u.reason}`);
  }

  for (const w of result.warnings) console.log(`\n! ${w}`);

  writeFileSync(
    OUT,
    JSON.stringify(
      { zip, retailFactor, quotes: result.quotes, unsourced: result.unsourced },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\nWrote ${rows.length} quote(s) to ${OUT}. ` +
      `Restart the dev server to pick them up.`,
  );
}

main().catch((e) => {
  console.error("\nPrice refresh failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
