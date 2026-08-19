"use client";

import { useState } from "react";
import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { formatUSD } from "@/lib/money";
import { waterfallRows } from "@/lib/price";
import type { EstimateSnapshot } from "@/lib/schema";

/**
 * Minimal usable UI.
 *
 * Note that this file does **no money math** — every number is computed on the
 * server and sent over; here we only handle formatUSD display and layout. The
 * client takes no part in pricing, and that's deliberate: browser code can be
 * tampered with, so dollar amounts must never be produced there.
 */

interface EstimatePayload {
  snapshot: EstimateSnapshot;
  comparablesCaveat: string | null;
  pipelineWarnings: string[];
}

export default function Page() {
  const [rfpText, setRfpText] = useState("");
  const [payload, setPayload] = useState<EstimatePayload | null>(null);
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setPayload(null);
    setExplanation("");

    try {
      const res = await fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfpText }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      if (!res.body) throw new Error("Response had no body");

      // Read NDJSON line by line. Note that chunk boundaries don't necessarily
      // fall on newlines, so keep a buffer to stitch incomplete lines together.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // last segment may be incomplete; hold it for the next round

        for (const raw of lines) {
          if (!raw.trim()) continue;
          const msg = JSON.parse(raw);
          if (msg.type === "estimate") {
            setPayload(msg as EstimatePayload);
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

  const est = payload?.snapshot.estimate;
  const scope = payload?.snapshot.scope;
  const allWarnings = [...(payload?.pipelineWarnings ?? []), ...(est?.warnings ?? [])];

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Gov Bid Estimator</h1>
      <p style={{ color: "#666", fontSize: 14, marginTop: 0 }}>
        ROM / conceptual estimate — expected accuracy ±20–30%. Not a directly submittable bid price.
      </p>

      <textarea
        value={rfpText}
        onChange={(e) => setRfpText(e.target.value)}
        placeholder="Paste the Scope of Work section of the solicitation…"
        rows={14}
        style={{
          width: "100%",
          padding: 12,
          fontFamily: "ui-monospace, monospace",
          fontSize: 13,
          border: "1px solid #ccc",
          borderRadius: 6,
        }}
      />

      <button
        onClick={submit}
        disabled={busy || rfpText.trim().length < 50}
        style={{
          marginTop: 12,
          padding: "10px 20px",
          fontSize: 15,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Estimating…" : "Generate estimate"}
      </button>

      {error && (
        <div style={{ marginTop: 16, padding: 12, background: "#fee", borderRadius: 6 }}>
          <strong>Something went wrong:</strong> {error}
        </div>
      )}

      {est && scope && (
        <>
          <section style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 18 }}>{scope.project_title}</h2>
            <p style={{ color: "#666", fontSize: 14 }}>
              {scope.county ? `${scope.county} County, ` : ""}
              {scope.state} · NAICS {scope.naics_code}
              {scope.gross_square_feet
                ? ` · ${scope.gross_square_feet.toLocaleString()} SF`
                : ""}
            </p>
            <div style={{ fontSize: 32, fontWeight: 600, marginTop: 8 }}>
              {formatUSD(est.totals.bidPrice)}
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 15 }}>Markup waterfall</h3>
            <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
              <tbody>
                {waterfallRows(est.totals, STARTING_DEFAULTS.markups).map((r, i) => (
                  <tr
                    key={i}
                    style={{
                      fontWeight: r.isSubtotal ? 600 : 400,
                      borderTop: r.isSubtotal ? "1px solid #ddd" : "none",
                    }}
                  >
                    <td style={{ padding: "4px 0" }}>{r.label}</td>
                    <td style={{ color: "#888", textAlign: "right", paddingRight: 16 }}>
                      {r.rate ?? ""}
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatUSD(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {allWarnings.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <h3 style={{ fontSize: 15 }}>Warnings ({allWarnings.length})</h3>
              <ul style={{ fontSize: 14, lineHeight: 1.6, paddingLeft: 20 }}>
                {allWarnings.map((w, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    {w}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {explanation && (
        <section style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 15 }}>Estimate notes</h3>
          <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {explanation}
          </div>
        </section>
      )}

      {est && (
        <footer
          style={{
            marginTop: 40,
            paddingTop: 16,
            borderTop: "1px solid #eee",
            fontSize: 12,
            color: "#888",
          }}
        >
          This estimate is for reference only and is not a bid guarantee. The user must
          independently verify all quantities, unit prices, and assumptions. Have key items
          reviewed by a registered estimator.
          <br />
          Engine version {payload.snapshot.engineVersion} · Snapshot {payload.snapshot.id} ·
          Wage determination {payload.snapshot.wageDeterminationId || "not loaded"}
        </footer>
      )}
    </main>
  );
}
