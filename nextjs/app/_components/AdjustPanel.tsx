"use client";

import type { AssumptionSet, MarkupSchedule } from "@/lib/assumptions";
import type { Overrides } from "@/lib/reprice";
import type { ExtractedScope, PricedEstimate, Trade } from "@/lib/schema";
import type { WageTable } from "@/lib/data/wage-determinations";
import { money, titleCase } from "./ui";

/**
 * The adjustment panel.
 *
 * The estimator disagrees with a rate — a roofer costs more than the
 * determination says, the fixtures were quoted at half retail, the takeoff
 * missed a hundred square feet. They change it here and the whole report moves.
 *
 * **This panel produces no dollar amounts.** It sends inputs — a quantity, a
 * unit cost, a base wage, a percentage — to `/api/reprice`, which runs the same
 * Layer 2 function that produced the original figure and returns amounts. That
 * is what keeps an adjusted estimate as reproducible and auditable as an
 * unadjusted one: the overrides are part of the input record, not a spreadsheet
 * someone kept on the side.
 *
 * Clearing a field restores the engine value.
 */

const MARKUP_ROWS: Array<[keyof MarkupSchedule, string, string]> = [
  ["laborBurdenPct", "Labor burden", "Payroll tax, comp and benefits on top of the base wage"],
  ["fieldOverheadPct", "Field overhead", "Div 01 general conditions, applied to direct cost"],
  ["homeOfficeOverheadPct", "Home office overhead", "Applied to field cost"],
  ["generalAdminPct", "G&A", "Applied to field cost"],
  ["feePct", "Fee", "Your profit, applied to cost before fee"],
  ["insurancePct", "Insurance", "Applied to cost before fee"],
  ["contingencyPct", "Contingency", "Applied to cost before fee"],
  ["bondRatePct", "Bond rate", "Grossed up on the final contract amount"],
];

export function AdjustPanel({
  scope,
  assumptions,
  wages,
  estimate,
  overrides,
  onChange,
  onReset,
  isAdjusted,
  repricing,
}: {
  scope: ExtractedScope;
  assumptions: AssumptionSet;
  wages: WageTable;
  estimate: PricedEstimate;
  overrides: Overrides;
  onChange: (o: Overrides) => void;
  onReset: () => void;
  isAdjusted: boolean;
  repricing: boolean;
}) {
  // Only the keys and trades this job actually touches. The catalog holds
  // dozens more, and a wall of irrelevant rows buries the ones that matter.
  const usedKeys = [...new Set(scope.items.map((i) => i.assumption_key))];
  const usedTrades = [
    ...new Set(estimate.lines.flatMap((l) => l.labor.map((x) => x.trade))),
  ] as Trade[];

  // Loaded rates come straight from the engine's output; nothing is recomputed.
  const loadedByTrade = new Map<Trade, number>();
  for (const line of estimate.lines) {
    for (const l of line.labor) loadedByTrade.set(l.trade, l.loadedRate);
  }

  const set = (patch: Partial<Overrides>) => onChange({ ...overrides, ...patch });

  return (
    <div className="no-print adjust card">
      <header className="adjust-head">
        <div>
          <span className="eyebrow">Adjustments</span>
          <p className="adjust-intro">
            Change anything below and the price recalculates on the server. This panel sends your
            inputs, never amounts — every figure in the report still comes from the pricing
            engine. Clear a field to fall back to the engine value.
          </p>
        </div>
        <div className="adjust-head-actions">
          {repricing && <span className="pulse-tag">recalculating…</span>}
          {isAdjusted && (
            <button type="button" className="link-btn" onClick={onReset}>
              reset all
            </button>
          )}
        </div>
      </header>

      <AdjustGroup
        title="Quantities"
        note="Correct the takeoff where the extractor misread the solicitation."
      >
        {scope.items.map((item, i) => (
          <div key={i} className="adj-row">
            <div className="adj-label">
              <span>{item.description}</span>
              <span className="adj-sub">
                Div {item.csi_division} · {titleCase(item.work_type)} · {item.assumption_key} ·
                quantity {item.confidence}
              </span>
            </div>
            <NumberField
              value={overrides.quantities?.[String(i)]}
              placeholder={item.quantity}
              suffix={item.unit}
              step={1}
              onChange={(v) => set({ quantities: withKey(overrides.quantities, String(i), v) })}
            />
          </div>
        ))}
      </AdjustGroup>

      <AdjustGroup
        title="Material unit costs"
        note="What you actually pay your supplier, per catalog unit."
      >
        {usedKeys.map((key) => {
          const m = assumptions.material.find((x) => x.key === key);
          if (!m) {
            return (
              <div key={key} className="adj-row">
                <div className="adj-label">
                  <span>{key}</span>
                  <span className="adj-sub">
                    No material rate in the catalog — this line is labor-only or unpriced.
                  </span>
                </div>
              </div>
            );
          }
          return (
            <div key={key} className="adj-row">
              <div className="adj-label">
                <span>{m.label}</span>
                <span className="adj-sub">
                  {key} · priced as of {m.pricedAsOf}
                </span>
              </div>
              <NumberField
                prefix="$"
                value={overrides.materialUnitCosts?.[key]}
                placeholder={m.unitCost / 100}
                suffix={`/ ${m.unit}`}
                step={0.01}
                onChange={(v) =>
                  set({ materialUnitCosts: withKey(overrides.materialUnitCosts, key, v) })
                }
              />
            </div>
          );
        })}
      </AdjustGroup>

      <AdjustGroup
        title="Labor rates"
        note="Davis-Bacon base rate and fringe, per hour. The loaded rate adds the labor burden set below."
      >
        {usedTrades.length === 0 && (
          <p className="adj-sub">No trades are priced on this job yet.</p>
        )}
        {usedTrades.map((trade) => {
          const w = wages.rates[trade];
          const loaded = loadedByTrade.get(trade);
          const o = overrides.wageRates?.[trade];
          return (
            <div key={trade} className="adj-row">
              <div className="adj-label">
                <span>{titleCase(trade)}</span>
                <span className="adj-sub">
                  {w?.classification ?? "Not in the wage determination"}
                  {loaded !== undefined && ` · loaded ${money(loaded)}/hr`}
                </span>
              </div>
              <div className="adj-pair">
                <NumberField
                  prefix="$"
                  label="base"
                  value={o?.baseRate}
                  placeholder={w ? w.baseRate / 100 : 0}
                  step={0.01}
                  width={76}
                  onChange={(v) =>
                    set({ wageRates: withWage(overrides.wageRates, trade, "baseRate", v, w) })
                  }
                />
                <NumberField
                  prefix="$"
                  label="fringe"
                  value={o?.fringe}
                  placeholder={w ? w.fringe / 100 : 0}
                  step={0.01}
                  width={76}
                  onChange={(v) =>
                    set({ wageRates: withWage(overrides.wageRates, trade, "fringe", v, w) })
                  }
                />
              </div>
            </div>
          );
        })}
      </AdjustGroup>

      <AdjustGroup
        title="Markups"
        note="Overhead, fee, insurance and bond. These compound — each applies to a running total. The bid band scales with fee and contingency, so moving them moves the whole range."
      >
        {MARKUP_ROWS.map(([key, label, note]) => (
          <div key={key} className="adj-row">
            <div className="adj-label">
              <span>{label}</span>
              <span className="adj-sub">{note}</span>
            </div>
            <PercentField
              value={overrides.markups?.[key]}
              placeholder={assumptions.markups[key]}
              onChange={(v) =>
                set({ markups: withKey(overrides.markups, key, v) as Overrides["markups"] })
              }
            />
          </div>
        ))}
      </AdjustGroup>
    </div>
  );
}

function AdjustGroup({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <details className="adj-group" open>
      <summary>
        <span className="adj-group-title">{title}</span>
        <span className="adj-group-note">{note}</span>
      </summary>
      <div className="adj-group-body">{children}</div>
    </details>
  );
}

/**
 * Rounds a stepped value back onto the step grid.
 *
 * Without this, nudging 1.005 by 0.01 lands on 1.0150000000000001 and the field
 * shows it. The estimator is dragging a rate, not debugging floating point.
 */
function snap(value: number, step: number): number {
  const decimals = Math.max(0, (String(step).split(".")[1] ?? "").length);
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

/** − / + around an input. The keyboard already has arrows; a mouse does not. */
function Stepper({
  onStep,
  disabledDown,
  children,
  label,
}: {
  onStep: (direction: -1 | 1) => void;
  disabledDown?: boolean;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="step-btn"
        onClick={() => onStep(-1)}
        disabled={disabledDown}
        aria-label={`Decrease ${label}`}
        tabIndex={-1}
      >
        −
      </button>
      {children}
      <button
        type="button"
        className="step-btn"
        onClick={() => onStep(1)}
        aria-label={`Increase ${label}`}
        tabIndex={-1}
      >
        +
      </button>
    </div>
  );
}

function NumberField({
  value,
  placeholder,
  prefix,
  suffix,
  label,
  step = 1,
  width = 100,
  onChange,
}: {
  value: number | undefined;
  placeholder: number;
  prefix?: string;
  suffix?: string;
  label?: string;
  step?: number;
  width?: number;
  onChange: (v: number | undefined) => void;
}) {
  // An empty field means "use the engine value", so a nudge starts from that
  // value rather than from zero.
  const current = value ?? placeholder;

  return (
    <label className="num-field">
      {label && <span className="num-field-label">{label}</span>}
      {prefix && <span className="num-affix">{prefix}</span>}
      <Stepper
        label={label ?? suffix ?? "value"}
        disabledDown={current <= 0}
        onStep={(d) => onChange(Math.max(0, snap(current + d * step, step)))}
      >
        <input
          className="num-input"
          type="number"
          inputMode="decimal"
          step={step}
          min={0}
          value={value ?? ""}
          placeholder={String(
            Number.isInteger(placeholder) ? placeholder : placeholder.toFixed(2),
          )}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
          style={{ width }}
        />
      </Stepper>
      {suffix && <span className="num-affix">{suffix}</span>}
    </label>
  );
}

function PercentField({
  value,
  placeholder,
  onChange,
}: {
  value: number | undefined;
  placeholder: number;
  onChange: (v: number | undefined) => void;
}) {
  // Held as a fraction, shown and stepped as a percentage.
  const STEP = 0.25;
  const currentPct = (value ?? placeholder) * 100;
  const shown = value === undefined ? "" : String(Number((value * 100).toFixed(4)));

  const nudge = (d: -1 | 1) =>
    onChange(Math.min(95, Math.max(0, snap(currentPct + d * STEP, STEP))) / 100);

  return (
    <div className="pct-field">
      <input
        className="pct-slider"
        type="range"
        min={0}
        max={40}
        step={STEP}
        value={currentPct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label="percentage"
      />
      <label className="num-field">
        <Stepper label="percentage" disabledDown={currentPct <= 0} onStep={nudge}>
          <input
            className="num-input"
            type="number"
            inputMode="decimal"
            step={STEP}
            min={0}
            max={95}
            value={shown}
            placeholder={(placeholder * 100).toFixed(2)}
            style={{ width: 66 }}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(raw === "" ? undefined : Number(raw) / 100);
            }}
          />
        </Stepper>
        <span className="num-affix">%</span>
      </label>
    </div>
  );
}

/* ── Override helpers — plain object edits, no arithmetic on amounts ──────── */

function withKey<T extends Record<string, unknown>>(
  obj: T | undefined,
  key: string,
  value: number | undefined,
): T {
  const next = { ...(obj ?? {}) } as Record<string, unknown>;
  if (value === undefined || Number.isNaN(value)) delete next[key];
  else next[key] = value;
  return next as T;
}

function withWage(
  obj: Overrides["wageRates"],
  trade: Trade,
  field: "baseRate" | "fringe",
  value: number | undefined,
  current: { baseRate: number; fringe: number } | undefined,
): Overrides["wageRates"] {
  const next = { ...(obj ?? {}) } as Record<string, { baseRate: number; fringe: number }>;
  const baseDefault = (current?.baseRate ?? 0) / 100;
  const fringeDefault = (current?.fringe ?? 0) / 100;
  const existing = next[trade] ?? { baseRate: baseDefault, fringe: fringeDefault };

  // Clearing one field restores the determination value; clearing both drops
  // the override entirely so the row reads as untouched.
  const restored = field === "baseRate" ? baseDefault : fringeDefault;
  const candidate = {
    ...existing,
    [field]: value === undefined || Number.isNaN(value) ? restored : value,
  };

  if (candidate.baseRate === baseDefault && candidate.fringe === fringeDefault) {
    delete next[trade];
  } else {
    next[trade] = candidate;
  }
  return next as Overrides["wageRates"];
}
