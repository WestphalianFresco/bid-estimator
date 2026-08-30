"use client";

import { useRef, useState } from "react";
import { US_STATES } from "@/lib/schema";
import type { Letterhead } from "./types";

/**
 * The intake console.
 *
 * Two ways in — paste the scope of work, or drop the project documents — and
 * one field that cannot be inferred from either: where the work is. Location is
 * asked for up front and kept prominent because it selects the wage rates, the
 * sales tax and the local labor rules, and because project documents routinely
 * name a county and no state, which no amount of extraction can recover.
 *
 * The copy on this screen stays deliberately plain. It is the first thing a
 * visitor sees, and the jargon of one procurement world narrows what the tool
 * looks like it is for; the report, which is read by people who already know
 * the terms, uses them precisely.
 *
 * The letterhead fields never leave the browser. They address the quotation;
 * they are not inputs to the estimate, and the price must not move because
 * someone typed a different client name.
 */

const ACCEPT = ".pdf,.docx,.txt,.md";

export function Intake({
  rfpText,
  onText,
  file,
  onFile,
  stateCode,
  onState,
  county,
  onCounty,
  letterhead,
  onLetterhead,
  busy,
  onSubmit,
  collapsed,
  onExpand,
}: {
  rfpText: string;
  onText: (v: string) => void;
  file: File | null;
  onFile: (f: File | null) => void;
  stateCode: string;
  onState: (v: string) => void;
  county: string;
  onCounty: (v: string) => void;
  letterhead: Letterhead;
  onLetterhead: (l: Letterhead) => void;
  busy: boolean;
  onSubmit: () => void;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [showLetterhead, setShowLetterhead] = useState(false);

  const canSubmit = file !== null || rfpText.trim().length >= 50;

  if (collapsed) {
    return (
      <div className="no-print intake-collapsed">
        <span className="eyebrow">Estimate complete</span>
        <button type="button" className="btn" onClick={onExpand}>
          New estimate
        </button>
      </div>
    );
  }

  return (
    <section className="no-print intake">
      <div className="intake-grid">
        {/* ── Source ────────────────────────────────────────────────── */}
        <div className="intake-main">
          <span className="eyebrow">Step 01 · Project scope</span>
          <textarea
            className="textarea"
            value={rfpText}
            onChange={(e) => onText(e.target.value)}
            disabled={busy}
            placeholder={
              "Paste the scope of work, or just describe the project.\n\n" +
              "Example: Replace the roof on Building 214, an 18,500 SF vehicle maintenance " +
              "facility. Tear off the existing membrane, install new insulation board and " +
              "60-mil TPO, and replace perimeter edge metal. Prevailing wage applies; performance " +
              "and payment bonds required."
            }
          />

          <div
            className={`dropzone${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (busy) return;
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) onFile(dropped);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              style={{ display: "none" }}
            />
            {file ? (
              <>
                <span className="dz-icon" aria-hidden="true">
                  ▣
                </span>
                <div>
                  <div className="dz-title">{file.name}</div>
                  <div className="dz-sub">
                    {(file.size / 1024).toFixed(0)} KB · takes priority over the text above
                  </div>
                </div>
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => {
                    onFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                >
                  remove
                </button>
              </>
            ) : (
              <>
                <span className="dz-icon" aria-hidden="true">
                  ⤓
                </span>
                <div>
                  <div className="dz-title">Drop the project documents here</div>
                  <div className="dz-sub">PDF, DOCX, TXT or MD — up to 20 MB</div>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  Browse
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Parameters ────────────────────────────────────────────── */}
        <aside className="intake-side">
          <span className="eyebrow">Step 02 · Essential information</span>

          <label className="field-label">
            State
            <select
              className="select"
              value={stateCode}
              onChange={(e) => onState(e.target.value)}
              disabled={busy}
            >
              <option value="">— read from the document —</option>
              {US_STATES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label" style={{ marginTop: 14 }}>
            County or independent city
            <input
              className="input"
              value={county}
              onChange={(e) => onCounty(e.target.value)}
              placeholder="e.g. Jefferson"
              disabled={busy}
            />
          </label>

          <button
            type="button"
            className="link-btn"
            style={{ marginTop: 18, alignSelf: "flex-start" }}
            onClick={() => setShowLetterhead((v) => !v)}
          >
            {showLetterhead ? "Hide" : "Add"} quotation letterhead
          </button>

          {showLetterhead && (
            <div className="letterhead-fields">
              <label className="field-label">
                Prepared for
                <input
                  className="input"
                  value={letterhead.preparedFor}
                  onChange={(e) =>
                    onLetterhead({ ...letterhead, preparedFor: e.target.value })
                  }
                  placeholder="Client or agency"
                  disabled={busy}
                />
              </label>
              <label className="field-label">
                Prepared by
                <input
                  className="input"
                  value={letterhead.preparedBy}
                  onChange={(e) => onLetterhead({ ...letterhead, preparedBy: e.target.value })}
                  placeholder="Your company"
                  disabled={busy}
                />
              </label>
              <label className="field-label">
                Contact line
                <input
                  className="input"
                  value={letterhead.contact}
                  onChange={(e) => onLetterhead({ ...letterhead, contact: e.target.value })}
                  placeholder="Address · phone · CAGE code"
                  disabled={busy}
                />
              </label>
              <p className="intake-hint">
                Letterhead only. These fields stay in your browser and take no part in pricing.
              </p>
            </div>
          )}
        </aside>
      </div>

      <div className="intake-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSubmit}
          disabled={busy || !canSubmit}
        >
          {busy ? "Estimating…" : "Generate estimate"}
        </button>
        {/*
          The hint is always present, not only when the button is disabled.
          The minimum length is a floor, not a target, and an estimate built
          from fifty characters is mostly assumption — saying so here is far
          cheaper than saying it in the qualifications section afterwards.
        */}
        <span className="intake-hint">
          <strong>The more detail, the tighter the range.</strong> Quantities, materials, site
          conditions, access and schedule each remove an assumption the estimate would otherwise
          have to make.
          {!canSubmit && !busy && (
            <> To start, write at least 50 characters or attach a file.</>
          )}
        </span>
      </div>
    </section>
  );
}

/**
 * Progress readout.
 *
 * The pipeline is three layers and can take the better part of a minute; a bare
 * spinner would leave the estimator wondering whether it had hung. This names
 * the layer actually running, driven by what has arrived over the stream rather
 * than by a timer.
 */
export function Progress({ stage }: { stage: "extracting" | "pricing" | "writing" }) {
  const steps = [
    { id: "extracting", label: "Reading the documents", sub: "Extracting scope, quantities and location" },
    { id: "pricing", label: "Pricing", sub: "Labor rates, material costs, markups, comparable projects" },
    { id: "writing", label: "Writing the report", sub: "Explaining the numbers the engine produced" },
  ] as const;

  const currentIndex = steps.findIndex((s) => s.id === stage);

  return (
    <div className="no-print progress card">
      {steps.map((s, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "idle";
        return (
          <div key={s.id} className={`prog-step is-${state}`}>
            <span className="prog-dot" aria-hidden="true" />
            <div>
              <div className="prog-label">{s.label}</div>
              <div className="prog-sub">{s.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
