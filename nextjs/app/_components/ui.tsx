"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Presentational primitives.
 *
 * Nothing in this file derives a dollar amount. `CountUp` interpolates toward a
 * figure the server already produced and always lands exactly on it; the
 * intermediate frames are animation, not arithmetic, and no intermediate value
 * is ever read back into the report.
 */

/* ── Formatting ───────────────────────────────────────────────────────────── */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Amounts arrive as integer cents; every display path goes through here. */
export const money = (c: number): string => USD.format(c / 100);

/** Axis ticks and dense labels, where the full figure would not fit. */
export function moneyCompact(c: number): string {
  const d = Math.abs(c / 100);
  const sign = c < 0 ? "−" : "";
  if (d >= 1_000_000_000) return `${sign}$${(d / 1_000_000_000).toFixed(d >= 10e9 ? 0 : 1)}B`;
  if (d >= 1_000_000) return `${sign}$${(d / 1_000_000).toFixed(d >= 10e6 ? 0 : 1)}M`;
  if (d >= 1_000) return `${sign}$${(d / 1_000).toFixed(d >= 10e3 ? 0 : 1)}K`;
  return `${sign}$${d.toFixed(0)}`;
}

export const signedMoney = (c: number): string =>
  `${c > 0 ? "+" : c < 0 ? "−" : ""}${money(Math.abs(c))}`;

export const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;

export const signedPct = (v: number, digits = 1): string =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(digits)}%`;

export const titleCase = (s: string): string =>
  s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

/* ── Motion ───────────────────────────────────────────────────────────────── */

/**
 * `useLayoutEffect` warns when it runs during server rendering, and the server
 * never animates anything, so it degrades to `useEffect` there.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Fires once, when the element first enters the viewport.
 *
 * Once-only on purpose: a chart that re-animates every time it scrolls back
 * into view is a toy. This one plays its entrance and then holds.
 */
export function useInView<T extends HTMLElement>(rootMargin = "-8% 0px -8% 0px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        }
      },
      { rootMargin, threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  return [ref, inView] as const;
}

/** Wraps children in a staggered entrance. `i` is the position in the stagger. */
export function Reveal({
  i = 0,
  className = "",
  style,
  children,
}: {
  i?: number;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`reveal ${inView ? "is-in" : ""} ${className}`}
      style={{ ...style, "--i": i } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts toward `value` and stops there exactly.
 *
 * Re-runs when the target moves, so an adjusted price animates from the old
 * figure to the new one rather than snapping.
 */
export function useCountUp(value: number, active: boolean, duration = 1100): number {
  /*
   * Seeded with the real figure, not with zero.
   *
   * This number is server-rendered, printed, and read by people whose browser
   * may never run the animation at all — an unobserved element, a print job, a
   * PDF renderer, reduced motion. Every one of those paths has to show the
   * price, so the correct value is what the DOM holds from the first render and
   * the animation is what takes it away and brings it back.
   */
  const [shown, setShown] = useState(value);
  /** What is on screen right now, so a target change animates from there. */
  const shownRef = useRef(value);
  const raf = useRef<number | null>(null);
  const started = useRef(false);

  // Drop to zero before the browser paints, so the entrance never flashes the
  // final figure first. Runs once, when the element first becomes visible.
  useIsomorphicLayoutEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    if (prefersReducedMotion()) return;
    shownRef.current = 0;
    setShown(0);
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const land = (v: number) => {
      shownRef.current = v;
      setShown(v);
    };

    const origin = shownRef.current;
    const span = value - origin;
    if (span === 0 || prefersReducedMotion()) {
      land(value);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // The last frame assigns `value` itself rather than origin + span * 1, so
      // floating-point drift can never leave the display a cent off the engine.
      if (t >= 1) {
        land(value);
        return;
      }
      const v = origin + span * easeOutCubic(t);
      shownRef.current = v;
      setShown(v);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [value, active, duration]);

  return shown;
}

/** A currency figure that counts up when it scrolls into view. */
export function CountMoney({
  cents,
  className = "",
  compact = false,
  duration,
}: {
  cents: number;
  className?: string;
  compact?: boolean;
  duration?: number;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const shown = useCountUp(cents, inView, duration);
  return (
    <span ref={ref} className={className}>
      {compact ? moneyCompact(shown) : money(shown)}
    </span>
  );
}

/* ── Small presentational pieces ──────────────────────────────────────────── */

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

/** A titled block inside the report document. */
export function Section({
  n,
  title,
  intro,
  children,
  breakBefore = false,
}: {
  n?: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  breakBefore?: boolean;
}) {
  return (
    <section
      className={`rep-section keep-together ${breakBefore ? "page-break" : ""}`}
      aria-label={title}
    >
      <header className="rep-section-head">
        {n && <span className="rep-section-n tnum">{n}</span>}
        <h2 className="rep-section-title">{title}</h2>
      </header>
      {intro && <p className="rep-section-intro">{intro}</p>}
      {children}
    </section>
  );
}

/** Label / value pair used across the fact grids. */
export function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "warn" | "good";
}) {
  return (
    <div className="fact">
      <dt className="fact-label">{label}</dt>
      <dd className={`fact-value${tone ? ` fact-${tone}` : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * Status chip. Colour never carries the meaning alone — every chip renders a
 * glyph and a word, which is what makes the status palette safe to use.
 */
export function StatusChip({
  tone,
  children,
}: {
  tone: "good" | "warning" | "serious" | "critical" | "neutral";
  children: ReactNode;
}) {
  const glyph = {
    good: "✓",
    warning: "!",
    serious: "!",
    critical: "×",
    neutral: "·",
  }[tone];
  return (
    <span className={`chip chip-${tone}`}>
      <span className="chip-glyph" aria-hidden="true">
        {glyph}
      </span>
      {children}
    </span>
  );
}

/**
 * A section the reader can fold away.
 *
 * Long lists — two dozen qualifications, a markup schedule, a chart's table
 * twin — are load-bearing for the estimator and noise for everyone else. They
 * fold on screen and are forced open in print, because a folded list in a
 * printed document is simply a missing list.
 */
export function Collapse({
  summary,
  count,
  open = false,
  children,
}: {
  summary: string;
  count?: number;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="collapse" open={open}>
      <summary>
        <span>{summary}</span>
        {count !== undefined && <span className="collapse-count tnum">{count}</span>}
      </summary>
      <div className="collapse-body">{children}</div>
    </details>
  );
}

/* ── Chart scaffolding ────────────────────────────────────────────────────── */

/**
 * A linear scale over a dollar domain.
 *
 * Charts position marks; they never compute amounts. Everything this returns is
 * a pixel coordinate.
 */
export function useScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return useMemo(() => {
    const span = d1 - d0 || 1;
    return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
  }, [d0, d1, r0, r1]);
}

/** Rounded tick values across a domain, for axes that need clean numbers. */
export function ticks(min: number, max: number, count = 4): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) out.push(v);
  return out;
}

/** Wraps a chart with its title, legend slot, and a table-view disclosure. */
export function Figure({
  title,
  subtitle,
  legend,
  children,
  table,
  note,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: ReactNode;
  children: ReactNode;
  /** The WCAG-clean twin. Every chart has one; nothing is gated behind hover. */
  table?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <figure className="figure keep-together">
      <figcaption className="figure-head">
        <div>
          <h3 className="figure-title">{title}</h3>
          {subtitle && <p className="figure-sub">{subtitle}</p>}
        </div>
        {legend}
      </figcaption>
      <div className="figure-body">{children}</div>
      {note && <p className="figure-note">{note}</p>}
      {table && (
        <details className="figure-table">
          <summary>Table view</summary>
          {table}
        </details>
      )}
    </figure>
  );
}

/** Legend row. Identity is the swatch; the text stays in ink tokens. */
export function Legend({
  items,
}: {
  items: Array<{ color: string; label: string; shape?: "swatch" | "line" | "dot" }>;
}) {
  return (
    <ul className="legend">
      {items.map((it) => (
        <li key={it.label} className="legend-item">
          <span
            className={`legend-mark legend-${it.shape ?? "swatch"}`}
            style={{ background: it.color, borderColor: it.color }}
            aria-hidden="true"
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
