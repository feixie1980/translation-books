/**
 * sources.ts — turn a raw .docx / .html chapter into normalized plain text.
 *
 * Output is one paragraph per line, blank lines dropped. The series-name /
 * "NNN화" header line that both formats carry is stripped, since we render
 * titles ourselves ("第N话").
 */
import fs from "node:fs";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import type { RawChapter } from "./util.js";

/** Lines that are page chrome / source headers rather than chapter prose. */
function isBoilerplate(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t === "RAW") return true;
  // Series header lines like "괴담에 떨어져도 출근을 해야 하는구나 360화"
  if (/\d+\s*화\s*$/.test(t) && t.length < 60) return true;
  // KakaoPage chrome occasionally leaks in
  if (/카카오페이지/.test(t)) return true;
  return false;
}

function normalize(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/ /g, " ").trim();
    if (isBoilerplate(line)) continue;
    out.push(line);
  }
  return out.join("\n") + "\n";
}

async function extractDocx(file: string): Promise<string> {
  const { value } = await mammoth.extractRawText({ path: file });
  return normalize(value.split(/\r?\n/));
}

/**
 * Plain-text chapters (e.g. produced by chapter-braker.ts): already one
 * paragraph per line. `normalize` trims leading full-width indents (　　) and
 * drops blank lines; the per-language boilerplate filters are no-ops here.
 */
function extractTxt(file: string): string {
  const text = fs.readFileSync(file, "utf-8");
  return normalize(text.split(/\r?\n/));
}

function extractHtml(file: string): string {
  const html = fs.readFileSync(file, "utf-8");
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();

  // KakaoPage splits a chapter across several sibling content blocks that share
  // an (obfuscated) class, e.g. <div class="DC2CN">. Find the element with the
  // most direct <p> children, take its content class, then collect every <p>
  // under any element with that class — in document order.
  let bestEl: any = null;
  let bestCount = 0;
  $("*").each((_, el) => {
    const n = $(el).children("p").length;
    if (n > bestCount) {
      bestCount = n;
      bestEl = el;
    }
  });

  const lines: string[] = [];
  const dominantClass = bestEl
    ? (bestEl.attribs?.class ?? "").split(/\s+/).filter(Boolean)[0]
    : undefined;

  if (dominantClass) {
    $(`[class~="${dominantClass}"] p`).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    });
  }

  // Fallbacks: all <p>, then raw body text split on newlines.
  if (lines.length === 0) {
    $("body p").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    });
  }
  if (lines.length === 0) {
    for (const part of $("body").text().split(/\n+/)) {
      const t = part.trim();
      if (t) lines.push(t);
    }
  }
  return normalize(lines);
}

export async function extractChapter(ch: RawChapter): Promise<string> {
  if (ch.format === "docx") return extractDocx(ch.file);
  if (ch.format === "txt") return extractTxt(ch.file);
  return extractHtml(ch.file);
}
