import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { streamExplanation } from "@/lib/explain";
import { runEstimate } from "@/lib/pipeline";

/**
 * Estimate endpoint.
 *
 * ⚠️ This is **server-side** code. The API key is read from process.env and
 *    never reaches the browser. Do not move this logic into a client component.
 *
 * The response format is NDJSON (one JSON per line); a single round trip sends
 * the numbers first, then the text:
 *
 *   {"type":"estimate", ...}     ← first line: the full deterministic estimate
 *   {"type":"text","delta":"…"}  ← after: the Layer 3 explanation, streamed in chunks
 *   {"type":"done"}
 *
 * Why not split this into two endpoints: if the numbers were returned to the
 * browser first and then sent back for an explanation, the client would have a
 * chance to tamper with the amounts. Doing it in one round trip keeps the
 * amounts under server control the whole time.
 */

export const runtime = "nodejs";
/** A streaming response can run for tens of seconds; Vercel's default 10s would cut it off */
export const maxDuration = 300;

export async function POST(req: Request) {
  let rfpText: string;
  try {
    const body = await req.json();
    rfpText = String(body.rfpText ?? "").trim();
  } catch {
    return Response.json({ error: "Request body is not valid JSON" }, { status: 400 });
  }

  if (rfpText.length < 50) {
    return Response.json(
      { error: "Solicitation text is too short; at least 50 characters are required" },
      { status: 400 },
    );
  }
  if (rfpText.length > 500_000) {
    return Response.json(
      { error: "Content too long. Paste only the Scope of Work section, or process it in parts." },
      { status: 413 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // Don't leak configuration details to the client; logging it is enough
    console.error("ANTHROPIC_API_KEY is not configured");
    return Response.json({ error: "Service temporarily unavailable" }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const line = (obj: unknown) => encoder.encode(JSON.stringify(obj) + "\n");

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // ── Layer 1 + Layer 2 ──
        // In production, swap assumptions for the currently logged-in client's
        // assumption library, drop useFixtureWages, and pass a real samApiKey.
        const { snapshot, comparablesCaveat, pipelineWarnings } = await runEstimate({
          rfpText,
          assumptions: STARTING_DEFAULTS,
          id: crypto.randomUUID(),
          now: new Date().toISOString(),
          useFixtureWages: true, // ⚠️ set to false and configure samApiKey before going live
          samApiKey: process.env.SAM_GOV_API_KEY,
          blsApiKey: process.env.BLS_API_KEY,
        });

        // Numbers go first so the frontend can render the table immediately,
        // without waiting for the explanation to finish generating
        controller.enqueue(
          line({ type: "estimate", snapshot, comparablesCaveat, pipelineWarnings }),
        );

        // ── Layer 3 ──
        for await (const chunk of streamExplanation(
          snapshot.scope,
          snapshot.estimate,
          STARTING_DEFAULTS,
          comparablesCaveat,
        )) {
          controller.enqueue(line({ type: "text", delta: chunk }));
        }

        controller.enqueue(line({ type: "done" }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("Estimate failed:", e);
        // Once the stream has started, the HTTP status can't be changed;
        // the only option is to send the error inside the stream
        controller.enqueue(line({ type: "error", message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Some reverse proxies buffer streamed responses; this header tells nginx not to
      "X-Accel-Buffering": "no",
    },
  });
}
