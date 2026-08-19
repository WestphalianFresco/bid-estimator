import type { Cents } from "./money";
import { fromDollars } from "./money";
import type { CsiDivision, Trade, Unit } from "./schema";

export interface CrewMix {
  trade: Trade;
  share: number;
}

export interface ProductivityRate {
  key: string;
  csiDivision: CsiDivision;
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

export const STARTING_DEFAULTS: AssumptionSet = {
  owner: "system",
  version: 0,
  updatedAt: "1970-01-01",
  calibratedKeys: [],

  productivity: [
    {
      key: "03-slab-on-grade",
      csiDivision: "03",
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
      key: "04-cmu-wall",
      csiDivision: "04",
      label: "CMU wall",
      unit: "SF",
      hoursPerUnit: 0.12,
      crew: [
        { trade: "bricklayer", share: 0.6 },
        { trade: "laborer", share: 0.4 },
      ],
    },
    {
      key: "05-structural-steel",
      csiDivision: "05",
      label: "Structural steel erection",
      unit: "TON",
      hoursPerUnit: 7.0,
      crew: [
        { trade: "ironworker", share: 0.75 },
        { trade: "operating_engineer", share: 0.25 },
      ],
    },
    {
      key: "06-rough-framing",
      csiDivision: "06",
      label: "Rough carpentry framing",
      unit: "SF",
      hoursPerUnit: 0.05,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "07-roof-membrane",
      csiDivision: "07",
      label: "Roof membrane",
      unit: "SF",
      hoursPerUnit: 0.03,
      crew: [{ trade: "roofer", share: 1.0 }],
    },
    {
      key: "08-door-install",
      csiDivision: "08",
      label: "Door install (incl. hardware)",
      unit: "EA",
      hoursPerUnit: 1.5,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "09-gypsum-board",
      csiDivision: "09",
      label: "Gypsum board (hang + finish)",
      unit: "SF",
      hoursPerUnit: 0.02,
      crew: [{ trade: "carpenter", share: 1.0 }],
    },
    {
      key: "09-painting",
      csiDivision: "09",
      label: "Painting (two coats)",
      unit: "SF",
      hoursPerUnit: 0.008,
      crew: [{ trade: "painter", share: 1.0 }],
    },
    {
      key: "22-plumbing-roughin",
      csiDivision: "22",
      label: "Plumbing rough-in (per GSF)",
      unit: "SF",
      hoursPerUnit: 0.05,
      crew: [
        { trade: "plumber", share: 0.7 },
        { trade: "pipefitter", share: 0.3 },
      ],
    },
    {
      key: "23-hvac",
      csiDivision: "23",
      label: "HVAC (per GSF)",
      unit: "SF",
      hoursPerUnit: 0.08,
      crew: [
        { trade: "sheet_metal_worker", share: 0.5 },
        { trade: "pipefitter", share: 0.5 },
      ],
    },
    {
      key: "26-electrical",
      csiDivision: "26",
      label: "Electrical (per GSF)",
      unit: "SF",
      hoursPerUnit: 0.09,
      crew: [{ trade: "electrician", share: 1.0 }],
    },
    {
      key: "31-excavation",
      csiDivision: "31",
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
      key: "32-asphalt-paving",
      csiDivision: "32",
      label: "Asphalt paving",
      unit: "SY",
      hoursPerUnit: 0.01,
      crew: [
        { trade: "operating_engineer", share: 0.4 },
        { trade: "laborer", share: 0.6 },
      ],
    },
  ],

  material: [
    { key: "03-slab-on-grade", label: "Concrete + rebar + base", unit: "SF", unitCost: fromDollars(4.5), pricedAsOf: "2026-01-01" },
    { key: "03-cip-walls", label: "Concrete + form materials", unit: "SF", unitCost: fromDollars(9.0), pricedAsOf: "2026-01-01" },
    { key: "04-cmu-wall", label: "Block + mortar + reinforcing", unit: "SF", unitCost: fromDollars(6.5), pricedAsOf: "2026-01-01" },
    { key: "05-structural-steel", label: "Fabricated steel", unit: "TON", unitCost: fromDollars(2400), pricedAsOf: "2026-01-01" },
    { key: "06-rough-framing", label: "Lumber + connectors", unit: "SF", unitCost: fromDollars(3.2), pricedAsOf: "2026-01-01" },
    { key: "07-roof-membrane", label: "Membrane + insulation + flashing", unit: "SF", unitCost: fromDollars(5.0), pricedAsOf: "2026-01-01" },
    { key: "08-door-install", label: "Door + frame + hardware", unit: "EA", unitCost: fromDollars(850), pricedAsOf: "2026-01-01" },
    { key: "09-gypsum-board", label: "Board + studs + compound", unit: "SF", unitCost: fromDollars(1.6), pricedAsOf: "2026-01-01" },
    { key: "09-painting", label: "Primer + finish coats", unit: "SF", unitCost: fromDollars(0.35), pricedAsOf: "2026-01-01" },
    { key: "22-plumbing-roughin", label: "Pipe + fittings + fixtures", unit: "SF", unitCost: fromDollars(6.0), pricedAsOf: "2026-01-01" },
    { key: "23-hvac", label: "Equipment + ductwork + controls", unit: "SF", unitCost: fromDollars(14.0), pricedAsOf: "2026-01-01" },
    { key: "26-electrical", label: "Distribution + wire + fixtures", unit: "SF", unitCost: fromDollars(11.0), pricedAsOf: "2026-01-01" },
    { key: "31-excavation", label: "Haul + disposal", unit: "CY", unitCost: fromDollars(12.0), pricedAsOf: "2026-01-01" },
    { key: "32-asphalt-paving", label: "Asphalt mix + base course", unit: "SY", unitCost: fromDollars(28.0), pricedAsOf: "2026-01-01" },
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
  for (const p of set.productivity) {
    const total = p.crew.reduce((a, c) => a + c.share, 0);
    if (Math.abs(total - 1) > 1e-6) {
      errors.push(`${p.key}: crew shares sum to ${total.toFixed(4)}, expected 1`);
    }
    if (p.hoursPerUnit <= 0) {
      errors.push(`${p.key}: hoursPerUnit must be positive`);
    }
  }
  const m = set.markups;
  if (m.bondRatePct >= 1) errors.push("bondRatePct must be less than 1");
  for (const [k, v] of Object.entries(m)) {
    if (v < 0) errors.push(`markups.${k} cannot be negative`);
  }
  return errors;
};
