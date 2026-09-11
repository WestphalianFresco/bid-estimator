import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { findProductivity, type AssumptionSet } from "./assumptions";
import { EXTRACTION_SYSTEM, renderAssumptionCatalog } from "./prompts";
import { ExtractedScopeSchema, type ExtractedScope } from "./schema";

const client = new Anthropic();

/**
 * What Layer 1 reads.
 *
 * A PDF is passed straight through as a document block rather than being run
 * through a text extractor first. Solicitations carry quantities in tables and
 * numbered lists, and flattening them to plain text loses the row/column
 * association that tells you which number belongs to which line item.
 */
export type ScopeSource =
  | { kind: "text"; text: string }
  | { kind: "pdf"; base64: string; filename: string };

export interface ExtractResult {
  scope: ExtractedScope;
  unknownKeys: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

/** One-line description of the input, for the audit snapshot. */
export const describeSource = (source: ScopeSource): string =>
  source.kind === "pdf"
    ? `[PDF] ${source.filename}`
    : source.text;

export function buildContent(source: ScopeSource): Anthropic.ContentBlockParam[] {
  const instruction =
    "Extract the scope from this solicitation. If it is a narrative description " +
    "rather than a formal solicitation, extract what is stated and record " +
    "everything a bidder would still need to ask.";

  if (source.kind === "pdf") {
    // Document first, instruction after - the model attends better to a
    // question that comes after the material it is asked about.
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: source.base64 },
      },
      { type: "text", text: instruction },
    ];
  }

  // A solicitation is uploaded by whoever is using the tool and is not trusted
  // input: text containing the closing tag would otherwise break out of the
  // delimiter and read as instructions. Neutralize it rather than dropping it,
  // so the document still reads normally.
  const document = source.text.replace(/<\/?solicitation>/gi, "[tag removed]");

  return [
    {
      type: "text",
      text: `${instruction}\n\n<solicitation>\n${document}\n</solicitation>`,
    },
  ];
}

export async function extractScope(
  source: ScopeSource,
  assumptions: AssumptionSet,
): Promise<ExtractResult> {
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,

    system: [
      { type: "text", text: EXTRACTION_SYSTEM },
      {
        type: "text",
        text: renderAssumptionCatalog(assumptions),
        cache_control: { type: "ephemeral" },
      },
    ],

    output_config: {
      format: zodOutputFormat(ExtractedScopeSchema),
      effort: "medium",
    },
    thinking: { type: "adaptive" },

    messages: [{ role: "user", content: buildContent(source) }],
  });

  const scope = response.parsed_output;
  if (!scope) {
    throw new Error(
      `Scope extraction failed, stop_reason=${response.stop_reason}.` +
        (response.stop_reason === "max_tokens"
          ? " Document too long; chunk it or raise max_tokens."
          : ""),
    );
  }

  const unknownKeys = [
    ...new Set(
      scope.items
        .map((i) => i.assumption_key)
        .filter((k) => !findProductivity(assumptions, k)),
    ),
  ];

  return {
    scope,
    unknownKeys,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

export const cacheHit = (r: ExtractResult): boolean => r.usage.cacheReadTokens > 0;
