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
import { getClient, call, callStream, isContentFilterError } from "./anthropic.js";

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
  let totalBlocked = 0;
  let translated = 0;

  for (let c = 0; c < todo.length; c++) {
    const ep = todo[c];
    const out = zhPath(bookDir, ep);
    const paras = splitParagraphs(fs.readFileSync(koPath(bookDir, ep), "utf-8"));
    const batches = [...batchByChars(paras, budget)];
    const prefix = `[${c + 1}/${todo.length}] Ch.${ep}`;

    const result = new Array<string>(paras.length);
    const blockedParas: number[] = []; // 1-based paragraph numbers the filter blocked
    let chIn = 0;
    let chOut = 0;

    // Prompt for a numbered range of paragraphs, and parse the numbered reply
    // back into `result` by absolute index (numbering is 1-based and absolute,
    // so split sub-ranges still land in the right slots).
    const buildUser = (startIndex: number, items: string[]): string =>
      `Translate these numbered ${cfg.sourceLang} paragraphs to ${cfg.targetLang}. ` +
      `Return EXACTLY one line per input as \`<number><TAB><translation>\`, ` +
      `same numbering, no blank lines, no commentary:\n\n` +
      items.map((p, i) => `${startIndex + i + 1}\t${p}`).join("\n");
    const parseInto = (text: string) => {
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s*\t\s*(.*)$/) || line.match(/^\s*(\d+)[.):]\s*(.*)$/);
        if (m) result[parseInt(m[1], 10) - 1] = m[2].trim();
      }
    };

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

    // Content-filter salvage: a blocked batch fails as a whole, so bisect it
    // (non-streaming) to translate the clean paragraphs and isolate the offending
    // ones down to single paragraphs, which fall back to source.
    const salvage = async (startIndex: number, items: string[]): Promise<void> => {
      if (items.length === 1) {
        blockedParas.push(startIndex + 1);
        return;
      }
      const mid = Math.ceil(items.length / 2);
      const halves: Array<[number, string[]]> = [
        [startIndex, items.slice(0, mid)],
        [startIndex + mid, items.slice(mid)],
      ];
      for (const [s, part] of halves) {
        if (part.length === 0) continue;
        try {
          const { text, inTok, outTok } = await call(client, model, system, buildUser(s, part));
          chIn += inTok;
          chOut += outTok;
          parseInto(text);
        } catch (e) {
          if (!isContentFilterError(e)) throw e;
          await salvage(s, part);
        }
      }
    };

    const tasks = batches.map((batch, bi) => async () => {
      try {
        const { text, inTok, outTok } = await callStream(
          client,
          model,
          system,
          buildUser(batch.start, batch.items),
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
        parseInto(text);
      } catch (e) {
        if (!isContentFilterError(e)) throw e;
        await salvage(batch.start, batch.items);
      }
      live[bi] = batch.items.length;
      render(true);
    });

    await runPool(tasks, concurrency);
    progressEnd();

    // Fall back to source for any paragraph the model dropped or the filter blocked.
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

    blockedParas.sort((a, b) => a - b);
    const prev = readMeta(bookDir, ep) ?? ({} as any);
    writeMeta(bookDir, {
      ...prev,
      episode: ep,
      model,
      tokensIn: chIn,
      tokensOut: chOut,
      translatedAt: new Date().toISOString(),
      blockedParas: blockedParas.length ? blockedParas : undefined,
    });

    totalIn += chIn;
    totalOut += chOut;
    totalBlocked += blockedParas.length;
    translated++;
    const cost = estimateCost(model, chIn, chOut);
    log(
      `  ✓ Ch.${ep}: ${paras.length} paras` +
        (missing ? `, ${missing} fell back to source` : "") +
        `  (${chIn} in / ${chOut} out ~= $${cost.toFixed(3)})`,
    );
    if (blockedParas.length) {
      log(
        `    ⚠ ${blockedParas.length} paragraph(s) blocked by content filter, kept source: ` +
          blockedParas.join(", "),
      );
    }
  }

  const cost = estimateCost(model, totalIn, totalOut);
  log(
    `Translate done: ${translated} chapter(s), ${skipped} already done. ` +
      `Total tokens ${totalIn} in / ${totalOut} out ~= $${cost.toFixed(2)}.` +
      (totalBlocked ? ` ${totalBlocked} paragraph(s) blocked by content filter (kept source).` : ""),
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
