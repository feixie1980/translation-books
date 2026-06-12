/**
 * util.ts — shared helpers: paths, config, chapter discovery, cost reporting.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// ---- Models / pricing -----------------------------------------------------
export const DEFAULT_MODEL = "claude-opus-4-8";

// $ per 1M tokens: [input, output]. Used for the after-run cost report.
export const PRICING: Record<string, [number, number]> = {
  "claude-opus-4-8": [5.0, 25.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],
};

export function estimateCost(model: string, inTok: number, outTok: number): number {
  const [pin, pout] = PRICING[model] ?? [0, 0];
  return (inTok / 1e6) * pin + (outTok / 1e6) * pout;
}

// ---- Book config ----------------------------------------------------------
export interface BookConfig {
  title: string;
  author?: string;
  sourceLang: string;
  targetLang: string;
  /** e.g. "第{n}话" — {n} is replaced with the episode number. */
  titleFormat: string;
}

export function loadBookConfig(bookDir: string): BookConfig {
  const cfgPath = path.join(bookDir, "book.yaml");
  const defaults: BookConfig = {
    title: path.basename(path.resolve(bookDir)),
    sourceLang: "Korean",
    targetLang: "Simplified Chinese",
    titleFormat: "第{n}话",
  };
  if (!fs.existsSync(cfgPath)) return defaults;
  const raw = (yaml.load(fs.readFileSync(cfgPath, "utf-8")) ?? {}) as Partial<BookConfig>;
  return { ...defaults, ...raw };
}

export function chapterTitle(cfg: BookConfig, episode: number): string {
  return cfg.titleFormat.replace("{n}", String(episode));
}

// ---- Paths ----------------------------------------------------------------
export function rawsDir(bookDir: string): string {
  return path.join(bookDir, "Raws");
}
export function workChaptersDir(bookDir: string): string {
  return path.join(bookDir, "work", "chapters");
}
export function outDir(bookDir: string): string {
  return path.join(bookDir, "out");
}
export function contextPath(bookDir: string): string {
  return path.join(bookDir, "context.yaml");
}
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Zero-padded chapter id for stable filename sorting, e.g. 5 -> "0005". */
export function pad(episode: number): string {
  return String(episode).padStart(4, "0");
}

// ---- Source chapter discovery ---------------------------------------------
export interface RawChapter {
  episode: number;
  file: string; // absolute path
  format: "docx" | "html";
}

/**
 * Parse an episode number from a Raws filename.
 *   "Ch. 12.docx" -> 12      "360.html" -> 360
 * Returns null if no number is found.
 */
export function episodeFromFilename(file: string): number | null {
  const base = path.basename(file);
  const m = base.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** List source chapters in Raws, sorted by episode number ascending. */
export function discoverRawChapters(bookDir: string): RawChapter[] {
  const dir = rawsDir(bookDir);
  if (!fs.existsSync(dir)) throw new Error(`No Raws folder at ${dir}`);
  const out: RawChapter[] = [];
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    if (ext !== ".docx" && ext !== ".html" && ext !== ".htm") continue;
    if (name.startsWith("~$")) continue; // Word lock files
    const episode = episodeFromFilename(name);
    if (episode === null) continue;
    out.push({
      episode,
      file: path.join(dir, name),
      format: ext === ".docx" ? "docx" : "html",
    });
  }
  out.sort((a, b) => a.episode - b.episode);
  return out;
}

/** Parse a --only "1,2,360" / "1-5,360" filter into a Set, or null for all. */
export function parseOnly(only?: string): Set<number> | null {
  if (!only) return null;
  const set = new Set<number>();
  for (const part of only.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) set.add(n);
    }
  }
  return set;
}

// ---- Normalized chapter on disk -------------------------------------------
export interface ChapterMeta {
  episode: number;
  sourceFile: string;
  format: string;
  koChars: number;
  paragraphs: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  translatedAt?: string;
}

export function koPath(bookDir: string, episode: number): string {
  return path.join(workChaptersDir(bookDir), `${pad(episode)}.ko.txt`);
}
export function zhPath(bookDir: string, episode: number): string {
  return path.join(workChaptersDir(bookDir), `${pad(episode)}.zh.txt`);
}
export function metaPath(bookDir: string, episode: number): string {
  return path.join(workChaptersDir(bookDir), `${pad(episode)}.meta.json`);
}

export function readMeta(bookDir: string, episode: number): ChapterMeta | null {
  const p = metaPath(bookDir, episode);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ChapterMeta;
}
export function writeMeta(bookDir: string, meta: ChapterMeta): void {
  fs.writeFileSync(metaPath(bookDir, meta.episode), JSON.stringify(meta, null, 2));
}

/** Split normalized chapter text into paragraphs (blank-line separated). */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function log(msg: string): void {
  process.stdout.write(msg + "\n");
}
