import type { Cents } from "./money";
import { fromDollars } from "./money";
import type { CsiDivision, Trade, Unit, WorkType } from "./schema";

export interface CrewMix {
  trade: Trade;
  share: number;
}

export interface ProductivityRate {
  key: string;
  csiDivision: CsiDivision;
  /**
   * What this rate prices. The engine refuses a scope line whose declared
   * work_type differs, which is what stops a baseboard run being costed off the
   * casework rate. See WORK_TYPES in schema.ts.
   */
  workType: WorkType;
  label: string;
  unit: Unit;
  hoursPerUnit: number;
  crew: CrewMix[];
}

export interface MaterialRate {
  key: string;
  label: string;
  unit: Unit;
  unitCost: Cents;
  pricedAsOf: string;
}

export interface MarkupSchedule {
  fieldOverheadPct: number;
  homeOfficeOverheadPct: number;
  generalAdminPct: number;
  feePct: number;
  insurancePct: number;
  contingencyPct: number;
  bondRatePct: number;
  laborBurdenPct: number;
}

export interface AssumptionSet {
  owner: string;
  version: number;
  updatedAt: string;
  productivity: ProductivityRate[];
  material: MaterialRate[];
  markups: MarkupSchedule;
  calibratedKeys: string[];
}

/**
 * Starting defaults.
 *
 * ## These numbers are placeholders
 *
 * Every rate below is a plausible industry figure, not a sourced one. They exist
 * so the engine produces something to react to on day one; they are not a price
 * book. Any key not listed in `calibratedKeys` is tagged `[system default]` in
 * the output and raises a warning, and `calibratedKeys` starts empty on purpose.
 *
 * ## Why the catalog is granular
 *
 * The extractor can only choose from these keys. When the catalog held a single
 * roofing entry, a re-roof came back as four identical lines — tear-off, new
 * insulation, new membrane and curb flashing all mapped to `07-roof-membrane`
 * and all carried the same square footage, so all four priced to the same
 * dollar. Nothing was wrong with the arithmetic; there was one bucket for four
 * different operations.
 *
 * Two rules follow from that, and both matter more than the accuracy of any
 * individual rate:
 *
 * 1. **One key per operation that is bought separately.** If a subcontractor
 *    would quote it on its own line, it needs its own key.
 * 2. **The unit must match how the work is actually measured.** Edge metal is
 *    bought by the linear foot, drains by the each, deck repair by the lump sum.
 *    The engine does not convert units — a scope line in LF against an SF
 *    assumption prices to zero — so a catalog that is all SF silently drops
 *    real money out of the estimate.
 *
 * Lump-sum entries carry hours per lump sum; the arithmetic is the same.
 */
export const STARTING_DEFAULTS: AssumptionSet = {
  owner: "system",
  version: 0,
  updatedAt: "1970-01-01",
  calibratedKeys: [],

  productivity: [
    // ── Div 01 — General requirements ───────────────────────────────
    {
      key: "01-general-allowance",
      csiDivision: "01",
      workType: "general_allowance",
      label: "General conditions allowance (use only when nothing else fits)",
      unit: "LS",
      hoursPerUnit: 40,
      crew: [{ trade: "laborer", share: 1.0 }],
    },

    // ── Div 02 — Existing conditions / demolition ───────────────────
    {
      key: "02-demo-interior",
      csiDivision: "02",
      workType: "demolition",
      label: "Interior non-structural demolition",
      unit: "SF",
      hoursPerUnit: 0.02,
      crew: [{ trade: "laborer", share: 1.0 }],
    },
    {
      key: "02-demo-slab",
      csiDivision: "02",
      workType: "demolition",
      label: "Slab demolition and removal",
      unit: "SF",
      hoursPerUnit: 0.03,
      crew: [
        { trade: "laborer", share: 0.6 },
        { trade: "operating_engineer", share: 0.4 },
      ],
    },
    {
      key: "02-demo-masonry-wall",
      csiDivision: "02",
      workType: "demolition",
      label: "Masonry wall demolition",
      unit: "SF",
      hoursPerUnit: 0.05,
      crew: [
        { trade: "laborer", share: 0.7 },
        { trade: "operating_engineer", share: 0.3 },
      ],
    },
    {
      key: "02-hazmat-abatement-allowance",
      csiDivision: "02",
      workType: "hazmat_abatement",
      label: "Hazardous material abatement allowance",
      unit: "LS",
      hoursPerUnit: 80,
      crew: [{ trade: "laborer", share: 1.0 }],
    },

    // ── Div 03 — Concrete ───────────────────────────────────────────
    {
      key: "03-slab-on-grade",
      csiDivision: "03",
      workType: "concrete_flatwork",
      label: "Slab on grade (place + finish)",
      unit: "SF",
      hoursPerUnit: 0.035,
      crew: [
        { trade: "cement_mason", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },
    {
      key: "03-cip-walls",
      csiDivision: "03",
      workType: "concrete_structural",
      label: "Cast-in-place walls (incl. formwork)",
      unit: "SF",
      hoursPerUnit: 0.35,
      crew: [
        { trade: "carpenter", share: 0.5 },
        { trade: "cement_mason", share: 0.2 },
        { trade: "laborer", share: 0.3 },
      ],
    },
    {
      key: "03-footings",
      csiDivision: "03",
      workType: "concrete_structural",
      label: "Spread and strip footings",
      unit: "CY",
      hoursPerUnit: 4.0,
      crew: [
        { trade: "carpenter", share: 0.4 },
        { trade: "cement_mason", share: 0.3 },
        { trade: "laborer", share: 0.3 },
      ],
    },
    {
      key: "03-sidewalk",
      csiDivision: "03",
      workType: "concrete_flatwork",
      label: "Concrete sidewalk / exterior flatwork",
      unit: "SF",
      hoursPerUnit: 0.04,
      crew: [
        { trade: "cement_mason", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },
    {
      key: "03-equipment-pad",
      csiDivision: "03",
      workType: "concrete_flatwork",
      label: "Concrete equipment pad",
      unit: "EA",
      hoursPerUnit: 8,
      crew: [
        { trade: "cement_mason", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },

    // ── Div 04 — Masonry ────────────────────────────────────────────
    {
      key: "04-cmu-wall",
      csiDivision: "04",
      workType: "masonry_wall",
      label: "CMU wall",
      unit: "SF",
      hoursPerUnit: 0.12,
      crew: [
        { trade: "bricklayer", share: 0.6 },
        { trade: "laborer", share: 0.4 },
      ],
    },
    {
      key: "04-brick-veneer",
      csiDivision: "04",
      workType: "masonry_veneer",
      label: "Brick veneer",
      unit: "SF",
      hoursPerUnit: 0.18,
      crew: [
        { trade: "bricklayer", share: 0.6 },
        { trade: "laborer", share: 0.4 },
      ],
    },
    {
      key: "04-masonry-repointing",
      csiDivision: "04",
      workType: "masonry_restoration",
      label: "Masonry repointing / restoration",
      unit: "SF",
      hoursPerUnit: 0.15,
      crew: [
        { trade: "bricklayer", share: 0.7 },
        { trade: "laborer", share: 0.3 },
      ],
    },

    // ── Div 05 — Metals ─────────────────────────────────────────────
    {
      key: "05-structural-steel",
      csiDivision: "05",
      workType: "structural_steel",
      label: "Structural steel erection",
      unit: "TON",
      hoursPerUnit: 7.0,
      crew: [
        { trade: "ironworker", share: 0.75 },
        { trade: "operating_engineer", share: 0.25 },
      ],
    },
    {
      key: "05-steel-stair",
      csiDivision: "05",
      workType: "metal_fabrication",
      label: "Steel stair, per flight",
      unit: "EA",
      hoursPerUnit: 24,
      crew: [
        { trade: "ironworker", share: 0.75 },
        { trade: "operating_engineer", share: 0.25 },
      ],
    },
    {
      key: "05-metal-railing",
      csiDivision: "05",
      workType: "metal_railing",
      label: "Metal railing / guardrail",
      unit: "LF",
      hoursPerUnit: 0.5,
      crew: [{ trade: "ironworker", share: 1.0 }],
    },
    {
      key: "05-misc-metal-allowance",
      csiDivision: "05",
      workType: "metal_fabrication",
      label: "Miscellaneous metal fabrication allowance",
      unit: "LS",
      hoursPerUnit: 40,
      crew: [{ trade: "ironworker", share: 1.0 }],
    },

    // ── Div 06 — Wood and plastics ──────────────────────────────────
    {
      key: "06-rough-framing",
      csiDivision: "06",
      workType: "rough_carpentry",
      label: "Rough carpentry framing",
      unit: "SF",
      hoursPerUnit: 0.05,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "06-blocking-nailer",
      csiDivision: "06",
      workType: "rough_carpentry",
      label: "Wood blocking and nailers",
      unit: "LF",
      hoursPerUnit: 0.06,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "06-roof-deck-repair",
      csiDivision: "06",
      workType: "rough_carpentry",
      label: "Roof deck repair (sheathing replacement)",
      unit: "SF",
      hoursPerUnit: 0.09,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "06-deck-repair-allowance",
      csiDivision: "06",
      workType: "rough_carpentry",
      label: "Roof deck repair allowance (extent unknown until tear-off)",
      unit: "LS",
      hoursPerUnit: 32,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      // Added after a 120 LF baseboard run was costed off the casework rate at
      // $422/LF. Trim and cabinets are both Div 06 and both measured in LF;
      // only the work type separates them.
      key: "06-finish-trim",
      csiDivision: "06",
      workType: "finish_carpentry_trim",
      label: "Interior trim, baseboard, casing and crown",
      unit: "LF",
      hoursPerUnit: 0.045,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "06-casework",
      csiDivision: "06",
      workType: "casework",
      label: "Casework and millwork",
      unit: "LF",
      hoursPerUnit: 1.2,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },

    // ── Div 07 — Thermal and moisture protection ────────────────────
    // Roofing is broken out by operation because a re-roof buys each of these
    // separately and they do not cost the same per square foot.
    {
      key: "07-roof-tearoff",
      csiDivision: "07",
      workType: "roof_demolition",
      label: "Roof tear-off, haul and disposal",
      unit: "SF",
      hoursPerUnit: 0.018,
      crew: [
        { trade: "roofer", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },
    {
      key: "07-roof-insulation",
      csiDivision: "07",
      workType: "roof_insulation",
      label: "Roof insulation board (polyiso) over deck",
      unit: "SF",
      hoursPerUnit: 0.012,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-cover-board",
      csiDivision: "07",
      workType: "roof_insulation",
      label: "Roof cover board",
      unit: "SF",
      hoursPerUnit: 0.009,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-membrane-tpo",
      csiDivision: "07",
      workType: "roof_membrane",
      label: "TPO single-ply membrane, installed",
      unit: "SF",
      hoursPerUnit: 0.022,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-membrane-epdm",
      csiDivision: "07",
      workType: "roof_membrane",
      label: "EPDM single-ply membrane, installed",
      unit: "SF",
      hoursPerUnit: 0.020,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-modified-bitumen",
      csiDivision: "07",
      workType: "roof_membrane",
      label: "Modified bitumen roofing, installed",
      unit: "SF",
      hoursPerUnit: 0.030,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-shingles",
      csiDivision: "07",
      workType: "roof_membrane",
      label: "Asphalt shingle roofing (per 100 SF square)",
      unit: "SQ",
      hoursPerUnit: 1.6,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-edge-metal",
      csiDivision: "07",
      workType: "roof_sheet_metal",
      label: "Perimeter edge metal / fascia (ES-1)",
      unit: "LF",
      hoursPerUnit: 0.10,
      crew: [
        { trade: "sheet_metal_worker", share: 0.5 },
        { trade: "roofer", share: 0.5 },
      ],
    },
    {
      key: "07-roof-coping",
      csiDivision: "07",
      workType: "roof_sheet_metal",
      label: "Parapet coping cap",
      unit: "LF",
      hoursPerUnit: 0.12,
      crew: [{ trade: "sheet_metal_worker", share: 1.0 }],
    },
    {
      key: "07-roof-drain",
      csiDivision: "07",
      workType: "roof_accessory",
      label: "Roof drain replacement, tie to existing leader",
      unit: "EA",
      hoursPerUnit: 6.0,
      crew: [
        { trade: "plumber", share: 0.6 },
        { trade: "roofer", share: 0.4 },
      ],
    },
    {
      key: "07-roof-curb-flashing",
      csiDivision: "07",
      workType: "roof_accessory",
      label: "Curb flashing at HVAC unit or skylight",
      unit: "EA",
      hoursPerUnit: 3.0,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-penetration-flashing",
      csiDivision: "07",
      workType: "roof_accessory",
      label: "Pipe / vent penetration flashing",
      unit: "EA",
      hoursPerUnit: 1.2,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-roof-walkway-pad",
      csiDivision: "07",
      workType: "roof_accessory",
      label: "Roof walkway pad",
      unit: "LF",
      hoursPerUnit: 0.05,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "07-wall-insulation",
      csiDivision: "07",
      workType: "building_insulation",
      label: "Wall insulation",
      unit: "SF",
      hoursPerUnit: 0.015,
      crew: [{ trade: "insulation_worker", share: 1.0 }],
    },
    {
      key: "07-fireproofing",
      csiDivision: "07",
      workType: "fireproofing",
      label: "Spray-applied fireproofing",
      unit: "SF",
      hoursPerUnit: 0.025,
      crew: [{ trade: "insulation_worker", share: 1.0 }],
    },
    {
      key: "07-caulking-sealant",
      csiDivision: "07",
      workType: "sealant",
      label: "Joint sealant and caulking",
      unit: "LF",
      hoursPerUnit: 0.04,
      crew: [{ trade: "laborer", share: 1.0 }],
    },

    // ── Div 08 — Openings ───────────────────────────────────────────
    {
      key: "08-door-hollow-metal",
      csiDivision: "08",
      workType: "door",
      label: "Hollow metal door, frame and hardware",
      unit: "EA",
      hoursPerUnit: 1.5,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "08-door-wood",
      csiDivision: "08",
      workType: "door",
      label: "Wood door, frame and hardware",
      unit: "EA",
      hoursPerUnit: 1.3,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "08-overhead-door",
      csiDivision: "08",
      workType: "overhead_door",
      label: "Overhead coiling / sectional door",
      unit: "EA",
      hoursPerUnit: 12,
      crew: [
        { trade: "ironworker", share: 0.5 },
        { trade: "carpenter", share: 0.5 },
      ],
    },
    {
      key: "08-storefront-glazing",
      csiDivision: "08",
      workType: "glazing",
      label: "Aluminum storefront and glazing",
      unit: "SF",
      hoursPerUnit: 0.22,
      crew: [{ trade: "glazier", share: 1.0 }],
    },
    {
      key: "08-window-replace",
      csiDivision: "08",
      workType: "glazing",
      label: "Window replacement",
      unit: "EA",
      hoursPerUnit: 3.5,
      crew: [{ trade: "glazier", share: 1.0 }],
    },

    // ── Div 09 — Finishes ───────────────────────────────────────────
    {
      key: "09-gypsum-board",
      csiDivision: "09",
      workType: "gypsum_board",
      label: "Gypsum board (hang + finish)",
      unit: "SF",
      hoursPerUnit: 0.02,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "09-acoustic-ceiling",
      csiDivision: "09",
      workType: "ceiling",
      label: "Suspended acoustic ceiling",
      unit: "SF",
      hoursPerUnit: 0.025,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "09-painting",
      csiDivision: "09",
      workType: "painting",
      label: "Painting (two coats)",
      unit: "SF",
      hoursPerUnit: 0.008,
      crew: [{ trade: "painter", share: 1.0 }],
    },
    {
      key: "09-flooring-vct",
      csiDivision: "09",
      workType: "flooring_resilient",
      label: "Resilient tile flooring (VCT / LVT)",
      unit: "SF",
      hoursPerUnit: 0.022,
      crew: [{ trade: "laborer", share: 1.0 }],
    },
    {
      key: "09-flooring-carpet",
      csiDivision: "09",
      workType: "flooring_carpet",
      label: "Carpet tile",
      unit: "SY",
      hoursPerUnit: 0.14,
      crew: [{ trade: "laborer", share: 1.0 }],
    },
    {
      key: "09-flooring-epoxy",
      csiDivision: "09",
      workType: "flooring_coating",
      label: "Epoxy / resinous floor coating",
      unit: "SF",
      hoursPerUnit: 0.03,
      crew: [{ trade: "painter", share: 1.0 }],
    },
    {
      key: "09-ceramic-tile",
      csiDivision: "09",
      workType: "tile",
      label: "Ceramic / porcelain tile",
      unit: "SF",
      hoursPerUnit: 0.09,
      crew: [
        { trade: "bricklayer", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },

    // ── Div 10 — Specialties ────────────────────────────────────────
    {
      key: "10-toilet-partition",
      csiDivision: "10",
      workType: "specialty_item",
      label: "Toilet partition / compartment",
      unit: "EA",
      hoursPerUnit: 2.5,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "10-signage",
      csiDivision: "10",
      workType: "specialty_item",
      label: "Interior signage",
      unit: "EA",
      hoursPerUnit: 0.8,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "10-lockers",
      csiDivision: "10",
      workType: "specialty_item",
      label: "Lockers",
      unit: "EA",
      hoursPerUnit: 0.6,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "10-fire-extinguisher-cabinet",
      csiDivision: "10",
      workType: "specialty_item",
      label: "Fire extinguisher cabinet",
      unit: "EA",
      hoursPerUnit: 1.0,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },

    // ── Div 12 — Furnishings ────────────────────────────────────────
    {
      key: "12-countertop-quartz",
      csiDivision: "12",
      workType: "countertop",
      label: "Quartz / engineered stone countertop, fabricated and set",
      unit: "SF",
      hoursPerUnit: 0.35,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "12-countertop-laminate",
      csiDivision: "12",
      workType: "countertop",
      label: "Laminate countertop",
      unit: "LF",
      hoursPerUnit: 0.4,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },

    // ── Div 14 — Conveying ──────────────────────────────────────────
    {
      key: "14-elevator-modernization",
      csiDivision: "14",
      workType: "conveying",
      label: "Elevator modernization",
      unit: "EA",
      hoursPerUnit: 240,
      crew: [
        { trade: "ironworker", share: 0.5 },
        { trade: "electrician", share: 0.5 },
      ],
    },
    {
      key: "14-wheelchair-lift",
      csiDivision: "14",
      workType: "conveying",
      label: "Wheelchair lift",
      unit: "EA",
      hoursPerUnit: 60,
      crew: [
        { trade: "ironworker", share: 0.5 },
        { trade: "electrician", share: 0.5 },
      ],
    },

    // ── Div 21 — Fire suppression ───────────────────────────────────
    {
      key: "21-fire-sprinkler",
      csiDivision: "21",
      workType: "fire_suppression",
      label: "Fire sprinkler system (per covered SF)",
      unit: "SF",
      hoursPerUnit: 0.045,
      crew: [{ trade: "pipefitter", share: 1.0 }],
    },
    {
      key: "21-fire-standpipe",
      csiDivision: "21",
      workType: "fire_suppression",
      label: "Fire standpipe",
      unit: "LF",
      hoursPerUnit: 0.35,
      crew: [{ trade: "pipefitter", share: 1.0 }],
    },

    // ── Div 22 — Plumbing ───────────────────────────────────────────
    {
      key: "22-plumbing-roughin",
      csiDivision: "22",
      workType: "plumbing_piping",
      label: "Plumbing rough-in (per GSF)",
      unit: "SF",
      hoursPerUnit: 0.05,
      crew: [
        { trade: "plumber", share: 0.7 },
        { trade: "pipefitter", share: 0.3 },
      ],
    },
    {
      key: "22-plumbing-fixture",
      csiDivision: "22",
      workType: "plumbing_fixture",
      label: "Plumbing fixture, set and connect",
      unit: "EA",
      hoursPerUnit: 4.0,
      crew: [{ trade: "plumber", share: 1.0 }],
    },
    {
      key: "22-water-heater",
      csiDivision: "22",
      workType: "plumbing_equipment",
      label: "Water heater",
      unit: "EA",
      hoursPerUnit: 10,
      crew: [{ trade: "plumber", share: 1.0 }],
    },
    {
      key: "22-domestic-water-pipe",
      csiDivision: "22",
      workType: "plumbing_piping",
      label: "Domestic water piping",
      unit: "LF",
      hoursPerUnit: 0.14,
      crew: [{ trade: "plumber", share: 1.0 }],
    },

    // ── Div 23 — HVAC ───────────────────────────────────────────────
    {
      key: "23-hvac",
      csiDivision: "23",
      workType: "hvac_equipment",
      label: "HVAC, whole-system allowance (per GSF)",
      unit: "SF",
      hoursPerUnit: 0.08,
      crew: [
        { trade: "sheet_metal_worker", share: 0.5 },
        { trade: "pipefitter", share: 0.5 },
      ],
    },
    {
      key: "23-rtu-replacement",
      csiDivision: "23",
      workType: "hvac_equipment",
      label: "Rooftop unit replacement",
      unit: "EA",
      hoursPerUnit: 36,
      crew: [
        { trade: "sheet_metal_worker", share: 0.5 },
        { trade: "pipefitter", share: 0.3 },
        { trade: "electrician", share: 0.2 },
      ],
    },
    {
      key: "23-ductwork",
      csiDivision: "23",
      workType: "hvac_ductwork",
      label: "Sheet metal ductwork",
      unit: "LF",
      hoursPerUnit: 0.22,
      crew: [{ trade: "sheet_metal_worker", share: 1.0 }],
    },
    {
      key: "23-exhaust-fan",
      csiDivision: "23",
      workType: "hvac_equipment",
      label: "Exhaust fan",
      unit: "EA",
      hoursPerUnit: 6,
      crew: [
        { trade: "sheet_metal_worker", share: 0.6 },
        { trade: "electrician", share: 0.4 },
      ],
    },
    {
      key: "23-controls-allowance",
      csiDivision: "23",
      workType: "hvac_controls",
      label: "HVAC controls / BAS allowance",
      unit: "LS",
      hoursPerUnit: 60,
      crew: [{ trade: "electrician", share: 1.0 }],
    },

    // ── Div 26 — Electrical ─────────────────────────────────────────
    {
      key: "26-electrical",
      csiDivision: "26",
      workType: "electrical_distribution",
      label: "Electrical, whole-system allowance (per GSF)",
      unit: "SF",
      hoursPerUnit: 0.09,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-lighting-fixture",
      csiDivision: "26",
      workType: "electrical_fixture",
      label: "Lighting fixture, furnish and install",
      unit: "EA",
      hoursPerUnit: 1.1,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-branch-circuit",
      csiDivision: "26",
      workType: "electrical_branch_wiring",
      label: "Branch circuit wiring",
      unit: "LF",
      hoursPerUnit: 0.05,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      // Device work is counted, not measured in feet. Without these three the
      // extractor had to express "replace 12 receptacles" as linear feet of
      // branch wiring, which is a different scope at a different rate.
      key: "26-device-replace",
      csiDivision: "26",
      workType: "electrical_device",
      label: "Receptacle or switch, replace in existing box",
      unit: "EA",
      hoursPerUnit: 0.35,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-gfci-receptacle",
      csiDivision: "26",
      workType: "electrical_device",
      label: "GFCI receptacle",
      unit: "EA",
      hoursPerUnit: 0.5,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-dedicated-circuit",
      csiDivision: "26",
      workType: "electrical_branch_wiring",
      label: "New dedicated circuit, panel to device",
      unit: "EA",
      hoursPerUnit: 3.5,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-panel-modification",
      csiDivision: "26",
      workType: "electrical_distribution",
      label: "Panel modification / breaker additions allowance",
      unit: "LS",
      hoursPerUnit: 8,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-panelboard",
      csiDivision: "26",
      workType: "electrical_distribution",
      label: "Panelboard",
      unit: "EA",
      hoursPerUnit: 14,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-service-upgrade",
      csiDivision: "26",
      workType: "electrical_distribution",
      label: "Electrical service upgrade",
      unit: "LS",
      hoursPerUnit: 120,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "26-generator",
      csiDivision: "26",
      workType: "electrical_equipment",
      label: "Standby generator, set and connect",
      unit: "EA",
      hoursPerUnit: 90,
      crew: [
        { trade: "electrician", share: 0.7 },
        { trade: "operating_engineer", share: 0.3 },
      ],
    },

    // ── Div 27 / 28 — Communications, safety and security ───────────
    {
      key: "27-data-drop",
      csiDivision: "27",
      workType: "communications",
      label: "Data cabling drop",
      unit: "EA",
      hoursPerUnit: 1.8,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "28-fire-alarm",
      csiDivision: "28",
      workType: "fire_alarm",
      label: "Fire alarm system (per covered SF)",
      unit: "SF",
      hoursPerUnit: 0.012,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "28-security-camera",
      csiDivision: "28",
      workType: "security",
      label: "Security camera, install and terminate",
      unit: "EA",
      hoursPerUnit: 3.0,
      crew: [{ trade: "electrician", share: 1.0 }],
    },

    // ── Div 31 — Earthwork ──────────────────────────────────────────
    {
      key: "31-excavation",
      csiDivision: "31",
      workType: "earthwork",
      label: "Machine excavation",
      unit: "CY",
      hoursPerUnit: 0.02,
      crew: [
        { trade: "operating_engineer", share: 0.5 },
        { trade: "truck_driver", share: 0.3 },
        { trade: "laborer", share: 0.2 },
      ],
    },
    {
      key: "31-backfill-compact",
      csiDivision: "31",
      workType: "earthwork",
      label: "Backfill and compaction",
      unit: "CY",
      hoursPerUnit: 0.03,
      crew: [
        { trade: "operating_engineer", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },
    {
      key: "31-erosion-control",
      csiDivision: "31",
      workType: "site_improvement",
      label: "Erosion and sediment control",
      unit: "LF",
      hoursPerUnit: 0.04,
      crew: [{ trade: "laborer", share: 1.0 }],
    },

    // ── Div 32 — Exterior improvements ──────────────────────────────
    {
      key: "32-asphalt-paving",
      csiDivision: "32",
      workType: "site_paving",
      label: "Asphalt paving",
      unit: "SY",
      hoursPerUnit: 0.01,
      crew: [
        { trade: "operating_engineer", share: 0.4 },
        { trade: "laborer", share: 0.6 },
      ],
    },
    {
      key: "32-concrete-paving",
      csiDivision: "32",
      workType: "site_paving",
      label: "Concrete paving",
      unit: "SF",
      hoursPerUnit: 0.045,
      crew: [
        { trade: "cement_mason", share: 0.5 },
        { trade: "laborer", share: 0.5 },
      ],
    },
    {
      key: "32-pavement-striping",
      csiDivision: "32",
      workType: "site_improvement",
      label: "Pavement striping and markings",
      unit: "LS",
      hoursPerUnit: 16,
      crew: [{ trade: "laborer", share: 1.0 }],
    },
    {
      key: "32-chain-link-fence",
      csiDivision: "32",
      workType: "site_improvement",
      label: "Chain link fence",
      unit: "LF",
      hoursPerUnit: 0.09,
      crew: [{ trade: "laborer", share: 1.0 }],
    },
    {
      key: "32-landscaping",
      csiDivision: "32",
      workType: "site_improvement",
      label: "Landscaping and seeding",
      unit: "SF",
      hoursPerUnit: 0.008,
      crew: [{ trade: "laborer", share: 1.0 }],
    },

    // ── Div 33 — Utilities ──────────────────────────────────────────
    {
      key: "33-site-water-line",
      csiDivision: "33",
      workType: "site_utilities",
      label: "Site water line",
      unit: "LF",
      hoursPerUnit: 0.16,
      crew: [
        { trade: "plumber", share: 0.4 },
        { trade: "operating_engineer", share: 0.3 },
        { trade: "laborer", share: 0.3 },
      ],
    },
    {
      key: "33-site-sewer-line",
      csiDivision: "33",
      workType: "site_utilities",
      label: "Site sanitary sewer line",
      unit: "LF",
      hoursPerUnit: 0.18,
      crew: [
        { trade: "plumber", share: 0.4 },
        { trade: "operating_engineer", share: 0.3 },
        { trade: "laborer", share: 0.3 },
      ],
    },
    {
      key: "33-storm-drain",
      csiDivision: "33",
      workType: "site_utilities",
      label: "Storm drain line and structures",
      unit: "LF",
      hoursPerUnit: 0.15,
      crew: [
        { trade: "operating_engineer", share: 0.4 },
        { trade: "laborer", share: 0.6 },
      ],
    },
  ],

  material: [
    // Div 01 / 02
    { key: "01-general-allowance", label: "General conditions materials", unit: "LS", unitCost: fromDollars(5000), pricedAsOf: "2026-01-01" },
    { key: "02-demo-interior", label: "Disposal and dumpster", unit: "SF", unitCost: fromDollars(0.45), pricedAsOf: "2026-01-01" },
    { key: "02-demo-slab", label: "Haul and tipping fees", unit: "SF", unitCost: fromDollars(1.2), pricedAsOf: "2026-01-01" },
    { key: "02-demo-masonry-wall", label: "Haul and tipping fees", unit: "SF", unitCost: fromDollars(0.9), pricedAsOf: "2026-01-01" },
    { key: "02-hazmat-abatement-allowance", label: "Abatement materials and disposal", unit: "LS", unitCost: fromDollars(15000), pricedAsOf: "2026-01-01" },

    // Div 03
    { key: "03-slab-on-grade", label: "Concrete + rebar + base", unit: "SF", unitCost: fromDollars(4.5), pricedAsOf: "2026-01-01" },
    { key: "03-cip-walls", label: "Concrete + form materials", unit: "SF", unitCost: fromDollars(9.0), pricedAsOf: "2026-01-01" },
    { key: "03-footings", label: "Concrete + rebar + forms", unit: "CY", unitCost: fromDollars(210), pricedAsOf: "2026-01-01" },
    { key: "03-sidewalk", label: "Concrete + base + mesh", unit: "SF", unitCost: fromDollars(5.5), pricedAsOf: "2026-01-01" },
    { key: "03-equipment-pad", label: "Concrete + rebar", unit: "EA", unitCost: fromDollars(650), pricedAsOf: "2026-01-01" },

    // Div 04
    { key: "04-cmu-wall", label: "Block + mortar + reinforcing", unit: "SF", unitCost: fromDollars(6.5), pricedAsOf: "2026-01-01" },
    { key: "04-brick-veneer", label: "Brick + mortar + ties", unit: "SF", unitCost: fromDollars(12.0), pricedAsOf: "2026-01-01" },
    { key: "04-masonry-repointing", label: "Mortar and cleaning materials", unit: "SF", unitCost: fromDollars(2.2), pricedAsOf: "2026-01-01" },

    // Div 05
    { key: "05-structural-steel", label: "Fabricated steel", unit: "TON", unitCost: fromDollars(2400), pricedAsOf: "2026-01-01" },
    { key: "05-steel-stair", label: "Fabricated stair and rail", unit: "EA", unitCost: fromDollars(4800), pricedAsOf: "2026-01-01" },
    { key: "05-metal-railing", label: "Railing material", unit: "LF", unitCost: fromDollars(85), pricedAsOf: "2026-01-01" },
    { key: "05-misc-metal-allowance", label: "Miscellaneous metal stock", unit: "LS", unitCost: fromDollars(3500), pricedAsOf: "2026-01-01" },

    // Div 06
    { key: "06-rough-framing", label: "Lumber + connectors", unit: "SF", unitCost: fromDollars(3.2), pricedAsOf: "2026-01-01" },
    { key: "06-blocking-nailer", label: "Treated lumber + fasteners", unit: "LF", unitCost: fromDollars(3.8), pricedAsOf: "2026-01-01" },
    { key: "06-roof-deck-repair", label: "Sheathing + fasteners", unit: "SF", unitCost: fromDollars(6.5), pricedAsOf: "2026-01-01" },
    { key: "06-deck-repair-allowance", label: "Deck repair materials allowance", unit: "LS", unitCost: fromDollars(4500), pricedAsOf: "2026-01-01" },
    { key: "06-finish-trim", label: "Trim stock, fasteners and filler", unit: "LF", unitCost: fromDollars(3.2), pricedAsOf: "2026-01-01" },
    { key: "06-casework", label: "Cabinets and casework", unit: "LF", unitCost: fromDollars(320), pricedAsOf: "2026-01-01" },

    // Div 07
    { key: "07-roof-tearoff", label: "Haul, tipping and disposal", unit: "SF", unitCost: fromDollars(0.85), pricedAsOf: "2026-01-01" },
    { key: "07-roof-insulation", label: "Polyiso board + fasteners", unit: "SF", unitCost: fromDollars(2.6), pricedAsOf: "2026-01-01" },
    { key: "07-roof-cover-board", label: "Cover board + fasteners", unit: "SF", unitCost: fromDollars(1.4), pricedAsOf: "2026-01-01" },
    { key: "07-roof-membrane-tpo", label: "60-mil TPO membrane + adhesive", unit: "SF", unitCost: fromDollars(3.4), pricedAsOf: "2026-01-01" },
    { key: "07-roof-membrane-epdm", label: "EPDM membrane + adhesive", unit: "SF", unitCost: fromDollars(3.1), pricedAsOf: "2026-01-01" },
    { key: "07-roof-modified-bitumen", label: "Mod-bit plies + adhesive", unit: "SF", unitCost: fromDollars(3.9), pricedAsOf: "2026-01-01" },
    { key: "07-roof-shingles", label: "Shingles + underlayment (per SQ)", unit: "SQ", unitCost: fromDollars(195), pricedAsOf: "2026-01-01" },
    { key: "07-roof-edge-metal", label: "ES-1 edge metal, fabricated", unit: "LF", unitCost: fromDollars(14.0), pricedAsOf: "2026-01-01" },
    { key: "07-roof-coping", label: "Coping cap, fabricated", unit: "LF", unitCost: fromDollars(21.0), pricedAsOf: "2026-01-01" },
    { key: "07-roof-drain", label: "Drain body, clamping ring, leader connection", unit: "EA", unitCost: fromDollars(420), pricedAsOf: "2026-01-01" },
    { key: "07-roof-curb-flashing", label: "Curb flashing materials", unit: "EA", unitCost: fromDollars(165), pricedAsOf: "2026-01-01" },
    { key: "07-roof-penetration-flashing", label: "Pipe boot and sealant", unit: "EA", unitCost: fromDollars(48), pricedAsOf: "2026-01-01" },
    { key: "07-roof-walkway-pad", label: "Walkway pad", unit: "LF", unitCost: fromDollars(11.0), pricedAsOf: "2026-01-01" },
    { key: "07-wall-insulation", label: "Insulation + vapor barrier", unit: "SF", unitCost: fromDollars(1.9), pricedAsOf: "2026-01-01" },
    { key: "07-fireproofing", label: "Fireproofing material", unit: "SF", unitCost: fromDollars(2.4), pricedAsOf: "2026-01-01" },
    { key: "07-caulking-sealant", label: "Sealant + backer rod", unit: "LF", unitCost: fromDollars(1.3), pricedAsOf: "2026-01-01" },

    // Div 08
    { key: "08-door-hollow-metal", label: "Door + frame + hardware", unit: "EA", unitCost: fromDollars(850), pricedAsOf: "2026-01-01" },
    { key: "08-door-wood", label: "Door + frame + hardware", unit: "EA", unitCost: fromDollars(720), pricedAsOf: "2026-01-01" },
    { key: "08-overhead-door", label: "Door, track, operator", unit: "EA", unitCost: fromDollars(4200), pricedAsOf: "2026-01-01" },
    { key: "08-storefront-glazing", label: "Aluminum frame + glazing", unit: "SF", unitCost: fromDollars(62), pricedAsOf: "2026-01-01" },
    { key: "08-window-replace", label: "Window unit + sealant", unit: "EA", unitCost: fromDollars(780), pricedAsOf: "2026-01-01" },

    // Div 09
    { key: "09-gypsum-board", label: "Board + studs + compound", unit: "SF", unitCost: fromDollars(1.6), pricedAsOf: "2026-01-01" },
    { key: "09-acoustic-ceiling", label: "Grid + tile", unit: "SF", unitCost: fromDollars(3.1), pricedAsOf: "2026-01-01" },
    { key: "09-painting", label: "Primer + finish coats", unit: "SF", unitCost: fromDollars(0.35), pricedAsOf: "2026-01-01" },
    { key: "09-flooring-vct", label: "Tile + adhesive", unit: "SF", unitCost: fromDollars(2.4), pricedAsOf: "2026-01-01" },
    { key: "09-flooring-carpet", label: "Carpet tile + adhesive", unit: "SY", unitCost: fromDollars(31), pricedAsOf: "2026-01-01" },
    { key: "09-flooring-epoxy", label: "Resin system", unit: "SF", unitCost: fromDollars(4.2), pricedAsOf: "2026-01-01" },
    { key: "09-ceramic-tile", label: "Tile + setting bed + grout", unit: "SF", unitCost: fromDollars(8.5), pricedAsOf: "2026-01-01" },

    // Div 10
    { key: "10-toilet-partition", label: "Partition + hardware", unit: "EA", unitCost: fromDollars(680), pricedAsOf: "2026-01-01" },
    { key: "10-signage", label: "Sign panel", unit: "EA", unitCost: fromDollars(190), pricedAsOf: "2026-01-01" },
    { key: "10-lockers", label: "Locker unit", unit: "EA", unitCost: fromDollars(310), pricedAsOf: "2026-01-01" },
    { key: "10-fire-extinguisher-cabinet", label: "Cabinet + extinguisher", unit: "EA", unitCost: fromDollars(240), pricedAsOf: "2026-01-01" },

    // Div 12
    { key: "12-countertop-quartz", label: "Quartz slab, fabrication and edge", unit: "SF", unitCost: fromDollars(58), pricedAsOf: "2026-01-01" },
    { key: "12-countertop-laminate", label: "Laminate top and substrate", unit: "LF", unitCost: fromDollars(42), pricedAsOf: "2026-01-01" },

    // Div 14
    { key: "14-elevator-modernization", label: "Controller, machine, fixtures", unit: "EA", unitCost: fromDollars(95000), pricedAsOf: "2026-01-01" },
    { key: "14-wheelchair-lift", label: "Lift unit", unit: "EA", unitCost: fromDollars(22000), pricedAsOf: "2026-01-01" },

    // Div 21 / 22
    { key: "21-fire-sprinkler", label: "Pipe, heads, fittings", unit: "SF", unitCost: fromDollars(3.4), pricedAsOf: "2026-01-01" },
    { key: "21-fire-standpipe", label: "Standpipe and valves", unit: "LF", unitCost: fromDollars(58), pricedAsOf: "2026-01-01" },
    { key: "22-plumbing-roughin", label: "Pipe + fittings + fixtures", unit: "SF", unitCost: fromDollars(6.0), pricedAsOf: "2026-01-01" },
    { key: "22-plumbing-fixture", label: "Fixture + trim + carrier", unit: "EA", unitCost: fromDollars(780), pricedAsOf: "2026-01-01" },
    { key: "22-water-heater", label: "Water heater + connections", unit: "EA", unitCost: fromDollars(3200), pricedAsOf: "2026-01-01" },
    { key: "22-domestic-water-pipe", label: "Pipe + fittings + insulation", unit: "LF", unitCost: fromDollars(22), pricedAsOf: "2026-01-01" },

    // Div 23
    { key: "23-hvac", label: "Equipment + ductwork + controls", unit: "SF", unitCost: fromDollars(14.0), pricedAsOf: "2026-01-01" },
    { key: "23-rtu-replacement", label: "Rooftop unit + curb adapter", unit: "EA", unitCost: fromDollars(18500), pricedAsOf: "2026-01-01" },
    { key: "23-ductwork", label: "Sheet metal + hangers + insulation", unit: "LF", unitCost: fromDollars(34), pricedAsOf: "2026-01-01" },
    { key: "23-exhaust-fan", label: "Fan + curb + damper", unit: "EA", unitCost: fromDollars(1450), pricedAsOf: "2026-01-01" },
    { key: "23-controls-allowance", label: "Controls devices and panel", unit: "LS", unitCost: fromDollars(12000), pricedAsOf: "2026-01-01" },

    // Div 26 / 27 / 28
    { key: "26-electrical", label: "Distribution + wire + fixtures", unit: "SF", unitCost: fromDollars(11.0), pricedAsOf: "2026-01-01" },
    { key: "26-lighting-fixture", label: "Fixture + lamp + driver", unit: "EA", unitCost: fromDollars(185), pricedAsOf: "2026-01-01" },
    { key: "26-branch-circuit", label: "Wire + conduit + fittings", unit: "LF", unitCost: fromDollars(6.2), pricedAsOf: "2026-01-01" },
    { key: "26-device-replace", label: "Device, plate and connectors", unit: "EA", unitCost: fromDollars(12), pricedAsOf: "2026-01-01" },
    { key: "26-gfci-receptacle", label: "GFCI device and plate", unit: "EA", unitCost: fromDollars(28), pricedAsOf: "2026-01-01" },
    { key: "26-dedicated-circuit", label: "Wire, breaker, conduit and box", unit: "EA", unitCost: fromDollars(95), pricedAsOf: "2026-01-01" },
    { key: "26-panel-modification", label: "Breakers and miscellaneous", unit: "LS", unitCost: fromDollars(450), pricedAsOf: "2026-01-01" },
    { key: "26-panelboard", label: "Panelboard + breakers", unit: "EA", unitCost: fromDollars(3400), pricedAsOf: "2026-01-01" },
    { key: "26-service-upgrade", label: "Service equipment and feeders", unit: "LS", unitCost: fromDollars(28000), pricedAsOf: "2026-01-01" },
    { key: "26-generator", label: "Generator + transfer switch", unit: "EA", unitCost: fromDollars(58000), pricedAsOf: "2026-01-01" },
    { key: "27-data-drop", label: "Cable + jack + patch", unit: "EA", unitCost: fromDollars(145), pricedAsOf: "2026-01-01" },
    { key: "28-fire-alarm", label: "Devices + panel + wire", unit: "SF", unitCost: fromDollars(2.3), pricedAsOf: "2026-01-01" },
    { key: "28-security-camera", label: "Camera + mount + cable", unit: "EA", unitCost: fromDollars(920), pricedAsOf: "2026-01-01" },

    // Div 31 / 32 / 33
    { key: "31-excavation", label: "Haul + disposal", unit: "CY", unitCost: fromDollars(12.0), pricedAsOf: "2026-01-01" },
    { key: "31-backfill-compact", label: "Imported fill", unit: "CY", unitCost: fromDollars(9.5), pricedAsOf: "2026-01-01" },
    { key: "31-erosion-control", label: "Silt fence and inlet protection", unit: "LF", unitCost: fromDollars(4.2), pricedAsOf: "2026-01-01" },
    { key: "32-asphalt-paving", label: "Asphalt mix + base course", unit: "SY", unitCost: fromDollars(28.0), pricedAsOf: "2026-01-01" },
    { key: "32-concrete-paving", label: "Concrete + base + reinforcing", unit: "SF", unitCost: fromDollars(7.2), pricedAsOf: "2026-01-01" },
    { key: "32-pavement-striping", label: "Paint and thermoplastic", unit: "LS", unitCost: fromDollars(2400), pricedAsOf: "2026-01-01" },
    { key: "32-chain-link-fence", label: "Fabric + posts + hardware", unit: "LF", unitCost: fromDollars(28), pricedAsOf: "2026-01-01" },
    { key: "32-landscaping", label: "Topsoil + seed + plantings", unit: "SF", unitCost: fromDollars(2.1), pricedAsOf: "2026-01-01" },
    { key: "33-site-water-line", label: "Pipe + fittings + bedding", unit: "LF", unitCost: fromDollars(42), pricedAsOf: "2026-01-01" },
    { key: "33-site-sewer-line", label: "Pipe + fittings + bedding", unit: "LF", unitCost: fromDollars(48), pricedAsOf: "2026-01-01" },
    { key: "33-storm-drain", label: "Pipe + structures + bedding", unit: "LF", unitCost: fromDollars(56), pricedAsOf: "2026-01-01" },
  ],

  markups: {
    fieldOverheadPct: 0.10,
    homeOfficeOverheadPct: 0.06,
    generalAdminPct: 0.04,
    feePct: 0.08,
    insurancePct: 0.02,
    contingencyPct: 0.10,
    bondRatePct: 0.015,
    laborBurdenPct: 0.35,
  },
};

export const findProductivity = (
  set: AssumptionSet,
  key: string,
): ProductivityRate | undefined => set.productivity.find((p) => p.key === key);

export const findMaterial = (
  set: AssumptionSet,
  key: string,
): MaterialRate | undefined => set.material.find((m) => m.key === key);

export const isCalibrated = (set: AssumptionSet, key: string): boolean =>
  set.calibratedKeys.includes(key);

export const validateAssumptions = (set: AssumptionSet): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const p of set.productivity) {
    if (seen.has(p.key)) errors.push(`${p.key}: duplicate productivity key`);
    seen.add(p.key);

    const total = p.crew.reduce((a, c) => a + c.share, 0);
    if (Math.abs(total - 1) > 1e-6) {
      errors.push(`${p.key}: crew shares sum to ${total.toFixed(4)}, expected 1`);
    }
    if (p.hoursPerUnit <= 0) {
      errors.push(`${p.key}: hoursPerUnit must be positive`);
    }
  }

  // A material rate whose unit disagrees with its productivity rate is silently
  // dropped at pricing time, so catch it here instead.
  const matSeen = new Set<string>();
  for (const m of set.material) {
    if (matSeen.has(m.key)) errors.push(`${m.key}: duplicate material key`);
    matSeen.add(m.key);

    const p = findProductivity(set, m.key);
    if (!p) {
      errors.push(`${m.key}: material rate has no matching productivity rate`);
    } else if (p.unit !== m.unit) {
      errors.push(
        `${m.key}: material unit ${m.unit} does not match productivity unit ${p.unit}`,
      );
    }
  }

  const mk = set.markups;
  if (mk.bondRatePct >= 1) errors.push("bondRatePct must be less than 1");
  for (const [k, v] of Object.entries(mk)) {
    if (v < 0) errors.push(`markups.${k} cannot be negative`);
  }
  return errors;
};
