"use client";

import { useState } from "react";
import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { formatUSD } from "@/lib/money";
import { waterfallRows } from "@/lib/price";
import type { EstimateSnapshot } from "@/lib/schema";

/**
 * 最小可用界面。
 *
 * 注意这个文件里**没有任何金额计算** —— 所有数字都是服务器算好传过来的,
 * 这里只负责 formatUSD 显示和排版。客户端不参与定价,这是刻意的:
 * 浏览器里的代码是可以被改的,金额不能在那里产生。
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
        throw new Error(body.error ?? `请求失败 (${res.status})`);
      }
      if (!res.body) throw new Error("响应没有内容");

      // 逐行读 NDJSON。注意 chunk 边界不一定落在换行处,
      // 所以要留 buffer 拼接不完整的行。
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // 最后一段可能不完整,留到下一轮

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
        ROM / conceptual estimate — 预期精度 ±20~30%。不是可直接提交的投标价。
      </p>

      <textarea
        value={rfpText}
        onChange={(e) => setRfpText(e.target.value)}
        placeholder="粘贴招标文件的工作范围 (Scope of Work) 章节…"
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
        {busy ? "估算中…" : "生成估算"}
      </button>

      {error && (
        <div style={{ marginTop: 16, padding: 12, background: "#fee", borderRadius: 6 }}>
          <strong>出错了:</strong> {error}
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
            <h3 style={{ fontSize: 15 }}>加成瀑布</h3>
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
              <h3 style={{ fontSize: 15 }}>警告({allWarnings.length})</h3>
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
          <h3 style={{ fontSize: 15 }}>估算说明</h3>
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
          本估算仅供参考,不构成投标保证。使用者须自行核实全部工程量、单价与假设。
          关键项目请由注册估算师复核。
          <br />
          引擎版本 {payload.snapshot.engineVersion} · 快照 {payload.snapshot.id} ·
          工资裁定 {payload.snapshot.wageDeterminationId || "未加载"}
        </footer>
      )}
    </main>
  );
}
