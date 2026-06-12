/**
 * anthropic.ts — thin wrapper around the Claude API client.
 */
import Anthropic from "@anthropic-ai/sdk";

export function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "set ANTHROPIC_API_KEY (get one at https://console.anthropic.com)",
    );
  }
  return new Anthropic();
}

export interface CallResult {
  text: string;
  inTok: number;
  outTok: number;
}

/**
 * One messages.create call. `system` is sent as a cache-controlled block so the
 * (identical) style + glossary prompt is billed at the cached rate across the
 * many chapter/batch calls.
 */
export async function call(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens = 16000,
): Promise<CallResult> {
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: user }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const u = resp.usage;
  const inTok =
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return { text, inTok, outTok: u.output_tokens };
}

/**
 * Streaming variant of {@link call}. `onText` receives each text delta as it
 * arrives, so the caller can show live progress instead of blocking on the
 * whole generation. Returns the same totals once the stream completes.
 */
export async function callStream(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  onText: (delta: string) => void,
  maxTokens = 16000,
): Promise<CallResult> {
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  stream.on("text", (delta) => onText(delta));

  const msg = await stream.finalMessage();
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const u = msg.usage;
  const inTok =
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return { text, inTok, outTok: u.output_tokens };
}
