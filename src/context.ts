/**
 * context.ts — the per-book translation context: style guidance + a glossary
 * that pins proper nouns (names, places, 괴담/monster terms) to fixed Chinese
 * renderings so they stay consistent across chapters.
 *
 * Stored as <book>/context.yaml and injected into every translate call as a
 * prompt-cached system block.
 */
import fs from "node:fs";
import yaml from "js-yaml";
import { contextPath } from "./util.js";

export interface GlossaryEntry {
  ko: string;
  zh: string;
  note?: string;
}

export interface BookContext {
  style: string;
  glossary: GlossaryEntry[];
}

const DEFAULT_STYLE = `Genre: web novel. Narration is often first-person, fast-paced, and colloquial.
- Translate into natural, fluent, idiomatic target-language web-novel prose.
- Preserve the original paragraph breaks exactly (one input paragraph -> one output paragraph).
- Keep onomatopoeia and repeated sound effects as vivid equivalents; do not collapse or drop repetition.
- Keep dialogue punctuation natural for the target language.
- Do not add translator notes, summaries, or commentary.`;

export function loadContext(bookDir: string): BookContext {
  const p = contextPath(bookDir);
  if (!fs.existsSync(p)) return { style: DEFAULT_STYLE, glossary: [] };
  const raw = (yaml.load(fs.readFileSync(p, "utf-8")) ?? {}) as Partial<BookContext>;
  return {
    style: raw.style?.trim() || DEFAULT_STYLE,
    glossary: (raw.glossary ?? []).filter((g) => g && g.ko),
  };
}

export function saveContext(bookDir: string, ctx: BookContext): void {
  const body =
    "# Translation context for this book.\n" +
    "# `style`   : free-form guidance injected into the system prompt.\n" +
    "# `glossary`: ko (source term) -> zh (fixed target-language rendering) [+ note].\n" +
    "#            Edit the renderings to lock in what you want.\n\n" +
    yaml.dump(ctx, { lineWidth: 100, quotingType: '"' });
  fs.writeFileSync(contextPath(bookDir), body);
}

/** Render the context as the system prompt text for translation. */
export function buildSystemPrompt(ctx: BookContext, sourceLang: string, targetLang: string): string {
  let s = `You are an expert literary translator (${sourceLang} -> ${targetLang}).\n\n${ctx.style}`;
  if (ctx.glossary.length > 0) {
    const lines = ctx.glossary
      .filter((g) => g.zh) // only pinned renderings constrain the model
      .map((g) => `  ${g.ko} => ${g.zh}${g.note ? `  (${g.note})` : ""}`);
    if (lines.length > 0) {
      s +=
        `\n\nGLOSSARY — always render these exactly as given:\n` + lines.join("\n");
    }
  }
  return s;
}
