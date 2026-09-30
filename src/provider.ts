import { ask, resolveTransport } from "@jkudish/jev-agent-tools";
import type { JevAnswer, JevTransport, JevTransportInput, JevTransportReply } from "@jkudish/jev-agent-tools";

export { resolveTransport };
export type { JevAnswer, JevTransport, JevTransportInput, JevTransportReply };

/**
 * OpenRouter routing rule sent with every Jev call: only providers that neither train on
 * nor retain prompts. If that ever stops holding, OpenRouter refuses the call instead of
 * quietly sending page text somewhere less private.
 */
export const OPENROUTER_PRIVACY_FILTER = { data_collection: "deny", zdr: true } as const;

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * The upstream OpenRouter transport sends no provider filter, so this one replaces it.
 * Error messages mirror the upstream wording so callers see the same failures.
 */
function privateOpenRouterTransport(apiKey: string): JevTransport {
  return {
    name: "openrouter",
    async ask({ state, questions, model, signal }: JevTransportInput): Promise<JevTransportReply> {
      const effectiveModel = model === "jev-latest" ? "jev-1.13" : model;
      const slug = effectiveModel.startsWith("typesafe/") ? effectiveModel : `typesafe/${effectiveModel}`;
      const response = await fetch(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: slug, provider: OPENROUTER_PRIVACY_FILTER, state, questions }),
        signal,
      }).catch(() => {
        if (signal.aborted) throw signal.reason;
        throw new Error("OpenRouter decisions API HTTP unavailable (network error; 0 response bytes)");
      });
      const raw = await response.text();
      const bytes = Buffer.byteLength(raw);
      if (!response.ok) throw new Error(`OpenRouter decisions API HTTP ${response.status} (request failed; ${bytes} response bytes)`);
      let body: { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error(`OpenRouter decisions API HTTP ${response.status} (invalid JSON; ${bytes} response bytes)`);
      }
      return {
        answers: body.answers,
        usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
        model: slug,
      } as JevTransportReply;
    },
  };
}

/** Same selection as the upstream resolver, but OpenRouter calls go through the privacy-filtered transport. */
export function resolvePrivateTransport(env: NodeJS.ProcessEnv = process.env): JevTransport {
  const transport = resolveTransport(env);
  if (transport.name !== "openrouter") return transport;
  return privateOpenRouterTransport(env.OPENROUTER_API_KEY!);
}

export interface AskResult {
  answers: Record<string, JevAnswer>;
  usage: JevTransportReply["usage"];
  provider: string;
  model: string;
}

/** Internal marker so a failed judgment cannot be mistaken for a page action error. */
export class InvalidJevAnswer extends Error {}

export async function askJev(transport: JevTransport, input: JevTransportInput): Promise<AskResult> {
  const result = await ask(input, { transport });
  if (!result.ok) {
    if (input.signal.aborted) throw input.signal.reason;
    if (result.code === "request_failed") throw new Error(result.message);
    throw new InvalidJevAnswer(result.message);
  }
  // The package redacts unrecognized names; successful injected transports
  // still report the caller's name, as the public navigate() API promises.
  const provider = typeof transport.name === "string" && transport.name.trim() ? transport.name : "unknown";
  return { answers: result.answer, usage: result.usage, provider, model: result.model };
}
