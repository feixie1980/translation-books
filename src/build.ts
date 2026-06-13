/**
 * build.ts — Stage 3: assemble translated chapters into epub and/or pdf.
 *
 * Output goes to <book>/out/. Combined book by default; --per-chapter also
 * emits one file per chapter under out/chapters/. The table of contents uses
 * the translated chapter titles ("第N话").
 */
import fs from "node:fs";
import path from "node:path";
import epubModule from "epub-gen-memory";
import puppeteer from "puppeteer";

// epub-gen-memory ships as CJS; under ESM interop the callable default may be
// nested one level deep. Resolve to the actual function either way.
const generateEpub = (
  typeof epubModule === "function" ? epubModule : (epubModule as any).default
) as (options: any, content: any[]) => Promise<Buffer>;
import {
  loadBookConfig,
  chapterTitle,
  zhPath,
  outDir,
  ensureDir,
  discoverRawChapters,
  parseOnly,
  splitParagraphs,
  pad,
  log,
  BookConfig,
} from "./util.js";

export interface BuildOpts {
  only?: string;
  format?: string; // "epub", "pdf", or "epub,pdf"
  perChapter?: boolean;
}

interface Chapter {
  episode: number;
  title: string;
  paras: string[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chapterBodyHtml(ch: Chapter): string {
  return ch.paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

function collectChapters(bookDir: string, cfg: BookConfig, only?: string): Chapter[] {
  const filter = parseOnly(only);
  const episodes = discoverRawChapters(bookDir)
    .map((c) => c.episode)
    .filter((ep) => !filter || filter.has(ep))
    .filter((ep) => fs.existsSync(zhPath(bookDir, ep)));
  return episodes.map((ep) => {
    const paras = splitParagraphs(fs.readFileSync(zhPath(bookDir, ep), "utf-8"));
    if (cfg.titleFromFirstLine && paras.length > 0) {
      // First paragraph is the translated chapter heading; use it as the title.
      return { episode: ep, title: paras[0], paras: paras.slice(1) };
    }
    return { episode: ep, title: chapterTitle(cfg, ep), paras };
  });
}

const PRINT_CSS = `
  body { font-family: "Songti SC", "Source Han Serif SC", "PingFang SC", serif;
         line-height: 1.8; font-size: 16px; }
  h1.book-title { text-align: center; margin: 2em 0; }
  h2.chapter { margin: 1.6em 0 0.8em; page-break-before: always; font-size: 1.3em; }
  p { margin: 0.6em 0; text-indent: 2em; }
  nav.toc { page-break-after: always; }
  nav.toc h2 { text-align: center; }
  nav.toc ol { list-style: none; padding: 0; }
  nav.toc li { margin: 0.4em 0; }
  nav.toc a { text-decoration: none; color: inherit; }
`;

// ---- EPUB -----------------------------------------------------------------
async function buildEpub(bookDir: string, cfg: BookConfig, chapters: Chapter[]): Promise<void> {
  const content = chapters.map((ch) => ({
    title: ch.title,
    content: chapterBodyHtml(ch),
  }));
  const buf = await generateEpub(
    {
      title: cfg.title,
      author: cfg.author ?? "",
      lang: cfg.lang,
      tocTitle: cfg.tocTitle,
      css: PRINT_CSS,
      ignoreFailedDownloads: true,
    },
    content,
  );
  const out = path.join(outDir(bookDir), `${cfg.title}.epub`);
  fs.writeFileSync(out, buf);
  log(`  ✓ epub -> ${out} (${chapters.length} chapters)`);
}

// ---- PDF ------------------------------------------------------------------
function bookHtml(cfg: BookConfig, chapters: Chapter[]): string {
  const toc = chapters
    .map((ch) => `<li><a href="#ch-${pad(ch.episode)}">${escapeHtml(ch.title)}</a></li>`)
    .join("\n");
  const body = chapters
    .map(
      (ch) =>
        `<h2 class="chapter" id="ch-${pad(ch.episode)}">${escapeHtml(ch.title)}</h2>\n${chapterBodyHtml(ch)}`,
    )
    .join("\n");
  return `<!doctype html><html lang="${cfg.lang}"><head><meta charset="utf-8">
<title>${escapeHtml(cfg.title)}</title><style>${PRINT_CSS}</style></head>
<body>
<h1 class="book-title">${escapeHtml(cfg.title)}</h1>
<nav class="toc"><h2>${escapeHtml(cfg.tocTitle)}</h2><ol>${toc}</ol></nav>
${body}
</body></html>`;
}

function singleChapterHtml(cfg: BookConfig, ch: Chapter): string {
  return `<!doctype html><html lang="${cfg.lang}"><head><meta charset="utf-8">
<title>${escapeHtml(cfg.title)} — ${escapeHtml(ch.title)}</title><style>${PRINT_CSS}</style></head>
<body><h2 class="chapter" style="page-break-before:auto">${escapeHtml(ch.title)}</h2>
${chapterBodyHtml(ch)}</body></html>`;
}

async function renderPdf(html: string, outPath: string): Promise<void> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="width:100%;text-align:center;font-size:9px;color:#888;"><span class="pageNumber"></span></div>',
    });
  } finally {
    await browser.close();
  }
}

async function buildPdf(bookDir: string, cfg: BookConfig, chapters: Chapter[]): Promise<void> {
  const out = path.join(outDir(bookDir), `${cfg.title}.pdf`);
  await renderPdf(bookHtml(cfg, chapters), out);
  log(`  ✓ pdf  -> ${out} (${chapters.length} chapters)`);
}

// ---- Per-chapter ----------------------------------------------------------
async function buildPerChapter(
  bookDir: string,
  cfg: BookConfig,
  chapters: Chapter[],
  formats: Set<string>,
): Promise<void> {
  const dir = path.join(outDir(bookDir), "chapters");
  ensureDir(dir);
  for (const ch of chapters) {
    const base = path.join(dir, pad(ch.episode));
    if (formats.has("epub")) {
      const buf = await generateEpub(
        { title: `${cfg.title} ${ch.title}`, author: cfg.author ?? "", lang: cfg.lang, css: PRINT_CSS },
        [{ title: ch.title, content: chapterBodyHtml(ch) }],
      );
      fs.writeFileSync(`${base}.epub`, buf);
    }
    if (formats.has("pdf")) {
      await renderPdf(singleChapterHtml(cfg, ch), `${base}.pdf`);
    }
  }
  log(`  ✓ per-chapter -> ${dir} (${chapters.length} × ${[...formats].join("+")})`);
}

export async function runBuild(bookDir: string, opts: BuildOpts): Promise<void> {
  const cfg = loadBookConfig(bookDir);
  ensureDir(outDir(bookDir));
  const formats = new Set(
    (opts.format ?? "epub,pdf").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const chapters = collectChapters(bookDir, cfg, opts.only);
  if (chapters.length === 0) {
    log("No translated chapters to build. Run `translate` first.");
    return;
  }
  log(`Building "${cfg.title}" from ${chapters.length} translated chapter(s): ${[...formats].join(", ")}`);

  if (formats.has("epub")) await buildEpub(bookDir, cfg, chapters);
  if (formats.has("pdf")) await buildPdf(bookDir, cfg, chapters);
  if (opts.perChapter) await buildPerChapter(bookDir, cfg, chapters, formats);
  log("Build done.");
}
