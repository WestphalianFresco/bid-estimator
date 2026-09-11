"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssumptionSet } from "@/lib/assumptions";
import type { BidBandSet } from "@/lib/bands";
import type { CompositionSummary } from "@/lib/rollups";
import type { Overrides } from "@/lib/reprice";
import type { PricedEstimate } from "@/lib/schema";
import { AdjustPanel } from "./_components/AdjustPanel";
import { Intake, Progress } from "./_components/Intake";
import { Report } from "./_components/Report";
import { SignIn } from "./_components/SignIn";
import { buildMarkdown } from "./_components/export";
import type { EstimatePayload, Letterhead, RepriceResponse } from "./_components/types";
import { money, signedMoney } from "./_components/ui";

/**
 * The estimator's workspace.
 *
 * This file owns state and the two network calls, and nothing else. It does no
 * money math: every dollar figure it renders arrived from `/api/estimate` or
 * `/api/reprice`, because browser code can be tampered with and amounts must
 * never be produced there. The single exception is the delta badge in the
 * command bar, which subtracts two engine-produced figures purely as a screen
 * indicator and never reaches the printed document.
 */

const REPRICE_DEBOUNCE_MS = 350;

/** What the report is currently showing: the baseline, or a re-priced variant. */
interface Adjusted {
  estimate: PricedEstimate;
  bands: BidBandSet;
  composition: CompositionSummary;
}

export default function Page() {
  const [rfpText, setRfpText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // Maryland by default — change it when the operating region changes.
  const [stateCode, setStateCode] = useState("MD");
  const [county, setCounty] = useState("");
  const [letterhead, setLetterhead] = useState<Letterhead>({
    preparedFor: "",
    preparedBy: "",
    contact: "",
  });

  const [payload, setPayload] = useState<EstimatePayload | null>(null);
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"extracting" | "pricing" | "writing">("extracting");
  const [error, setError] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(true);

  const [overrides, setOverrides] = useState<Overrides>({});
  const [adjusted, setAdjusted] = useState<Adjusted | null>(null);
  const [repricing, setRepricing] = useState(false);
  const [repriceError, setRepriceError] = useState<string | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);
  const repriceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function submit() {
    setBusy(true);
    setStage("extracting");
    setError(null);
    setPayload(null);
    setExplanation("");
    setOverrides({});
    setAdjusted(null);
    setShowAdjust(false);
    setRepriceError(null);

    try {
      // A file wins over the textarea when both are present, so the user never
      // has to clear one to use the other.
      const req: RequestInit = file
        ? {
            method: "POST",
            body: (() => {
              const f = new FormData();
              f.append("file", file);
              if (stateCode) f.append("state", stateCode);
              if (county) f.append("county", county);
              return f;
            })(),
          }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rfpText, state: stateCode, county }),
          };

      const res = await fetch("/api/estimate", req);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      if (!res.body) throw new Error("The response had no body");

      // NDJSON, read line by line. Chunk boundaries do not fall on newlines, so
      // an incomplete tail is held over for the next read.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          if (!raw.trim()) continue;
          const msg = JSON.parse(raw);
          if (msg.type === "estimate") {
            setPayload(msg as EstimatePayload);
            setIntakeOpen(false);
            setStage("writing");
          } else if (msg.type === "text") {
            setExplanation((prev) => prev + msg.delta);
          } else if (msg.type === "error") {
            setError(msg.message);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sends the edited inputs to the engine and renders what comes back.
   *
   * Debounced so dragging a slider does not fire a request per frame. The call
   * is a pure function server-side — no model, no network, no clock — so it is
   * fast and free to make on every change.
   */
  const reprice = useCallback(
    (next: Overrides) => {
      if (!payload) return;
      if (repriceTimer.current) clearTimeout(repriceTimer.current);

      repriceTimer.current = setTimeout(async () => {
        setRepricing(true);
        setRepriceError(null);
        try {
          const res = await fetch("/api/reprice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scope: payload.snapshot.scope,
              assumptions: payload.snapshot.assumptionsSnapshot,
              wages: payload.wages,
              comparables: payload.comparables,
              overrides: next,
            }),
          });
          const body = await res.json();
          if (!res.ok) {
            throw new Error([body.error, ...(body.detail ?? [])].filter(Boolean).join(" — "));
          }
          const r = body as RepriceResponse;
          setAdjusted(
            r.unchanged
              ? null
              : { estimate: r.estimate, bands: r.bands, composition: r.composition },
          );
        } catch (e) {
          setRepriceError(e instanceof Error ? e.message : String(e));
        } finally {
          setRepricing(false);
        }
      }, REPRICE_DEBOUNCE_MS);
    },
    [payload],
  );

  useEffect(
    () => () => {
      if (repriceTimer.current) clearTimeout(repriceTimer.current);
    },
    [],
  );

  function update(next: Overrides) {
    setOverrides(next);
    reprice(next);
  }

  function resetAdjustments() {
    if (repriceTimer.current) clearTimeout(repriceTimer.current);
    setOverrides({});
    setAdjusted(null);
    setRepriceError(null);
  }

  const baseline = payload?.snapshot.estimate ?? null;
  const estimate = adjusted?.estimate ?? baseline;
  const bands = adjusted?.bands ?? payload?.bands ?? null;
  const composition = adjusted?.composition ?? payload?.composition ?? null;
  const isAdjusted = adjusted !== null;

  // Display-only indicator: the difference of two engine-produced figures. It
  // is never written into the report.
  const delta =
    estimate && baseline ? estimate.totals.bidPrice - baseline.totals.bidPrice : 0;

  function downloadMarkdown() {
    if (!payload || !estimate || !bands || !composition) return;
    const md = buildMarkdown({
      payload,
      estimate,
      bands,
      composition,
      explanation,
      isAdjusted,
      overrides,
      letterhead,
    });
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bid-${payload.snapshot.id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const ready = payload && estimate && bands && composition;

  return (
    <main className="shell">
      <header className="topbar no-print">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>
            Tidiverse Studio
            <span className="brand-sub"> · we estimate better</span>
          </span>
        </div>
        <div className="topbar-actions">
          {ready && (
            <>
              <button type="button" className="ghost-btn" onClick={downloadMarkdown}>
                Markdown
              </button>
              <button type="button" className="btn" onClick={() => window.print()}>
                Print / PDF
              </button>
            </>
          )}
          <SignIn />
        </div>
      </header>

      {!payload && !busy && (
        <section className="hero-intro no-print">
          <h1 className="hero-title">
            Submit your scope.
            <br />
            We take care of the rest.
          </h1>
        </section>
      )}

      <Intake
        rfpText={rfpText}
        onText={setRfpText}
        file={file}
        onFile={setFile}
        stateCode={stateCode}
        onState={setStateCode}
        county={county}
        onCounty={setCounty}
        letterhead={letterhead}
        onLetterhead={setLetterhead}
        busy={busy}
        onSubmit={submit}
        collapsed={!intakeOpen}
        onExpand={() => setIntakeOpen(true)}
      />

      {busy && <Progress stage={stage} />}

      {error && (
        <div className="notice no-print" style={{ marginTop: 20 }}>
          <strong>The estimate failed.</strong> {error}
        </div>
      )}

      {ready && (
        <>
          <div className="command-bar no-print">
            <div>
              <span className="eyebrow">
                {isAdjusted ? "Adjusted bid price" : "Recommended bid price"}
                {repricing && <span className="pulse-tag"> recalculating…</span>}
              </span>
              <div className="command-price">
                {money(estimate!.totals.bidPrice)}
                {isAdjusted && delta !== 0 && (
                  <span className={`command-delta ${delta > 0 ? "is-up" : "is-down"}`}>
                    {signedMoney(delta)}
                  </span>
                )}
              </div>
              <div className="command-band">
                Range {money(bands!.bands[0].bidPrice)} –{" "}
                {money(bands!.bands[bands!.bands.length - 1].bidPrice)}
              </div>
            </div>
            <div className="topbar-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setShowAdjust((v) => !v)}
                aria-expanded={showAdjust}
              >
                {showAdjust ? "Hide adjustments" : "Adjust prices"}
              </button>
              {isAdjusted && (
                <button type="button" className="link-btn" onClick={resetAdjustments}>
                  reset
                </button>
              )}
            </div>
          </div>

          {repriceError && (
            <div className="notice no-print" style={{ marginTop: 14 }}>
              <strong>Could not re-price.</strong> {repriceError}
            </div>
          )}

          {showAdjust && (
            <AdjustPanel
              scope={payload!.snapshot.scope}
              assumptions={payload!.snapshot.assumptionsSnapshot as AssumptionSet}
              wages={payload!.wages}
              estimate={estimate!}
              overrides={overrides}
              onChange={update}
              onReset={resetAdjustments}
              isAdjusted={isAdjusted}
              repricing={repricing}
            />
          )}

          <Report
            payload={payload!}
            estimate={estimate!}
            bands={bands!}
            composition={composition!}
            explanation={explanation}
            isAdjusted={isAdjusted}
            overrides={overrides}
            letterhead={letterhead}
          />
        </>
      )}
    </main>
  );
}
