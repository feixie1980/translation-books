/**
 * translate.ts — Stage 2: NNN.ko.txt -> NNN.zh.txt (Korean -> Chinese).
 *
 * Paragraphs are sent in numbered batches (bounded by a character budget) and
 * returned 1:1, so paragraph structure is preserved exactly. The style+glossary
 * system prompt is prompt-cached across all calls.
 */
import fs from "node:fs";
import {
  DEFAULT_MODEL,
  loadBookConfig,
  koPath,
  zhPath,
  readMeta,
  writeMeta,
  splitParagraphs,
  discoverRawChapters,
  parseOnly,
  estimateCost,
  log,
} from "./util.js";
import { loadContext, buildSystemPrompt } from "./context.js";
import { getClient, call } from "./anthropic.js";

export interface TranslateOpts {
  only?: string;
  model?: string;
  retranslate?: boolean;
  batchChars?: number; // source chars per API call (default 3500)
}

export async function runTranslate(bookDir: string, opts: TranslateOpts): Promise<void> {
  const cfg = loadBookConfig(bookDir);
  const ctx = loadContext(bookDir);
  const model = opts.model ?? DEFAULT_MODEL;
  const budget = opts.batchChars ?? 3500;
  const system = buildSystemPrompt(ctx, cfg.sourceLang, cfg.targetLang);

  const filter = parseOnly(opts.only);
  const episodes = discoverRawChapters(bookDir)
    .map((c) => c.episode)
    .filter((ep) => !filter || filter.has(ep))
    .filter((ep) => fs.existsSync(koPath(bookDir, ep)));

  if (episodes.length === 0) {
    log("No extracted chapters to translate. Run `extract` first.");
    return;
  }

  const client = getClient();
  let totalIn = 0;
  let totalOut = 0;
  let translated = 0;
  let skipped = 0;

  for (const ep of episodes) {
    const out = zhPath(bookDir, ep);
    if (fs.existsSync(out) && !opts.retranslate) {
      skipped++;
      continue;
    }
    const paras = splitParagraphs(fs.readFileSync(koPath(bookDir, ep), "utf-8"));
    log(`[Ch.${ep}] translating ${paras.length} paragraphs with ${model} ...`);

    const result = new Array<string>(paras.length);
    let chIn = 0;
    let chOut = 0;

    for (const batch of batchByChars(paras, budget)) {
      const numbered = batch.items
        .map((p, i) => `${batch.start + i + 1}\t${p}`)
        .join("\n");
      const user =
        `Translate these numbered ${cfg.sourceLang} paragraphs to ${cfg.targetLang}. ` +
        `Return EXACTLY one line per input as \`<number><TAB><translation>\`, ` +
        `same numbering, no blank lines, no commentary:\n\n` +
        numbered;

      const { text, inTok, outTok } = await call(client, model, system, user);
      chIn += inTok;
      chOut += outTok;

      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s*\t\s*(.*)$/) || line.match(/^\s*(\d+)[.):]\s*(.*)$/);
        if (m) result[parseInt(m[1], 10) - 1] = m[2].trim();
      }
    }

    // Fall back to source for any paragraph the model dropped.
    let missing = 0;
    for (let i = 0; i < paras.length; i++) {
      if (!result[i]) {
        result[i] = paras[i];
        missing++;
      }
    }
    fs.writeFileSync(out, result.join("\n") + "\n");

    const prev = readMeta(bookDir, ep) ?? ({} as any);
    writeMeta(bookDir, {
      ...prev,
      episode: ep,
      model,
      tokensIn: chIn,
      tokensOut: chOut,
      translatedAt: new Date().toISOString(),
    });

    totalIn += chIn;
    totalOut += chOut;
    translated++;
    const cost = estimateCost(model, chIn, chOut);
    log(
      `  ✓ Ch.${ep}: ${paras.length} paras` +
        (missing ? `, ${missing} fell back to source` : "") +
        `  (${chIn} in / ${chOut} out ~= $${cost.toFixed(3)})`,
    );
  }

  const cost = estimateCost(model, totalIn, totalOut);
  log(
    `Translate done: ${translated} chapter(s), ${skipped} already done. ` +
      `Total tokens ${totalIn} in / ${totalOut} out ~= $${cost.toFixed(2)}.`,
  );
}

interface Batch {
  start: number; // index of first paragraph in this batch
  items: string[];
}

/** Group paragraphs into batches under a source-character budget. */
function* batchByChars(paras: string[], budget: number): Generator<Batch> {
  let start = 0;
  let cur: string[] = [];
  let chars = 0;
  for (let i = 0; i < paras.length; i++) {
    const len = paras[i].length;
    if (cur.length > 0 && chars + len > budget) {
      yield { start, items: cur };
      start = i;
      cur = [];
      chars = 0;
    }
    cur.push(paras[i]);
    chars += len;
  }
  if (cur.length > 0) yield { start, items: cur };
}
