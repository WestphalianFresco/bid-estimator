"use client";

import type { BidBand, MarketStats } from "@/lib/bands";
import type { CostSlice } from "@/lib/rollups";
import {
  Figure,
  Legend,
  money,
  moneyCompact,
  pct,
  signedPct,
  ticks,
  useInView,
  useScale,
} from "./ui";

/**
 * The report's charts.
 *
 * Every one of them is hand-drawn SVG over a fixed viewBox, scaled to the
 * column width. No charting library, and no canvas: an SVG chart prints at the
 * printer's resolution rather than the screen's, which matters when the output
 * of this app is a PDF a client reads.
 *
 * Colours are read as roles (`--series-1`, `--ordinal-2`, `--grid`) so the same
 * markup renders correctly on the dark working surface, on paper, and in print,
 * with palettes that were validated separately against each surface.
 *
 * These charts position marks. They never compute an amount — every dollar
 * figure arrives from the pricing engine and is only mapped to a coordinate.
 */

/* ── Geometry helpers ─────────────────────────────────────────────────────── */

/** The stagger index, as a typed style object. */
const step = (i: number): React.CSSProperties => ({ "--i": i }) as React.CSSProperties;

/** Growth transform anchored to the bar's own left edge, plus its stagger. */
const growFromLeft = (i = 0): React.CSSProperties =>
  ({
    transformBox: "fill-box",
    transformOrigin: "left center",
    "--i": i,
  }) as React.CSSProperties;

/** Long axis labels are trimmed rather than allowed to collide. */
const trim = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/**
 * A horizontal bar with its far end rounded and its baseline end square.
 *
 * Rounding both ends would detach the bar from its axis; rounding neither reads
 * as a block. Four pixels on the data end is the whole spec.
 */
function hBar(x0: number, y: number, w: number, h: number, r = 4): string {
  const width = Math.max(w, 0);
  const rad = Math.min(r, width, h / 2);
  if (width <= 0.5) return "";
  return [
    `M${x0},${y}`,
    `H${x0 + width - rad}`,
    `a${rad},${rad} 0 0 1 ${rad},${rad}`,
    `V${y + h - rad}`,
    `a${rad},${rad} 0 0 1 ${-rad},${rad}`,
    `H${x0}`,
    "Z",
  ].join(" ");
}

/** Rounded on both ends — for a floating segment that touches no baseline. */
const pill = (x0: number, y: number, w: number, h: number): string => {
  const width = Math.max(w, h);
  return `M${x0 + h / 2},${y} H${x0 + width - h / 2} a${h / 2},${h / 2} 0 0 1 0,${h} H${x0 + h / 2} a${h / 2},${h / 2} 0 0 1 0,${-h} Z`;
};

const ORDINAL = ["var(--ordinal-1)", "var(--ordinal-2)", "var(--ordinal-3)"];
const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];

/** Padded domain that never collapses to a point and never goes negative. */
function domainOf(values: number[], padFraction = 0.08): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * padFraction || Math.abs(hi) * 0.12 || 1;
  return [Math.max(0, lo - pad), hi + pad];
}

/* ── 1 · Where this bid sits in the local market ──────────────────────────── */

const MP = { w: 960, h: 300, padL: 34, padR: 34, axisY: 246, laneBid: 96, laneMkt: 180 };

export function MarketPositionChart({
  bands,
  market,
  locationLabel,
}: {
  bands: BidBand[];
  market: MarketStats;
  locationLabel: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();

  const low = bands[0];
  const high = bands[bands.length - 1];
  const recommended = bands.find((b) => b.id === "recommended") ?? bands[0];
  const hasMarket = market.p25 !== null && market.p50 !== null && market.p75 !== null;

  const domain = domainOf([
    low.bidPrice,
    high.bidPrice,
    ...(hasMarket ? [market.min!, market.max!] : []),
  ]);
  const x = useScale(domain, [MP.padL, MP.w - MP.padR]);
  const tickValues = ticks(domain[0], domain[1], 4);

  const bandX0 = x(low.bidPrice);
  const bandX1 = x(high.bidPrice);

  return (
    <Figure
      title="Where this bid sits in the local market"
      subtitle={
        hasMarket
          ? `The bid band against ${market.count} comparable federal award${market.count === 1 ? "" : "s"} in ${locationLabel}.`
          : `Not enough comparable awards in ${locationLabel} to plot a market range.`
      }
      legend={
        <Legend
          items={[
            { color: "var(--accent)", label: "This bid band", shape: "line" },
            ...(hasMarket
              ? [{ color: "var(--market-wash)", label: "Comparable awards, p25–p75" }]
              : []),
          ]}
        />
      }
      note={
        hasMarket
          ? "Each tick on the lower lane is one awarded contract. The vertical rule is the local median. Award amounts include the winning contractor's own fee and risk premium, and are not costs."
          : "A market range needs at least five comparable awards. Set the state and county and re-run to enable this comparison."
      }
      table={
        <table className="mini-table">
          <thead>
            <tr>
              <th>Reference point</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.id}>
                <td>{b.label} bid</td>
                <td className="num tnum">{money(b.bidPrice)}</td>
              </tr>
            ))}
            {hasMarket && (
              <>
                <tr>
                  <td>Local p25</td>
                  <td className="num tnum">{money(market.p25!)}</td>
                </tr>
                <tr>
                  <td>Local median (p50)</td>
                  <td className="num tnum">{money(market.p50!)}</td>
                </tr>
                <tr>
                  <td>Local p75</td>
                  <td className="num tnum">{money(market.p75!)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      }
    >
      <div ref={ref}>
        <svg
          viewBox={`0 0 ${MP.w} ${MP.h}`}
          className="chart"
          role="img"
          aria-label="Bid band plotted against the distribution of comparable local awards"
        >
          <g className={inView ? "is-in" : ""}>
            {/* Gridlines — solid hairlines, one step off the surface */}
            {tickValues.map((t) => (
              <line
                key={t}
                x1={x(t)}
                x2={x(t)}
                y1={66}
                y2={MP.axisY}
                stroke="var(--grid)"
                strokeWidth={1}
              />
            ))}

            <line
              x1={MP.padL}
              x2={MP.w - MP.padR}
              y1={MP.axisY}
              y2={MP.axisY}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            {tickValues.map((t) => (
              <text key={t} x={x(t)} y={MP.axisY + 22} className="ax" textAnchor="middle">
                {moneyCompact(t)}
              </text>
            ))}

            {/* ── Market lane ──────────────────────────────────────────── */}
            {hasMarket && (
              <>
                <rect
                  x={x(market.p25!)}
                  y={MP.laneMkt - 19}
                  width={Math.max(x(market.p75!) - x(market.p25!), 2)}
                  height={38}
                  rx={4}
                  fill="var(--market-wash)"
                  className="grow"
                  style={growFromLeft()}
                />
                {market.awards.map((a, i) => (
                  <line
                    key={`${a}-${i}`}
                    x1={x(a)}
                    x2={x(a)}
                    y1={MP.laneMkt - 21}
                    y2={MP.laneMkt + 21}
                    stroke="var(--ink-3)"
                    strokeWidth={1.5}
                    opacity={0.4}
                    className="fade"
                    style={step(3)}
                  />
                ))}
                {/* Local median — a reference, drawn in ink, never a series colour */}
                <line
                  x1={x(market.p50!)}
                  x2={x(market.p50!)}
                  y1={MP.laneBid - 18}
                  y2={MP.laneMkt + 30}
                  stroke="var(--ink-2)"
                  strokeWidth={2}
                  className="fade"
                  style={step(4)}
                />
                <text
                  x={x(market.p50!)}
                  y={MP.laneMkt + 48}
                  className="ax-strong"
                  textAnchor="middle"
                >
                  Local median {moneyCompact(market.p50!)}
                </text>
                <text x={MP.padL} y={MP.laneMkt - 34} className="lane-label">
                  Comparable local awards
                </text>
              </>
            )}

            {/* ── Bid lane ─────────────────────────────────────────────── */}
            <text x={MP.padL} y={MP.laneBid - 46} className="lane-label">
              This bid band
            </text>
            <path
              d={pill(bandX0, MP.laneBid - 6, bandX1 - bandX0, 12)}
              fill="var(--accent-soft)"
              className="grow"
              style={growFromLeft()}
            />
            {bands.map((b, i) => (
              <g key={b.id} className="fade" style={step(i + 1)}>
                <circle
                  cx={x(b.bidPrice)}
                  cy={MP.laneBid}
                  r={b.id === "recommended" ? 9 : 6}
                  fill={ORDINAL[i]}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              </g>
            ))}
            {/*
              One caption for the whole band, not one per end.
              A band this narrow beside a wide market range puts its two ends
              within a few dozen units of each other, and two labels there
              overlap into an unreadable smear. The caption is centred on the
              band and clamped so it cannot run off the canvas either.
            */}
            <text
              x={Math.min(Math.max((bandX0 + bandX1) / 2, 170), MP.w - 170)}
              y={MP.laneBid + 32}
              className="ax"
              textAnchor="middle"
            >
              {low.label} {moneyCompact(low.bidPrice)} — {high.label}{" "}
              {moneyCompact(high.bidPrice)}
            </text>
            <text
              x={x(recommended.bidPrice)}
              y={MP.laneBid - 20}
              className="mark-label"
              textAnchor="middle"
            >
              {money(recommended.bidPrice)}
            </text>
          </g>
        </svg>
      </div>
    </Figure>
  );
}

/* ── 2 · The band against the local median ────────────────────────────────── */

const BM = { w: 960, top: 62, rowH: 78, labelW: 196, rightPad: 188 };

export function BandVsMarketChart({ bands, market }: { bands: BidBand[]; market: MarketStats }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const hasMedian = market.p50 !== null;

  const height = BM.top + bands.length * BM.rowH + 26;
  const x0 = BM.labelW;
  const x1 = BM.w - BM.rightPad;

  const domain: [number, number] = [
    0,
    Math.max(...bands.map((b) => b.bidPrice), market.p50 ?? 0) * 1.06,
  ];
  const x = useScale(domain, [x0, x1]);
  const tickValues = ticks(0, domain[1], 4);

  return (
    <Figure
      title="Bid band against the local median award"
      subtitle="One estimate, three commercial postures. The cost is identical in all three — only fee and contingency move."
      legend={
        hasMedian ? (
          <Legend items={[{ color: "var(--ink-2)", label: "Local median", shape: "line" }]} />
        ) : undefined
      }
      note="Fee is the contractor's profit. Contingency is the allowance carried for what the solicitation did not say. Lowering either lowers the bid and raises the risk the contractor absorbs after award."
      table={
        <table className="mini-table">
          <thead>
            <tr>
              <th>Posture</th>
              <th className="num">Fee</th>
              <th className="num">Contingency</th>
              <th className="num">Bid price</th>
              <th className="num">vs local median</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.id}>
                <td>{b.label}</td>
                <td className="num tnum">{pct(b.feePct, 2)}</td>
                <td className="num tnum">{pct(b.contingencyPct, 2)}</td>
                <td className="num tnum">{money(b.bidPrice)}</td>
                <td className="num tnum">
                  {b.ratioVsMarket === null ? "—" : signedPct(b.ratioVsMarket - 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div ref={ref}>
        <svg
          viewBox={`0 0 ${BM.w} ${height}`}
          className="chart"
          role="img"
          aria-label="Aggressive, recommended and conservative bid prices compared with the local median award"
        >
          <g className={inView ? "is-in" : ""}>
            {tickValues.map((t) => (
              <line
                key={t}
                x1={x(t)}
                x2={x(t)}
                y1={BM.top - 26}
                y2={height - 26}
                stroke="var(--grid)"
                strokeWidth={1}
              />
            ))}
            {tickValues.map((t) => (
              <text key={t} x={x(t)} y={height - 8} className="ax" textAnchor="middle">
                {moneyCompact(t)}
              </text>
            ))}

            {hasMedian && (
              <g className="fade" style={step(3)}>
                <line
                  x1={x(market.p50!)}
                  x2={x(market.p50!)}
                  y1={BM.top - 34}
                  y2={height - 26}
                  stroke="var(--ink-2)"
                  strokeWidth={2}
                />
                <text x={x(market.p50!)} y={BM.top - 42} className="ax-strong" textAnchor="middle">
                  Local median {moneyCompact(market.p50!)}
                </text>
              </g>
            )}

            {bands.map((b, i) => {
              const y = BM.top + i * BM.rowH;
              const barY = y + 8;
              const w = x(b.bidPrice) - x0;
              return (
                <g key={b.id}>
                  <text x={x0 - 18} y={barY + 12} className="row-label" textAnchor="end">
                    {b.label}
                  </text>
                  <text x={x0 - 18} y={barY + 30} className="row-sub" textAnchor="end">
                    {b.headline}
                  </text>
                  <path
                    d={hBar(x0, barY, w, 26)}
                    fill={ORDINAL[i]}
                    className="grow"
                    style={growFromLeft(i)}
                  />
                  <g className="fade" style={step(i + 2)}>
                    <text x={x0 + w + 14} y={barY + 12} className="val-label">
                      {money(b.bidPrice)}
                    </text>
                    {b.ratioVsMarket !== null && (
                      <text x={x0 + w + 14} y={barY + 30} className="row-sub">
                        {signedPct(b.ratioVsMarket - 1)} vs median
                      </text>
                    )}
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </Figure>
  );
}

/* ── 3 · Part-to-whole: how the bid price is built ────────────────────────── */

export function StackedShareBar({
  title,
  subtitle,
  note,
  slices,
  total,
  totalLabel,
}: {
  title: string;
  subtitle?: string;
  note?: string;
  slices: CostSlice[];
  total: number;
  totalLabel: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();

  const W = 960;
  const H = 76;
  const padL = 4;
  const padR = 4;
  const barY = 32;
  const barH = 30;
  const inner = W - padL - padR;
  /** A gap in the surface colour is what separates touching segments. */
  const GAP = 3;

  let cursor = padL;
  const drawn = slices.map((s, i) => {
    const w = total > 0 ? (s.amount / total) * inner : 0;
    const seg = { ...s, x: cursor, w, i };
    cursor += w;
    return seg;
  });

  return (
    <Figure
      title={title}
      subtitle={subtitle}
      note={note}
      table={
        <table className="mini-table">
          <thead>
            <tr>
              <th>Component</th>
              <th className="num">Amount</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td className="num tnum">{money(s.amount)}</td>
                <td className="num tnum">{pct(s.share)}</td>
              </tr>
            ))}
            <tr className="mini-total">
              <td>{totalLabel}</td>
              <td className="num tnum">{money(total)}</td>
              <td className="num tnum">100.0%</td>
            </tr>
          </tbody>
        </table>
      }
    >
      <div ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="chart"
          role="img"
          aria-label={`${title}: ${slices.map((s) => `${s.label} ${pct(s.share)}`).join(", ")}`}
        >
          <g className={inView ? "is-in" : ""}>
            <text x={padL} y={18} className="row-sub">
              {totalLabel}
            </text>
            <text x={W - padR} y={18} className="val-label" textAnchor="end">
              {money(total)}
            </text>
            <g className="grow" style={growFromLeft()}>
              {drawn.map((s) => (
                <path
                  key={s.key}
                  d={hBar(s.x, barY, Math.max(s.w - GAP, 1), barH, 4)}
                  fill={SERIES[s.i % SERIES.length]}
                />
              ))}
            </g>
          </g>
        </svg>

        {/*
          Values ride in the legend rather than under the segments.
          A four-part cost build-up routinely produces a segment narrower than
          its own label — fee is often under 8% — and labels placed under the
          marks then either collide with their neighbours or run off the right
          edge. The legend carries the same figures, cannot collide, and keeps
          identity off colour alone.
        */}
        <ul className="value-legend">
          {drawn.map((s) => (
            <li key={s.key} className={`vl-item${inView ? " is-in" : ""}`} style={step(s.i + 1)}>
              <span
                className="vl-swatch"
                style={{ background: SERIES[s.i % SERIES.length] }}
                aria-hidden="true"
              />
              <span className="vl-label">{s.label}</span>
              <span className="vl-amount tnum">{money(s.amount)}</span>
              <span className="vl-share tnum">{pct(s.share)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Figure>
  );
}

/* ── 4 · Direct cost by CSI division ──────────────────────────────────────── */

export function DivisionBars({
  slices,
  total,
  maxRows = 9,
}: {
  slices: CostSlice[];
  total: number;
  maxRows?: number;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();

  const rows = slices.slice(0, maxRows);
  const hidden = slices.length - rows.length;

  const W = 960;
  const rowH = 40;
  const top = 20;
  const labelW = 330;
  const rightPad = 190;
  const H = top + rows.length * rowH + 18;
  const x0 = labelW;
  const x1 = W - rightPad;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const x = useScale([0, max], [x0, x1]);

  return (
    <Figure
      title="Direct cost by CSI division"
      subtitle="Labor, material, equipment and subcontract for each division, before any markup."
      note={
        hidden > 0
          ? `The ${hidden} smallest division${hidden === 1 ? "" : "s"} are not plotted; every division appears in the table view and in the scope schedule.`
          : undefined
      }
      table={
        <table className="mini-table">
          <thead>
            <tr>
              <th>Division</th>
              <th className="num">Direct cost</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td className="num tnum">{money(s.amount)}</td>
                <td className="num tnum">{pct(s.share)}</td>
              </tr>
            ))}
            <tr className="mini-total">
              <td>Total direct cost</td>
              <td className="num tnum">{money(total)}</td>
              <td className="num tnum">100.0%</td>
            </tr>
          </tbody>
        </table>
      }
    >
      <div ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="chart"
          role="img"
          aria-label="Direct cost by CSI division, largest first"
        >
          <g className={inView ? "is-in" : ""}>
            {rows.map((s, i) => {
              const y = top + i * rowH;
              const w = x(s.amount) - x0;
              return (
                <g key={s.key}>
                  <text x={x0 - 18} y={y + 20} className="row-label-sm" textAnchor="end">
                    {trim(s.label, 40)}
                  </text>
                  <path
                    d={hBar(x0, y + 5, w, 20)}
                    fill="var(--series-1)"
                    className="grow"
                    style={growFromLeft(i)}
                  />
                  <g className="fade" style={step(i + 1)}>
                    <text x={x0 + w + 14} y={y + 20} className="val-label-sm">
                      {money(s.amount)}
                    </text>
                    <text x={W - 12} y={y + 20} className="row-sub" textAnchor="end">
                      {pct(s.share)}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </Figure>
  );
}
