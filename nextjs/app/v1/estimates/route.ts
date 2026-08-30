import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { explainEstimate } from "@/lib/explain";
import { runEstimate } from "@/lib/pipeline";
import { isUsState } from "@/lib/schema";
import type { ScopeSource } from "@/lib/extract";
import type { LocationOverride } from "@/lib/pipeline";
import type { MaterialQuote } from "@/lib/data/home-depot";

import { ApiFault } from "@/lib/api/errors";
import {
  claimIdempotency,
  completeIdempotency,
  getEstimate,
  listEstimates,
  releaseIdempotency,
  saveEstimate,
} from "@/lib/api/store";
import {
  assertNoAssumptionsLeaked,
  isDetailLevel,
  toPublicEstimate,
  type DetailLevel,
} from "@/lib/api/serialize";
import { resolveDetail } from "@/lib/api/auth";
import { readJson, route, type RouteContext } from "../_lib/handler";

/**
 * POST /v1/estimates — price a solicitation.
 * GET  /v1/estimates — list this account's estimates.
 *
 * This is the endpoint the product is sold through. Everything expensive
 * happens here: two model calls and, depending on configuration, a wage
 * determination lookup and a comparables query.
 *
 * ## Why this returns one JSON document and the browser endpoint streams
 *
 * The in-app endpoint streams NDJSON because a human is watching a table fill
 * in and the perceived wait matters. An API caller is a program. It will parse
 * the whole body before doing anything, so streaming buys it nothing and costs
 * it a custom parser. One request, one JSON object, one status code.
 *
 * The price is latency: a full estimate takes tens of seconds. That is stated
 * in the docs, `expected_duration_seconds` is returned on 202-style polling
 * clients that ask for it, and the practical guidance is to set a client
 * timeout of 180s and use an Idempotency-Key so a timeout is safe to retry.
 *
 * ## Why Idempotency-Key matters more here than anywhere else
 *
 * A sixty-second request will time out on somebody's client, and their retry
 * logic will fire. Without a replay guard that is two model calls, two charges
 * against the monthly quota, and two different estimate ids for one intent.
 * With one, the retry returns the first result.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

// ── Material prices ─────────────────────────────────────────────────
// Read from disk, not fetched per request: SerpApi bills per search, and an
// estimate that calls a live pricing API is an estimate that cannot be
// reproduced. Same loader as the in-app route, same two search paths.

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
      continue;
    }
    if (priceCache?.path === path && priceCache.mtimeMs === mtimeMs) return priceCache.quotes;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        quotes?: Record<string, MaterialQuote>;
      };
      const quotes = parsed.quotes ?? {};
      priceCache = { path, mtimeMs, quotes };
      return quotes;
    } catch (e) {
      console.error(`Ignoring ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }
  return {};
}

// ── Request parsing ─────────────────────────────────────────────────

const MIN_TEXT = 50;
const MAX_TEXT = 500_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface ParsedRequest {
  source: ScopeSource;
  location: LocationOverride;
  detail: DetailLevel | undefined;
  includeExplanation: boolean;
  /** Stable hash of everything that affects the result, for idempotency. */
  requestHash: string;
}

function readDetail(v: unknown): DetailLevel | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isDetailLevel(v)) {
    throw new ApiFault("invalid_request", `detail must be "summary" or "lines".`);
  }
  return v;
}

function readLocation(state: unknown, county: unknown): LocationOverride {
  const location: LocationOverride = {};
  const s = String(state ?? "").trim().toUpperCase();
  if (s) {
    if (!isUsState(s)) {
      throw new ApiFault(
        "invalid_request",
        `"${s}" is not a two-letter US state or territory code.`,
      );
    }
    location.state = s;
  }
  const c = String(county ?? "").trim();
  if (c) location.county = c.replace(/\s+county$/i, "");
  return location;
}

/**
 * Accepts JSON with either `text` or a base64 `document`.
 *
 * The in-app route takes multipart because a browser posts a form. An API
 * caller is assembling a request in code, where base64 inside JSON is less
 * work than building a multipart body — and it keeps one content type for the
 * whole surface.
 */
async function parseRequest(req: Request): Promise<ParsedRequest> {
  const body = await readJson(req);

  const detail = readDetail(body.detail);
  const location = readLocation(body.state, body.county);
  const includeExplanation = body.explanation !== false;

  let source: ScopeSource;
  let sourceKey: string;

  if (typeof body.document === "object" && body.document !== null) {
    const doc = body.document as Record<string, unknown>;
    const filename = String(doc.filename ?? "document.pdf");
    const b64 = String(doc.data ?? "");
    if (!b64) {
      throw new ApiFault("invalid_request", "document.data must be a base64-encoded file.");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      throw new ApiFault("invalid_request", "document.data is not valid base64.");
    }
    if (bytes.length === 0) {
      throw new ApiFault("unprocessable_document", "The decoded document is empty.");
    }
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ApiFault(
        "payload_too_large",
        `Document is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB. ` +
          `Send only the Scope of Work section.`,
      );
    }

    const ext = filename.toLowerCase().split(".").pop() ?? "";
    if (ext === "pdf") {
      // Handed to the model as a document block: it reads tables and numbered
      // lists in place, which a text extractor would flatten.
      source = { kind: "pdf", base64: bytes.toString("base64"), filename };
    } else if (ext === "docx") {
      let text: string;
      try {
        const mammoth = await import("mammoth");
        text = (await mammoth.extractRawText({ buffer: bytes })).value;
      } catch (e) {
        throw new ApiFault(
          "unprocessable_document",
          `Could not read the .docx: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (text.trim().length < MIN_TEXT) {
        throw new ApiFault("unprocessable_document", "The .docx contained almost no text.");
      }
      source = { kind: "text", text };
    } else if (ext === "txt" || ext === "md" || ext === "text") {
      source = { kind: "text", text: bytes.toString("utf8") };
    } else {
      throw new ApiFault(
        "unprocessable_document",
        `Unsupported document type ".${ext}". Accepted: pdf, docx, txt, md — or send "text".`,
      );
    }
    sourceKey = `${filename}:${createHash("sha256").update(bytes).digest("hex")}`;
  } else {
    const text = String(body.text ?? "").trim();
    if (text.length < MIN_TEXT) {
      throw new ApiFault(
        "invalid_request",
        `"text" is required (at least ${MIN_TEXT} characters), or send a "document".`,
      );
    }
    if (text.length > MAX_TEXT) {
      throw new ApiFault(
        "payload_too_large",
        `"text" exceeds ${MAX_TEXT} characters. Send only the Scope of Work section.`,
      );
    }
    source = { kind: "text", text };
    sourceKey = createHash("sha256").update(text, "utf8").digest("hex");
  }

  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        sourceKey,
        location,
        detail,
        includeExplanation,
      }),
    )
    .digest("hex");

  return { source, location, detail, includeExplanation, requestHash };
}

// ── POST ────────────────────────────────────────────────────────────

async function create({ caller, req }: RouteContext): Promise<Response> {
  const parsed = await parseRequest(req);
  const detail = resolveDetail(caller, parsed.detail);

  // ── Replay guard ──────────────────────────────────────────────────
  const idemKey = req.headers.get("idempotency-key")?.trim() || null;
  if (idemKey) {
    if (idemKey.length > 255) {
      throw new ApiFault("invalid_request", "Idempotency-Key must be 255 characters or fewer.");
    }
    const claim = claimIdempotency(caller.account.id, idemKey, parsed.requestHash);
    if (claim.state === "conflict") {
      throw new ApiFault(
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request body.",
      );
    }
    if (claim.state === "replay") {
      if (!claim.estimateId) {
        throw new ApiFault(
          "idempotency_conflict",
          "A request with this Idempotency-Key is still in flight. Retry once it completes.",
          undefined,
          { "Retry-After": "10" },
        );
      }
      const prior = getEstimate(caller.account.id, claim.estimateId);
      if (prior) return replay(prior, detail);
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // Configuration detail stays in the log; the caller learns only that the
    // dependency is down, which is all they can act on.
    console.error("ANTHROPIC_API_KEY is not configured");
    if (idemKey) releaseIdempotency(caller.account.id, idemKey);
    throw new ApiFault("service_unavailable", "The estimating service is temporarily unavailable.");
  }

  const id = randomUUID();

  try {
    const result = await runEstimate({
      source: parsed.source,
      location: parsed.location,
      assumptions: STARTING_DEFAULTS,
      materialQuotes: loadMaterialQuotes(),
      id,
      now: new Date().toISOString(),
      // ⚠️ Fixture wages. See the deployment checklist in docs/api.md — every
      // figure this endpoint returns is invented until this is false.
      useFixtureWages: true,
      samApiKey: process.env.SAM_GOV_API_KEY,
      blsApiKey: process.env.BLS_API_KEY,
    });

    let explanation: string | undefined;
    if (parsed.includeExplanation) {
      explanation = await explainEstimate(
        result.snapshot.scope,
        result.snapshot.estimate,
        STARTING_DEFAULTS,
        result.comparablesCaveat,
      );
    }

    // wages and comparables are stored but never published: /v1/estimates/{id}
    // /reprice needs the exact basis the original was priced against, or an
    // adjusted total would silently drift from the one the customer was quoted.
    const extras = {
      bands: result.bands,
      composition: result.composition,
      pipelineWarnings: result.pipelineWarnings,
      comparablesCaveat: result.comparablesCaveat,
      explanation,
      wages: result.wages,
      comparables: result.comparables,
    };

    saveEstimate({
      id,
      accountId: caller.account.id,
      env: caller.env,
      snapshot: result.snapshot,
      extras,
      bidPrice: result.snapshot.estimate.totals.bidPrice as number,
    });
    if (idemKey) completeIdempotency(caller.account.id, idemKey, id);

    const body = toPublicEstimate({
      snapshot: result.snapshot,
      bands: result.bands,
      composition: result.composition,
      explanation,
      detail,
      pipelineWarnings: result.pipelineWarnings,
      comparablesCaveat: result.comparablesCaveat,
    });
    assertNoAssumptionsLeaked(body);

    return Response.json(body, { status: 201, headers: { Location: `/v1/estimates/${id}` } });
  } catch (e) {
    // A failed attempt must not burn the key: the caller retried in good faith
    // and got nothing, so the same key has to work again.
    if (idemKey) releaseIdempotency(caller.account.id, idemKey);
    if (e instanceof ApiFault) throw e;
    throw e;
  }
}

/** Rebuilds a stored estimate at the requested detail level. */
function replay(
  stored: { snapshot: unknown; extras: unknown },
  detail: DetailLevel,
  status = 200,
): Response {
  const extras = stored.extras as {
    bands: never;
    composition: never;
    pipelineWarnings?: string[];
    comparablesCaveat?: string | null;
    explanation?: string;
  };
  const body = toPublicEstimate({
    snapshot: stored.snapshot as never,
    bands: extras.bands,
    composition: extras.composition,
    explanation: extras.explanation,
    detail,
    pipelineWarnings: extras.pipelineWarnings,
    comparablesCaveat: extras.comparablesCaveat,
  });
  assertNoAssumptionsLeaked(body);
  return Response.json(body, { status, headers: { "Idempotent-Replay": "true" } });
}

// ── GET (list) ──────────────────────────────────────────────────────

async function list({ caller, req }: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 20;
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new ApiFault("invalid_request", "limit must be an integer between 1 and 100.");
  }
  const before = url.searchParams.get("before") ?? undefined;

  const rows = listEstimates(caller.account.id, { limit, before });

  // A list is an index, not a bulk export of full estimates. Anything more and
  // one paginated call becomes a way to pull every estimate at once.
  return Response.json({
    object: "list",
    data: rows.map((r) => ({
      id: r.id,
      object: "estimate",
      created_at: r.createdAt,
      bid_price: { cents: r.bidPrice, dollars: r.bidPrice / 100 },
      url: `/v1/estimates/${r.id}`,
    })),
    has_more: rows.length === limit,
    next_before: rows.length > 0 ? rows[rows.length - 1].createdAt : null,
  });
}

export const POST = route({ name: "estimates.create", billable: true, handler: create });
export const GET = route({ name: "estimates.list", billable: false, handler: list });
