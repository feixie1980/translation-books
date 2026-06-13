/**
 * glossary.ts — auto-seed/update the per-book glossary by scanning extracted
 * chapters and asking Claude to pull out recurring proper nouns (characters,
 * places, organizations, monster/worldbuilding terms) with proposed target-
 * language renderings.
 *
 * Evolving glossary: `--only` samples any chapter window (e.g. a later arc), the
 * already-pinned terms are shown to the model so it returns only NEW ones, and
 * the merge adds/fills without clobbering pinned renderings — conflicts are
 * reported, not resolved silently (use `--force` to adopt the model's). Runs
 * entirely from the CLI; no chat needed.
 */
import fs from "node:fs";
import {
  DEFAULT_MODEL,
  koPath,
  discoverRawChapters,
  loadBookConfig,
  parseOnly,
  estimateCost,
  log,
} from "./util.js";
import { loadContext, saveContext, GlossaryEntry } from "./context.js";
import { getClient, call } from "./anthropic.js";

export interface GlossaryOpts {
  only?: string; // episodes to sample, e.g. "100-110" (default: first --chapters)
  chapters?: number; // how many chapters to sample (default 5; cap for --only)
  model?: string;
  force?: boolean; // adopt the model's rendering when it differs from a pinned one
}

function buildGlossarySystem(sourceLang: string, targetLang: string): string {
  return `You extract a translation glossary from a ${sourceLang} web novel.
Identify recurring PROPER NOUNS and special terms that must stay consistent across chapters:
character names, place names, organizations, and monster/special-ability/worldbuilding terms.
For each, propose a natural ${targetLang} rendering.
Ignore common words and one-off nouns. Prefer terms that appear meaningful or repeated.`;
}

interface FoundItem {
  ko: string;
  zh: string;
  note?: string;
}

export async function runGlossary(bookDir: string, opts: GlossaryOpts): Promise<void> {
  const cfg = loadBookConfig(bookDir);
  const model = opts.model ?? DEFAULT_MODEL;

  const extracted = discoverRawChapters(bookDir)
    .map((c) => c.episode)
    .filter((ep) => fs.existsSync(koPath(bookDir, ep)));
  if (extracted.length === 0) {
    throw new Error("No extracted chapters found. Run `extract` first.");
  }

  // Sample selection: `--only` picks a window (e.g. a later arc), otherwise the
  // first chapters. `--chapters` caps either case; it defaults to 5 only when no
  // explicit window is given, so `--only 100-110` scans the whole range.
  const filter = parseOnly(opts.only);
  const candidates = filter ? extracted.filter((ep) => filter.has(ep)) : extracted;
  const cap = opts.chapters ?? (filter ? candidates.length : 5);
  const sample = candidates.slice(0, cap);
  if (sample.length === 0) {
    log("No extracted chapters match the --only filter.");
    return;
  }

  // The existing glossary is loaded up front and shown to the model so it reuses
  // pinned renderings and proposes only NEW terms (less duplication, fewer
  // divergent renderings). The explicit merge below is the safety net.
  const ctx = loadContext(bookDir);
  const pinned = ctx.glossary.filter((g) => g.zh);
  log(
    `Seeding glossary from ${sample.length} chapter(s): ${sample.join(", ")}` +
      (ctx.glossary.length ? ` (${ctx.glossary.length} already in context.yaml)` : ""),
  );

  const blocks = sample
    .map((ep) => `### Chapter ${ep}\n${fs.readFileSync(koPath(bookDir, ep), "utf-8").slice(0, 8000)}`)
    .join("\n\n");

  const knownBlock = pinned.length
    ? `These terms are ALREADY pinned — reuse these exact renderings for consistency and do NOT include them in your output:\n` +
      pinned.map((g) => `  ${g.ko} => ${g.zh}`).join("\n") +
      `\n\n`
    : "";

  const user =
    `Source language: ${cfg.sourceLang}. Target: ${cfg.targetLang}.\n\n` +
    knownBlock +
    `From the chapters below, output a JSON array of glossary entries for terms NOT already pinned above. ` +
    `Each entry: {"ko": "<source term>", "zh": "<${cfg.targetLang} rendering>", "note": "<character|place|org|term>"}. ` +
    `Return ONLY the JSON array, no prose.\n\n` +
    blocks;

  const client = getClient();
  const system = buildGlossarySystem(cfg.sourceLang, cfg.targetLang);
  const { text, inTok, outTok } = await call(client, model, system, user, 4000);

  const found = parseJsonArray(text);
  const incoming: GlossaryEntry[] = found.map((f) => ({
    ko: f.ko.trim(),
    zh: (f.zh ?? "").trim(),
    note: f.note?.trim(),
  }));

  // Explicit merge keyed on the source term, with conflicts surfaced rather than
  // resolved silently:
  //   - new term            -> added
  //   - known, no rendering  -> filled in
  //   - known, same/empty zh -> ignored (duplicate)
  //   - known, different zh  -> conflict: kept as-is (or overwritten with --force)
  const byKo = new Map(ctx.glossary.map((e) => [e.ko, e]));
  let added = 0;
  let filled = 0;
  const conflicts: { ko: string; have: string; proposed: string }[] = [];
  for (const f of incoming) {
    if (!f.ko) continue;
    const e = byKo.get(f.ko);
    if (!e) {
      const entry: GlossaryEntry = { ko: f.ko, zh: f.zh, note: f.note };
      byKo.set(f.ko, entry);
      added++;
    } else if (f.zh && !e.zh) {
      e.zh = f.zh;
      if (f.note && !e.note) e.note = f.note;
      filled++;
    } else if (f.zh && e.zh && f.zh !== e.zh) {
      conflicts.push({ ko: f.ko, have: e.zh, proposed: f.zh });
      if (opts.force) e.zh = f.zh;
    }
  }
  ctx.glossary = [...byKo.values()].sort((a, b) => a.ko.localeCompare(b.ko));
  saveContext(bookDir, ctx);

  const cost = estimateCost(model, inTok, outTok);
  log(`Glossary now has ${ctx.glossary.length} entries -> ${bookDir}/context.yaml`);
  log(
    `  ${added} new, ${filled} filled in, ${conflicts.length} conflict(s); ` +
      `${found.length} proposed; tokens ${inTok} in / ${outTok} out ~= $${cost.toFixed(3)}`,
  );
  if (conflicts.length) {
    log(
      opts.force
        ? `  Overwrote ${conflicts.length} pinned rendering(s) (--force):`
        : `  Kept existing renderings; model proposed different ones (re-run with --force to adopt, or edit by hand):`,
    );
    for (const c of conflicts) {
      log(`    ${c.ko}: "${c.have}"${opts.force ? " <- " : " (keep) vs proposed "}"${c.proposed}"`);
    }
  }
  log("  Review/edit the renderings before translating.");
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
