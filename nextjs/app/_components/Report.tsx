"use client";

import type { AssumptionSet, MarkupSchedule } from "@/lib/assumptions";
import type { BidBandSet } from "@/lib/bands";
import type { CompositionSummary } from "@/lib/rollups";
import { waterfallRows } from "@/lib/price";
import type { Overrides } from "@/lib/reprice";
import type { CrossCheck, EstimateSnapshot, PricedEstimate } from "@/lib/schema";
import {
  BandVsMarketChart,
  DivisionBars,
  MarketPositionChart,
  StackedShareBar,
} from "./charts";
import type { EstimatePayload, Letterhead } from "./types";
import {
  Collapse,
  CountMoney,
  Fact,
  Reveal,
  Section,
  StatusChip,
  money,
  pct,
  signedMoney,
  signedPct,
  titleCase,
} from "./ui";

/**
 * The report.
 *
 * This is the deliverable — the thing that leaves the building. It is written
 * as a proposal, not as a dashboard: a letterhead, a price, the band around
 * that price, the schedule the price was built from, and the qualifications
 * that limit it.
 *
 * It is deliberately short. An estimate of this kind generates a great deal of
 * material an estimator needs and a client will never read — two dozen
 * qualifications, a markup schedule, a per-line audit trail — and the way to
 * serve both readers is not to print all of it at the same weight. The eight
 * sections below carry the argument; everything else folds away behind a
 * summary line and is forced open again in print, so nothing is lost from the
 * record.
 *
 * On screen it renders on the working surface; printed it renders on paper with
 * the same content and the same numbers. There is no separate export template
 * to drift out of sync.
 */

const VERDICT: Record<
  CrossCheck["verdict"],
  { tone: "good" | "warning" | "neutral"; label: string; sentence: string }
> = {
  within_range: {
    tone: "good",
    label: "Within the local range",
    sentence:
      "The recommended price sits inside the middle half of comparable federal awards for this " +
      "work in this state — where a competitive bid normally lands.",
  },
  below_range: {
    tone: "warning",
    label: "Below the local p25",
    sentence:
      "The recommended price is below the lower quartile of comparable awards — either a real " +
      "cost advantage or missing scope. Confirm which before submitting.",
  },
  above_range: {
    tone: "warning",
    label: "Above the local p75",
    sentence:
      "The recommended price is above the upper quartile of comparable awards. Expect to justify " +
      "the difference, or find where this estimate carries cost the market does not.",
  },
  insufficient_data: {
    tone: "neutral",
    label: "No local benchmark",
    sentence:
      "Too few comparable awards were retrieved to place this price against the local market. " +
      "It stands on the takeoff and the rate catalog alone.",
  },
};

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

function materialPricingLabel(mp: EstimateSnapshot["materialPricing"]): string {
  if (!mp || mp.source === "catalog_default") return "Uncalibrated catalog defaults";
  const factor =
    mp.retailFactor === 1 || mp.retailFactor === null
      ? "full shelf price"
      : `${((mp.retailFactor ?? 1) * 100).toFixed(0)}% of shelf`;
  return `Home Depot retail, ZIP ${mp.zip}, ${(mp.fetchedAt ?? "").slice(0, 10)} — ${factor}`;
}

function describeOverrides(o: Overrides): string {
  const n = (r: Record<string, unknown> | undefined) => Object.keys(r ?? {}).length;
  const parts: string[] = [];
  if (n(o.quantities)) parts.push(`${n(o.quantities)} quantity`);
  if (n(o.materialUnitCosts)) parts.push(`${n(o.materialUnitCosts)} material rate`);
  if (n(o.wageRates)) parts.push(`${n(o.wageRates)} wage rate`);
  if (n(o.markups)) parts.push(`${n(o.markups)} markup`);
  return parts.length === 0 ? "None" : `${parts.join(", ")} overridden`;
}

const dateLong = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/** Quotations expire; this one states when. */
function validUntil(iso: string, days = 30): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return dateLong(d.toISOString());
}

export function Report({
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
}) {
  const { snapshot, wages } = payload;
  const scope = snapshot.scope;
  const assumptions = snapshot.assumptionsSnapshot as AssumptionSet;
  const markups: MarkupSchedule = { ...assumptions.markups, ...(overrides.markups ?? {}) };

  const recommended = bands.bands.find((b) => b.id === "recommended") ?? bands.bands[0];
  const low = bands.bands[0];
  const high = bands.bands[bands.bands.length - 1];
  const verdict = VERDICT[estimate.crossCheck.verdict];

  const locationLabel = scope.state
    ? `${scope.county ? `${scope.county} County, ` : ""}${scope.state}`
    : "an unresolved location";

  const quoteNo = `Q-${snapshot.id.slice(0, 8).toUpperCase()}`;
  const allWarnings = [...payload.pipelineWarnings, ...estimate.warnings];
  const openItems = [...scope.missing_information, ...scope.clarification_questions];

  return (
    <article className="sheet" id="report">
      {/* ── Letterhead ──────────────────────────────────────────────────── */}
      <header className="rep-letterhead">
        <div className="rep-lh-left">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              M
            </span>
            <span>
              Mayorga Estimate Studio
              <span className="brand-sub"> · we estimate better</span>
            </span>
          </div>
          <h1 className="rep-doc-title">Preliminary Bid Proposal</h1>
          <p className="rep-doc-kind">
            Conceptual estimate · AACE Class 4–5 · ±20–30%
            {isAdjusted ? " · manually adjusted" : ""}
          </p>
        </div>

        <dl className="rep-lh-meta">
          <div>
            <dt>Quotation</dt>
            <dd className="tnum">{quoteNo}</dd>
          </div>
          <div>
            <dt>Issued</dt>
            <dd>{dateLong(snapshot.createdAt)}</dd>
          </div>
          <div>
            <dt>Valid until</dt>
            <dd>{validUntil(snapshot.createdAt)}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd className="tnum">{isAdjusted ? "A — adjusted" : "0"}</dd>
          </div>
        </dl>
      </header>

      <div className="rep-parties">
        <div>
          <span className="eyebrow">Prepared for</span>
          <p className="rep-party-name">{letterhead.preparedFor || "—"}</p>
        </div>
        <div>
          <span className="eyebrow">Prepared by</span>
          <p className="rep-party-name">{letterhead.preparedBy || "—"}</p>
          {letterhead.contact && <p className="rep-party-sub">{letterhead.contact}</p>}
        </div>
        <div>
          <span className="eyebrow">Project</span>
          <p className="rep-party-name">{scope.project_title}</p>
          <p className="rep-party-sub">
            {locationLabel} · NAICS {scope.naics_code}
            {scope.psc_code ? ` · PSC ${scope.psc_code}` : ""}
            {scope.gross_square_feet
              ? ` · ${scope.gross_square_feet.toLocaleString()} SF`
              : ""}
          </p>
        </div>
      </div>

      {!scope.state && (
        <div className="notice" style={{ marginTop: 22 }}>
          <strong>No state was identified.</strong> Labor was priced without a localized wage
          determination and no comparable awards could be retrieved, so nothing here is
          bid-ready. Set the state and re-run.
        </div>
      )}

      {/* ── 01 · The price ──────────────────────────────────────────────── */}
      <Section n="01" title="Quoted price">
        <Reveal>
          <div className="hero">
            <div className="hero-main">
              <span className="eyebrow">
                {isAdjusted ? "Adjusted bid price" : "Recommended bid price"}
              </span>
              <div className="hero-figure">
                <CountMoney cents={recommended.bidPrice} duration={1400} />
              </div>
              <p className="hero-sub">
                {composition.perSquareFoot !== null && (
                  <>
                    <strong>{money(composition.perSquareFoot)}</strong> / SF
                  </>
                )}
                {composition.perSquareFoot !== null && composition.perMonth !== null && " · "}
                {composition.perMonth !== null && (
                  <>
                    <strong>{money(composition.perMonth)}</strong> / month ×{" "}
                    {scope.duration_months}
                  </>
                )}
                {composition.perSquareFoot === null && composition.perMonth === null && (
                  <>Lump sum — the solicitation stated neither area nor duration.</>
                )}
              </p>
              <div className="hero-chips">
                <StatusChip tone={verdict.tone}>{verdict.label}</StatusChip>
                <StatusChip tone={scope.bonding_required ? "good" : "warning"}>
                  {scope.bonding_required ? "Bond included" : "No bond premium"}
                </StatusChip>
                {composition.unpricedCount > 0 && (
                  <StatusChip tone="critical">
                    {composition.unpricedCount} unpriced
                  </StatusChip>
                )}
              </div>
            </div>

            <div className="hero-band">
              <span className="eyebrow">Acceptable range</span>
              {bands.bands.map((b, i) => (
                <div key={b.id} className={`band-row${b.id === "recommended" ? " is-rec" : ""}`}>
                  <span className="band-swatch" data-i={i} aria-hidden="true" />
                  <span className="band-name">{b.label}</span>
                  <span className="band-amt tnum">{money(b.bidPrice)}</span>
                  <span className="band-delta tnum">
                    {b.id === "recommended" ? "—" : signedMoney(b.deltaVsRecommended)}
                  </span>
                </div>
              ))}
              <p className="band-note">
                {money(bands.spread)} between floor and ceiling. The cost is identical in all
                three — only fee and contingency move.
              </p>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ── 02 · Market position ────────────────────────────────────────── */}
      <Section n="02" title="Bid band and market position" intro={verdict.sentence} breakBefore>
        <Reveal>
          <BandVsMarketChart bands={bands.bands} market={bands.market} />
        </Reveal>
        <Reveal i={1}>
          <MarketPositionChart
            bands={bands.bands}
            market={bands.market}
            locationLabel={locationLabel}
          />
        </Reveal>

        <div className="posture-strip">
          {bands.bands.map((b, i) => (
            <div key={b.id} className={`posture${b.id === "recommended" ? " is-rec" : ""}`}>
              <div className="posture-head">
                <span className="band-swatch" data-i={i} aria-hidden="true" />
                <span className="posture-name">{b.label}</span>
              </div>
              <div className="posture-price tnum">{money(b.bidPrice)}</div>
              <div className="posture-rates tnum">
                fee {pct(b.feePct, 1)} · cont {pct(b.contingencyPct, 1)}
                {b.ratioVsMarket !== null && <> · {signedPct(b.ratioVsMarket - 1, 0)} vs median</>}
              </div>
              <p className="posture-why">{b.rationale}</p>
            </div>
          ))}
        </div>

        {payload.comparablesCaveat && (
          <p className="figure-note" style={{ marginTop: 12 }}>
            {payload.comparablesCaveat}
          </p>
        )}
      </Section>

      {/* ── 03 · Cost and price structure ───────────────────────────────── */}
      <Section
        n="03"
        title="Cost and price structure"
        intro="What the price is made of, and where the underlying cost sits."
        breakBefore
      >
        <Reveal>
          <StackedShareBar
            title="Composition of the quoted price"
            subtitle="Four groups that sum exactly to the bid price."
            slices={composition.buildUp}
            total={composition.bidPrice}
            totalLabel="Bid price"
          />
        </Reveal>
        <Reveal i={1}>
          <DivisionBars slices={composition.byDivision} total={composition.directCost} />
        </Reveal>
        <Reveal i={2}>
          <StackedShareBar
            title="Direct cost by type"
            subtitle="What the direct cost is spent on, before any markup."
            slices={composition.byCostType}
            total={composition.directCost}
            totalLabel="Total direct cost"
          />
        </Reveal>

        <Collapse summary="Full markup waterfall">
          <div className="table-scroll">
            <table className="data-table">
              <tbody>
                {waterfallRows(estimate.totals, markups, scope.bonding_required).map((r) => {
                  const isTotal = r.label === "Bid price";
                  return (
                    <tr
                      key={r.label}
                      className={isTotal ? "wf-total" : r.isSubtotal ? "wf-sub" : "wf-row"}
                    >
                      <td>{r.label}</td>
                      <td className="wf-rate">{r.rate ?? ""}</td>
                      <td className="num">{money(r.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Collapse>
      </Section>

      {/* ── 04 · Scope schedule ─────────────────────────────────────────── */}
      <Section
        n="04"
        title="Schedule of work"
        intro="Quantities as extracted, priced against the rate catalog. A line the engine could not match to a rate is shown unpriced rather than approximated."
        breakBefore
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Div</th>
                <th>Work item</th>
                <th className="num">Quantity</th>
                <th className="num">Hrs</th>
                <th className="num">Labor</th>
                <th className="num">Material</th>
                <th className="num">Direct cost</th>
              </tr>
            </thead>
            <tbody>
              {estimate.lines.map((l, i) => {
                const hours = l.labor.reduce((a, x) => a + x.hours, 0);
                return (
                  <tr key={`${l.item.assumption_key}-${i}`}>
                    <td className="tnum" style={{ color: "var(--ink-3)" }}>
                      {l.item.csi_division}
                    </td>
                    <td>
                      {l.item.description}
                      {l.basis === "unpriced" && <span className="tag tag-warn">unpriced</span>}
                      {l.item.confidence !== "stated" && (
                        <span className="tag">qty {l.item.confidence}</span>
                      )}
                      {l.item.match_confidence === "close" && (
                        <span className="tag">close match</span>
                      )}
                    </td>
                    <td className="num">
                      {l.item.quantity.toLocaleString()} {l.item.unit}
                    </td>
                    <td className="num">{hours ? hours.toFixed(0) : "—"}</td>
                    <td className="num">{money(l.laborCost)}</td>
                    <td className="num">{money(l.materialCost)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {money(l.directCost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total direct cost</td>
                <td className="num">{composition.laborHours.toFixed(0)}</td>
                <td colSpan={2} />
                <td className="num">{money(estimate.totals.directCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>

      {/* ── 05 · Basis of estimate ──────────────────────────────────────── */}
      <Section n="05" title="Basis of estimate" breakBefore>
        <dl className="fact-grid">
          <Fact label="Delivery method" value={titleCase(scope.delivery_method)} />
          <Fact
            label="Duration"
            value={scope.duration_months ? `${scope.duration_months} months` : "Not stated"}
          />
          <Fact
            label="Place of performance"
            value={locationLabel}
            tone={scope.state ? undefined : "warn"}
          />
          <Fact
            label="Davis-Bacon"
            value={scope.davis_bacon_applies ? "Applies" : "Does not apply"}
          />
          <Fact
            label="Wage determination"
            value={wages.determinationId || "Not loaded"}
            tone={wages.determinationId ? undefined : "warn"}
          />
          <Fact label="Material pricing" value={materialPricingLabel(snapshot.materialPricing)} />
          <Fact
            label="Comparable awards"
            value={`${bands.market.count}${
              bands.market.p50 !== null ? ` · median ${money(bands.market.p50)}` : ""
            }`}
          />
          <Fact label="Crew hours" value={composition.laborHours.toFixed(0)} />
          <Fact
            label="Assumption set"
            value={`v${assumptions.version} · ${assumptions.calibratedKeys.length}/${assumptions.productivity.length} calibrated`}
          />
          <Fact label="Manual adjustments" value={describeOverrides(overrides)} />
          <Fact label="Source" value={payload.sourceLabel} />
          <Fact label="Report ID" value={`${quoteNo} · engine ${snapshot.engineVersion}`} />
        </dl>

        <Collapse summary="Markup schedule">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Markup</th>
                  <th className="num">Applied</th>
                  <th className="num">Catalog default</th>
                </tr>
              </thead>
              <tbody>
                {MARKUP_ORDER.map(([key, label]) => (
                  <tr key={key}>
                    <td>
                      {label}
                      {markups[key] !== assumptions.markups[key] && (
                        <span className="tag">overridden</span>
                      )}
                    </td>
                    <td className="num">{pct(markups[key], 2)}</td>
                    <td className="num" style={{ color: "var(--ink-3)" }}>
                      {pct(assumptions.markups[key], 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapse>
      </Section>

      {/* ── 06 · Qualifications and open items ──────────────────────────── */}
      {(allWarnings.length > 0 || openItems.length > 0) && (
        <Section
          n="06"
          title="Qualifications and open items"
          intro="This proposal is offered subject to the following. Each is a limit on what the price covers, or a question whose answer could move it."
          breakBefore
        >
          {allWarnings.length > 0 && (
            <Collapse summary="Qualifications and exclusions" count={allWarnings.length}>
              <ol className="numbered">
                {allWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ol>
            </Collapse>
          )}

          {scope.missing_information.length > 0 && (
            <Collapse
              summary="Information missing from the solicitation"
              count={scope.missing_information.length}
            >
              <ol className="numbered">
                {scope.missing_information.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ol>
            </Collapse>
          )}

          {scope.clarification_questions.length > 0 && (
            <Collapse
              summary="Questions for the contracting officer"
              count={scope.clarification_questions.length}
              open
            >
              <ol className="numbered">
                {scope.clarification_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </Collapse>
          )}
        </Section>
      )}

      {/* ── 07 · Notes ──────────────────────────────────────────────────── */}
      {explanation && (
        <Section n="07" title="Estimator's notes" breakBefore>
          {isAdjusted && (
            <p className="figure-note" style={{ marginBottom: 12 }}>
              These notes describe the estimate as generated. Rates or quantities have been
              adjusted since; the tables above carry the current figures.
            </p>
          )}
          <div className="prose" style={{ whiteSpace: "pre-wrap" }}>
            {explanation}
          </div>
        </Section>
      )}

      {/* ── 08 · Acceptance ─────────────────────────────────────────────── */}
      <Section n="08" title="Acceptance">
        <p className="prose">
          Offered at <strong>{money(recommended.bidPrice)}</strong>, valid until{" "}
          {validUntil(snapshot.createdAt)}, subject to the qualifications above and to a site
          visit. The commercial range runs {money(low.bidPrice)} to {money(high.bidPrice)}; a
          price outside it is a different scope, not a different negotiation.
        </p>
        <div className="sign-grid">
          <div className="sign-box">
            <span className="eyebrow">Accepted for the client</span>
            <div className="sign-line" />
            <div className="sign-cap">Signature · printed name · title · date</div>
          </div>
          <div className="sign-box">
            <span className="eyebrow">For the contractor</span>
            <div className="sign-line" />
            <div className="sign-cap">
              {letterhead.preparedBy || "Authorized representative"} · date
            </div>
          </div>
        </div>
      </Section>

      <footer className="disclaimer">
        <strong>A conceptual estimate for budgeting and bid strategy, not a bid guarantee</strong>{" "}
        — expected accuracy ±20–30% (AACE Class 4–5). Verify quantities, unit prices and
        assumptions, and have key items reviewed by a registered estimator, before submitting.
        Every amount here was produced by the deterministic pricing engine
        {isAdjusted ? ", including the adjusted figures" : ""}; the narrative describes those
        numbers and does not alter them. Comparable awards come from USAspending and are awarded
        contract values, which include the winner's fee and risk premium — they are not costs.
      </footer>

      <div className="print-footer">
        <span>
          <strong>Mayorga Estimate Studio</strong> · {scope.project_title}
        </span>
        <span>
          {quoteNo} · engine {snapshot.engineVersion}
          {isAdjusted ? " · adjusted" : ""} · ROM ±20–30%, not a bid guarantee
        </span>
      </div>
    </article>
  );
}
