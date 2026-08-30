import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { priceBands } from "@/lib/bands";
import { fromDollars } from "@/lib/money";
import { ENGINE_VERSION, priceEstimate, type PriceInput } from "@/lib/price";
import { summarizeComposition } from "@/lib/rollups";
import type { EstimateSnapshot, ExtractedScope } from "@/lib/schema";
import { makeFixtureWageTable } from "@/lib/data/wage-determinations";
import { Report } from "../_components/Report";
import type { EstimatePayload } from "../_components/types";

/**
 * Offline preview — Layer 2 only.
 *
 * Renders the real report component against a hardcoded scope. No model call,
 * no network, no API key, so it costs nothing to open and it is the fastest way
 * to see a layout or a chart change. Everything on the page is still produced
 * by the pricing engine; only the *inputs* are fixtures.
 *
 * In the real flow, Layer 1 extracts this scope from the solicitation.
 */

const FIXTURE_SCOPE: ExtractedScope = {
  project_title: "Renovation of Building 214, Vehicle Maintenance Facility",
  naics_code: "236220",
  psc_code: "Z2AA",
  state: "CA",
  county: "Los Angeles",
  location_quote: "LOCATION: Los Angeles County, California",
  gross_square_feet: 18500,
  duration_months: 8,
  delivery_method: "design_bid_build",
  davis_bacon_applies: true,
  bonding_required: true,
  items: [
    { csi_division: "03", description: "Slab on grade replacement", quantity: 12000, unit: "SF", assumption_key: "03-slab-on-grade", work_type: "concrete_flatwork", match_confidence: "exact", confidence: "stated", source_quote: "approximately 12,000 square feet" },
    { csi_division: "04", description: "CMU partition walls", quantity: 3200, unit: "SF", assumption_key: "04-cmu-wall", work_type: "masonry_wall", match_confidence: "exact", confidence: "stated", source_quote: "approximately 3,200 square feet" },
    { csi_division: "07", description: "Roof tear-off and disposal", quantity: 18500, unit: "SF", assumption_key: "07-roof-tearoff", work_type: "roof_demolition", match_confidence: "exact", confidence: "inferred", source_quote: "entire building footprint" },
    { csi_division: "07", description: "Roof insulation board", quantity: 18500, unit: "SF", assumption_key: "07-roof-insulation", work_type: "roof_insulation", match_confidence: "exact", confidence: "inferred", source_quote: "entire building footprint" },
    { csi_division: "07", description: "60-mil TPO membrane", quantity: 18500, unit: "SF", assumption_key: "07-roof-membrane-tpo", work_type: "roof_membrane", match_confidence: "exact", confidence: "inferred", source_quote: "entire building footprint" },
    { csi_division: "07", description: "Perimeter edge metal", quantity: 560, unit: "LF", assumption_key: "07-roof-edge-metal", work_type: "roof_sheet_metal", match_confidence: "exact", confidence: "assumed", source_quote: "perimeter estimated from footprint" },
    { csi_division: "26", description: "Lighting and branch wiring", quantity: 18500, unit: "SF", assumption_key: "26-electrical", work_type: "electrical_distribution", match_confidence: "exact", confidence: "stated", source_quote: "throughout the 18,500 SF facility" },
    { csi_division: "23", description: "HVAC replacement, office area", quantity: 4000, unit: "SF", assumption_key: "23-hvac", work_type: "hvac_equipment", match_confidence: "exact", confidence: "assumed", source_quote: "HVAC system serving the office area" },
    { csi_division: "08", description: "Hollow metal doors", quantity: 32, unit: "EA", assumption_key: "08-door-hollow-metal", work_type: "door", match_confidence: "exact", confidence: "stated", source_quote: "thirty-two (32) new hollow metal doors" },
    { csi_division: "09", description: "Interior repaint", quantity: 24000, unit: "SF", assumption_key: "09-painting", work_type: "painting", match_confidence: "exact", confidence: "stated", source_quote: "approximately 24,000 square feet" },
  ],
  missing_information: [
    "Existing slab thickness and reinforcement are not stated, so the demolition and disposal allowance is an assumption.",
    "No hazardous materials survey is attached; the roof tear-off is priced as non-hazardous.",
  ],
  clarification_questions: [
    "Is asbestos abatement required in the roofing assembly, and if so is it in this contract or a separate one?",
    "Will the facility remain occupied during construction, and are there restricted working hours?",
  ],
};

/**
 * Stand-in comparable awards.
 *
 * Real runs pull these from USAspending. These are fixed figures chosen to
 * exercise the distribution charts, and are labelled as fixtures on the page so
 * nobody mistakes the market range for a real one.
 */
const FIXTURE_AWARDS = [
  1_180_000, 1_340_000, 1_495_000, 1_610_000, 1_705_000, 1_760_000, 1_845_000,
  1_910_000, 1_990_000, 2_070_000, 2_180_000, 2_260_000, 2_420_000, 2_640_000,
  2_890_000, 3_150_000,
].map(fromDollars);

/**
 * `?sections=4` renders only the first four sections.
 *
 * Exists so a short excerpt can be printed as a sample without maintaining a
 * second template: it is the same report, with the later sections hidden by
 * CSS, so an excerpt can never disagree with the full document.
 */
export default async function PreviewPage({ searchParams }: PageProps<"/preview">) {
  const params = await searchParams;
  const raw = Number(Array.isArray(params.sections) ? params.sections[0] : params.sections);
  const limit = Number.isInteger(raw) && raw > 0 && raw < 8 ? raw : 0;

  const wages = makeFixtureWageTable("CA", "Los Angeles");
  const input: PriceInput = {
    scope: FIXTURE_SCOPE,
    assumptions: STARTING_DEFAULTS,
    wages,
    comparables: FIXTURE_AWARDS,
  };

  // Layer 2 is a pure function — no await, no network, safe on the server.
  const estimate = priceEstimate(input);
  const bands = priceBands(input);
  const composition = summarizeComposition(estimate, FIXTURE_SCOPE);

  const snapshot: EstimateSnapshot = {
    id: "00000000-0000-4000-8000-preview00000",
    // A fixed timestamp keeps the preview byte-identical between renders.
    createdAt: "2026-01-15T15:00:00.000Z",
    engineVersion: ENGINE_VERSION,
    inputText: "fixture scope (offline preview)",
    scope: FIXTURE_SCOPE,
    assumptionsSnapshot: STARTING_DEFAULTS,
    wageDeterminationId: wages.determinationId,
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

  const payload: EstimatePayload = {
    snapshot,
    comparablesCaveat:
      "Fixture comparables. A real run queries USAspending for federal contract awards in the " +
      "same state and NAICS over the last three years.",
    pipelineWarnings: [
      "Using fixture wage rates, not a real Davis-Bacon determination. Not valid for bidding.",
    ],
    sourceLabel: "fixture scope (offline preview)",
    wages,
    comparables: FIXTURE_AWARDS,
    bands,
    composition,
  };

  return (
    <main className="shell">
      {limit > 0 && (
        <p className="excerpt-note no-print">
          Excerpt — sections 01–{String(limit).padStart(2, "0")} of {8}. Remove{" "}
          <code>?sections={limit}</code> from the URL for the full proposal.
        </p>
      )}

      <div className="notice notice-warn no-print" style={{ marginTop: 22 }}>
        <strong>Offline preview.</strong> Layer 2 only — the deterministic pricing engine. No model
        call, no network, no API key. The scope, the wage table and the comparable awards are all
        fixtures, so nothing on this page is valid for bidding; the point is to see the report and
        its charts render. For the real pipeline, use the{" "}
        <a href="/">estimator</a>.
      </div>

      <div className={limit > 0 ? `excerpt excerpt-${limit}` : undefined}>
        <Report
        payload={payload}
        estimate={estimate}
        bands={bands}
        composition={composition}
        explanation={
          "The roof scope drives this estimate: tear-off, insulation, membrane and edge metal " +
          "together account for the largest share of direct cost, and all four quantities were " +
          "inferred from the building footprint rather than stated in the solicitation. If the " +
          "actual roof area differs from the gross floor area, this figure moves with it.\n\n" +
          "Labor is priced against a fixture wage table, not a real determination, so the labor " +
          "half of every line is indicative only."
        }
        isAdjusted={false}
        overrides={{}}
        letterhead={{
          preparedFor: "U.S. Army Corps of Engineers, Los Angeles District",
          preparedBy: "WestphalianFresco Construction",
          contact: "1400 Harbor Blvd, Long Beach CA · (562) 555-0142 · CAGE 8X4T2",
        }}
        />
      </div>
    </main>
  );
}
