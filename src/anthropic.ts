/**
 * anthropic.ts — thin wrapper around the Claude API client, with retry/wait on
 * rate limits and transient server/connection errors.
 */
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./util.js";

export function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "set ANTHROPIC_API_KEY (get one at https://console.anthropic.com)",
    );
  }
  // We own retries (see withRetry) so they're visible and honor Retry-After.
  return new Anthropic({ maxRetries: 0 });
}

export interface CallResult {
  text: string;
  inTok: number;
  outTok: number;
}

/**
 * True for the API's content-filtering rejection ("Output blocked by content
 * filtering policy"), a non-retryable 400. Callers handle it specially (e.g.
 * fall back to source) rather than aborting a whole run.
 */
export function isContentFilterError(err: unknown): boolean {
  const e = err as { message?: string; error?: { message?: string } };
  const msg = `${e?.message ?? ""} ${e?.error?.message ?? ""}`;
  return /content[\s_-]*filtering/i.test(msg);
}

// ---- Retry / wait ---------------------------------------------------------
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers) return undefined;
  const get = (headers as { get?: (k: string) => string | null }).get;
  const raw =
    typeof get === "function"
      ? get.call(headers, "retry-after")
      : (headers as Record<string, string>)["retry-after"];
  if (!raw) return undefined;
  const secs = Number(raw);
  if (!Number.isNaN(secs)) return secs * 1000;
  const when = Date.parse(raw); // HTTP-date form
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

/**
 * Run an API call, waiting and retrying on rate limits (429), overload (529),
 * transient 5xx, and connection errors instead of failing the whole run. Honors
 * the server's Retry-After header; otherwise uses exponential backoff + jitter.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const name = (err as { name?: string })?.name ?? "";
      const isConn = name.startsWith("APIConnection");
      const retryable =
        (typeof status === "number" && RETRYABLE_STATUS.has(status)) || isConn;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;

      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
      const waitMs =
        (retryAfterMs(err) ?? backoff) + Math.floor(Math.random() * 500);
      const reason =
        status === 429
          ? "rate limited"
          : status === 529
            ? "overloaded"
            : isConn
              ? "connection error"
              : `HTTP ${status}`;
      log(
        `  ⚠ ${label}: ${reason} — waiting ${Math.round(waitMs / 1000)}s, then retrying ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS - 1})`,
      );
      await sleep(waitMs);
    }
  }
}

// ---- Calls ----------------------------------------------------------------
function tallyInput(u: Anthropic.Usage): number {
  return (
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
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
  return withRetry("api", async () => {
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, inTok: tallyInput(resp.usage), outTok: resp.usage.output_tokens };
  });
}

/**
 * Streaming variant of {@link call}. `onSnapshot` receives the full text
 * accumulated so far on each delta, so the caller can show live progress.
 * Retries restart the stream, so `onSnapshot` may reset to a shorter string.
 */
export async function callStream(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  onSnapshot: (snapshot: string) => void,
  maxTokens = 16000,
): Promise<CallResult> {
  return withRetry("api", async () => {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    stream.on("text", (_delta, snapshot) => onSnapshot(snapshot));

    const msg = await stream.finalMessage();
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, inTok: tallyInput(msg.usage), outTok: msg.usage.output_tokens };
  });
}
