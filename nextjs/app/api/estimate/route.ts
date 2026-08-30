import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { streamExplanation } from "@/lib/explain";
import { runEstimate } from "@/lib/pipeline";
import type { ScopeSource } from "@/lib/extract";
import type { LocationOverride } from "@/lib/pipeline";
import { isUsState } from "@/lib/schema";
import type { MaterialQuote } from "@/lib/data/home-depot";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Estimate endpoint.
 *
 * ⚠️ This is **server-side** code. The API key is read from process.env and
 *    never reaches the browser. Do not move this logic into a client component.
 *
 * Accepts either:
 *   - application/json      {"rfpText": "...", "state": "CA", "county": "..."}
 *   - multipart/form-data   file=<.pdf|.docx|.txt|.md>, state=..., county=...
 *
 * state and county are optional and override whatever the extractor finds. A
 * solicitation that names only "Jefferson County" cannot be priced correctly
 * without them, so the caller is given a way to supply the answer.
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

/**
 * Material prices written by `npm run refresh-prices`.
 *
 * Read from disk rather than fetched per request: SerpApi bills per search, and
 * pricing must stay reproducible, so the quotes are pulled once, folded into the
 * assumption set, and captured in the estimate snapshot. Absent file means the
 * catalog defaults apply, which is a normal state, not an error.
 */
//
// Two locations are checked because the refresh script runs from the repo root
// while Next runs from this app directory. Looking in only one of them failed
// silently: the file existed, the estimate used catalog defaults anyway, and
// nothing said so.
const PRICES_FILES = [
  join(process.cwd(), "material-prices.local.json"),
  join(process.cwd(), "..", "material-prices.local.json"),
];
let priceCache: { path: string; mtimeMs: number; quotes: Record<string, MaterialQuote> } | null =
  null;

function loadMaterialQuotes(): Record<string, MaterialQuote> {
  for (const path of PRICES_FILES) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue; // not here; try the next location
    }

    if (priceCache?.path === path && priceCache.mtimeMs === mtimeMs) return priceCache.quotes;

    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        quotes?: Record<string, MaterialQuote>;
      };
      const quotes = parsed.quotes ?? {};
      priceCache = { path, mtimeMs, quotes };
      console.log(`Loaded ${Object.keys(quotes).length} material price(s) from ${path}`);
      return quotes;
    } catch (e) {
      // The file is there but unreadable. Say so — falling back silently is how
      // this went unnoticed the first time.
      console.error(`Ignoring ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }
  return {};
}

const MIN_TEXT = 50;
const MAX_TEXT = 500_000;
/** The Messages API caps a request at 32 MB total; leave room for base64 overhead. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type ParseOk = {
  ok: true;
  source: ScopeSource;
  label: string;
  location: LocationOverride;
};
type ParseErr = { ok: false; status: number; error: string };

/**
 * Reads an optional location override. An empty field means "no opinion" and
 * leaves extraction untouched; only a real value overrides.
 */
function readLocation(get: (k: string) => string | null): LocationOverride | ParseErr {
  const rawState = (get("state") ?? "").trim().toUpperCase();
  const rawCounty = (get("county") ?? "").trim();

  const location: LocationOverride = {};
  if (rawState) {
    if (!isUsState(rawState)) {
      return {
        ok: false,
        status: 400,
        error: `"${rawState}" is not a two-letter US state or territory code.`,
      };
    }
    location.state = rawState;
  }
  if (rawCounty) location.county = rawCounty.replace(/\s+county$/i, "");
  return location;
}

const isParseErr = (v: unknown): v is ParseErr =>
  typeof v === "object" && v !== null && (v as ParseErr).ok === false;

async function readSource(req: Request): Promise<ParseOk | ParseErr> {
  const contentType = req.headers.get("content-type") ?? "";

  // ── Uploaded file ──────────────────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { ok: false, status: 400, error: "Could not read the uploaded form" };
    }

    const location = readLocation((k) => {
      const v = form.get(k);
      return typeof v === "string" ? v : null;
    });
    if (isParseErr(location)) return location;

    const file = form.get("file");
    if (!(file instanceof File)) {
      return { ok: false, status: 400, error: "No file was attached" };
    }
    if (file.size === 0) {
      return { ok: false, status: 400, error: "The uploaded file is empty" };
    }
    if (file.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB. Upload only the Scope of Work section.`,
      };
    }

    const name = file.name || "upload";
    const ext = name.toLowerCase().split(".").pop() ?? "";
    const bytes = Buffer.from(await file.arrayBuffer());

    if (ext === "pdf") {
      // Handed to the model as a document block — it reads tables and numbered
      // lists in place, which a text extractor would flatten.
      return {
        ok: true,
        label: name,
        location,
        source: { kind: "pdf", base64: bytes.toString("base64"), filename: name },
      };
    }

    if (ext === "docx") {
      let text: string;
      try {
        const mammoth = await import("mammoth");
        text = (await mammoth.extractRawText({ buffer: bytes })).value;
      } catch (e) {
        return {
          ok: false,
          status: 422,
          error: `Could not read the .docx file: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (text.trim().length < MIN_TEXT) {
        return { ok: false, status: 422, error: "The .docx file contained almost no text" };
      }
      return { ok: true, label: name, location, source: { kind: "text", text } };
    }

    if (ext === "txt" || ext === "md" || ext === "text") {
      const text = bytes.toString("utf8");
      if (text.trim().length < MIN_TEXT) {
        return { ok: false, status: 400, error: "The file is too short; at least 50 characters are required" };
      }
      if (text.length > MAX_TEXT) {
        return { ok: false, status: 413, error: "File too long. Upload only the Scope of Work section." };
      }
      return { ok: true, label: name, location, source: { kind: "text", text } };
    }

    // .doc is the old binary format and needs a different parser than .docx.
    return {
      ok: false,
      status: 415,
      error: `Unsupported file type ".${ext}". Accepted: .pdf, .docx, .txt, .md — or paste the text instead.`,
    };
  }

  // ── Typed or pasted text ───────────────────────────────────────────
  let rfpText: string;
  let location: LocationOverride | ParseErr;
  try {
    const body = await req.json();
    rfpText = String(body.rfpText ?? "").trim();
    location = readLocation((k) => (body[k] == null ? null : String(body[k])));
  } catch {
    return { ok: false, status: 400, error: "Request body is not valid JSON" };
  }
  if (isParseErr(location)) return location;

  if (rfpText.length < MIN_TEXT) {
    return {
      ok: false,
      status: 400,
      error: "Solicitation text is too short; at least 50 characters are required",
    };
  }
  if (rfpText.length > MAX_TEXT) {
    return {
      ok: false,
      status: 413,
      error: "Content too long. Paste only the Scope of Work section, or process it in parts.",
    };
  }

  return { ok: true, label: "pasted text", location, source: { kind: "text", text: rfpText } };
}

export async function POST(req: Request) {
  const parsed = await readSource(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
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
        const {
          snapshot,
          comparablesCaveat,
          pipelineWarnings,
          wages,
          comparables,
          bands,
          composition,
        } = await runEstimate({
          source: parsed.source,
          location: parsed.location,
          assumptions: STARTING_DEFAULTS,
          materialQuotes: loadMaterialQuotes(),
          id: crypto.randomUUID(),
          now: new Date().toISOString(),
          useFixtureWages: true, // ⚠️ set to false and configure samApiKey before going live
          samApiKey: process.env.SAM_GOV_API_KEY,
          blsApiKey: process.env.BLS_API_KEY,
        });

        // Numbers go first so the frontend can render the table immediately,
        // without waiting for the explanation to finish generating
        controller.enqueue(
          line({
            type: "estimate",
            snapshot,
            comparablesCaveat,
            pipelineWarnings,
            sourceLabel: parsed.label,
            wages,
            comparables,
            bands,
            composition,
          }),
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
