/**
 * extract.ts — Stage 1: Raws (.docx/.html) -> normalized work/chapters/NNN.ko.txt
 */
import fs from "node:fs";
import {
  discoverRawChapters,
  ensureDir,
  koPath,
  workChaptersDir,
  writeMeta,
  readMeta,
  splitParagraphs,
  parseOnly,
  log,
} from "./util.js";
import { extractChapter } from "./sources.js";

export interface ExtractOpts {
  only?: string;
  force?: boolean;
}

export async function runExtract(bookDir: string, opts: ExtractOpts): Promise<void> {
  ensureDir(workChaptersDir(bookDir));
  const filter = parseOnly(opts.only);
  const chapters = discoverRawChapters(bookDir).filter(
    (c) => !filter || filter.has(c.episode),
  );
  if (chapters.length === 0) {
    log("No matching source chapters found in Raws.");
    return;
  }

  let done = 0;
  let skipped = 0;
  for (const ch of chapters) {
    const out = koPath(bookDir, ch.episode);
    if (fs.existsSync(out) && !opts.force) {
      skipped++;
      continue;
    }
    const text = await extractChapter(ch);
    const paras = splitParagraphs(text);
    if (paras.length === 0) {
      log(`  ! Ch.${ch.episode}: extracted no text (${ch.format}) — skipping`);
      continue;
    }
    fs.writeFileSync(out, text);

    // Preserve any prior translation meta; refresh source fields.
    const prev = readMeta(bookDir, ch.episode) ?? ({} as any);
    writeMeta(bookDir, {
      ...prev,
      episode: ch.episode,
      sourceFile: ch.file.split("/").pop()!,
      format: ch.format,
      koChars: text.replace(/\s/g, "").length,
      paragraphs: paras.length,
    });
    done++;
    log(`  ✓ Ch.${ch.episode}: ${paras.length} paras, ${text.replace(/\s/g, "").length} chars (${ch.format})`);
  }
  log(`Extract done: ${done} written, ${skipped} already present (use --force to redo).`);
}
