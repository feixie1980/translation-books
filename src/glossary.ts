/**
 * glossary.ts — auto-seed/update the per-book glossary by scanning a few
 * already-extracted chapters and asking Claude to pull out recurring proper
 * nouns (characters, places, organizations, 괴담/monster & special terms) with
 * proposed Chinese renderings. Runs entirely from the CLI; no chat needed.
 */
import fs from "node:fs";
import {
  DEFAULT_MODEL,
  koPath,
  discoverRawChapters,
  loadBookConfig,
  estimateCost,
  log,
} from "./util.js";
import { loadContext, saveContext, mergeGlossary, GlossaryEntry } from "./context.js";
import { getClient, call } from "./anthropic.js";

export interface GlossaryOpts {
  chapters?: number; // how many chapters to sample (default 5)
  model?: string;
  force?: boolean; // overwrite zh of existing entries too
}

const SYSTEM = `You extract a translation glossary from a Korean web novel.
Identify recurring PROPER NOUNS and special terms that must stay consistent across chapters:
character names, place names, organizations, and 괴담/monster/special-ability terms.
For each, propose a natural Simplified Chinese rendering.
Ignore common words and one-off nouns. Prefer terms that appear meaningful or repeated.`;

interface FoundItem {
  ko: string;
  zh: string;
  note?: string;
}

export async function runGlossary(bookDir: string, opts: GlossaryOpts): Promise<void> {
  const cfg = loadBookConfig(bookDir);
  const model = opts.model ?? DEFAULT_MODEL;
  const sampleN = opts.chapters ?? 5;

  // Pick the first N extracted chapters as the sample.
  const extracted = discoverRawChapters(bookDir)
    .map((c) => c.episode)
    .filter((ep) => fs.existsSync(koPath(bookDir, ep)));
  if (extracted.length === 0) {
    throw new Error("No extracted chapters found. Run `extract` first.");
  }
  const sample = extracted.slice(0, sampleN);
  log(`Seeding glossary from ${sample.length} chapter(s): ${sample.join(", ")}`);

  const blocks = sample
    .map((ep) => `### Chapter ${ep}\n${fs.readFileSync(koPath(bookDir, ep), "utf-8").slice(0, 8000)}`)
    .join("\n\n");

  const user =
    `Source language: ${cfg.sourceLang}. Target: ${cfg.targetLang}.\n\n` +
    `From the chapters below, output a JSON array of glossary entries. ` +
    `Each entry: {"ko": "<source term>", "zh": "<Chinese rendering>", "note": "<character|place|org|term>"}. ` +
    `Return ONLY the JSON array, no prose.\n\n` +
    blocks;

  const client = getClient();
  const { text, inTok, outTok } = await call(client, model, SYSTEM, user, 4000);

  const found = parseJsonArray(text);
  if (found.length === 0) {
    log("Model returned no glossary entries — leaving context.yaml unchanged.");
    return;
  }

  const ctx = loadContext(bookDir);
  const incoming: GlossaryEntry[] = found.map((f) => ({
    ko: f.ko.trim(),
    zh: (f.zh ?? "").trim(),
    note: f.note?.trim(),
  }));
  ctx.glossary = opts.force
    ? mergeGlossary(incoming, ctx.glossary) // incoming wins on zh
    : mergeGlossary(ctx.glossary, incoming); // keep existing zh
  saveContext(bookDir, ctx);

  const cost = estimateCost(model, inTok, outTok);
  log(`Glossary now has ${ctx.glossary.length} entries -> ${bookDir}/context.yaml`);
  log(`  (${found.length} proposed; tokens ${inTok} in / ${outTok} out ~= $${cost.toFixed(3)})`);
  log("  Review/edit the zh values before translating.");
}

function parseJsonArray(text: string): FoundItem[] {
  // Be tolerant of code fences / stray prose around the JSON.
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && typeof x.ko === "string");
  } catch {
    return [];
  }
}
