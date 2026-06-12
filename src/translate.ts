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
import { getClient, callStream } from "./anthropic.js";

// ---- progress line: live-updating on a TTY, plain log lines otherwise ------
const isTTY = Boolean(process.stdout.isTTY);
let progressActive = false;
function progress(msg: string): void {
  if (isTTY) {
    process.stdout.write(`\r\x1b[2K  ${msg}`); // carriage return + clear line
    progressActive = true;
  } else {
    log(`  ${msg}`);
  }
}
/** Clear the in-progress line so the next log() prints a clean summary. */
function progressEnd(): void {
  if (isTTY && progressActive) {
    process.stdout.write("\r\x1b[2K");
    progressActive = false;
  }
}

export interface TranslateOpts {
  only?: string;
  model?: string;
  retranslate?: boolean;
  batchChars?: number; // source chars per API call (default 3500)
  concurrency?: number; // batches translated in parallel (default 4)
}

/** Count completed (newline-terminated) lines in a streaming accumulator. */
function completedLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Run async tasks with a bounded number in flight at once. */
async function runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}

export async function runTranslate(bookDir: string, opts: TranslateOpts): Promise<void> {
  const cfg = loadBookConfig(bookDir);
  const ctx = loadContext(bookDir);
  const model = opts.model ?? DEFAULT_MODEL;
  const budget = opts.batchChars ?? 3500;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
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

  // Decide up front which chapters need work, so progress can show "i/total".
  const todo = episodes.filter(
    (ep) => opts.retranslate || !fs.existsSync(zhPath(bookDir, ep)),
  );
  const skipped = episodes.length - todo.length;
  if (todo.length === 0) {
    log(`Nothing to translate: all ${episodes.length} chapter(s) already done.`);
    return;
  }
  log(`Translating ${todo.length} chapter(s) with ${model}${skipped ? `, ${skipped} already done` : ""} ...`);

  const client = getClient();
  let totalIn = 0;
  let totalOut = 0;
  let translated = 0;

  for (let c = 0; c < todo.length; c++) {
    const ep = todo[c];
    const out = zhPath(bookDir, ep);
    const paras = splitParagraphs(fs.readFileSync(koPath(bookDir, ep), "utf-8"));
    const batches = [...batchByChars(paras, budget)];
    const prefix = `[${c + 1}/${todo.length}] Ch.${ep}`;

    const result = new Array<string>(paras.length);
    let chIn = 0;
    let chOut = 0;

    // Live, aggregate progress across all in-flight batches: each batch reports
    // how many of its lines have streamed in so far; we sum and render. Throttled
    // so frequent stream deltas don't flood the line (force=true bypasses it).
    const live = new Array<number>(batches.length).fill(0);
    let lastRender = 0;
    const render = (force = false) => {
      const now = Date.now();
      if (!force && now - lastRender < 200) return;
      lastRender = now;
      const done = Math.min(
        live.reduce((a, b) => a + b, 0),
        paras.length,
      );
      progress(`${prefix}: ${done}/${paras.length} paras (${batches.length} batches ×${concurrency})`);
    };
    render(true);

    const tasks = batches.map((batch, bi) => async () => {
      const numbered = batch.items
        .map((p, i) => `${batch.start + i + 1}\t${p}`)
        .join("\n");
      const user =
        `Translate these numbered ${cfg.sourceLang} paragraphs to ${cfg.targetLang}. ` +
        `Return EXACTLY one line per input as \`<number><TAB><translation>\`, ` +
        `same numbering, no blank lines, no commentary:\n\n` +
        numbered;

      const { text, inTok, outTok } = await callStream(
        client,
        model,
        system,
        user,
        (snapshot) => {
          const n = Math.min(completedLines(snapshot), batch.items.length);
          if (n !== live[bi]) {
            live[bi] = n;
            render();
          }
        },
      );
      chIn += inTok;
      chOut += outTok;

      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s*\t\s*(.*)$/) || line.match(/^\s*(\d+)[.):]\s*(.*)$/);
        if (m) result[parseInt(m[1], 10) - 1] = m[2].trim();
      }
      live[bi] = batch.items.length;
      render(true);
    });

    await runPool(tasks, concurrency);
    progressEnd();

    // Fall back to source for any paragraph the model dropped.
    let missing = 0;
    for (let i = 0; i < paras.length; i++) {
      if (!result[i]) {
        result[i] = paras[i];
        missing++;
      }
    }
    // One blank line between paragraphs for readability. (splitParagraphs drops
    // blank lines, so extract/build read this back identically.)
    fs.writeFileSync(out, result.join("\n\n") + "\n");

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
