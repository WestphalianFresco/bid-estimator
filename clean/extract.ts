import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { findProductivity, type AssumptionSet } from "./assumptions";
import { EXTRACTION_SYSTEM, renderAssumptionCatalog } from "./prompts";
import { ExtractedScopeSchema, type ExtractedScope } from "./schema";

const client = new Anthropic();

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

export async function extractScope(
  rfpText: string,
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

    messages: [
      {
        role: "user",
        content: `Extract the scope from this solicitation.\n\n<solicitation>\n${rfpText}\n</solicitation>`,
      },
    ],
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
