#!/usr/bin/env -S npx tsx
/**
 * chapter-braker.ts — split a single .txt into one file per chapter.
 *
 *   tsx src/chapter-braker.ts <file.txt> [--pattern "第1章"]
 *
 * The chapter pattern is a *sample heading*: every run of digits in it is
 * treated as a wildcard, so "第1章" matches "第1章 …", "第2章 …", "第42章 …".
 * Pass --regex to interpret the pattern as a raw regular expression instead.
 *
 * Output: an "out" folder next to <file.txt>, containing 001.txt, 002.txt, …
 * Zero-padding width is derived from the total chapter count. Any text before
 * the first chapter heading (title, author, intro) is written to 000.txt.
 */
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a per-line chapter-heading matcher from the pattern. By default the
 * pattern is a sample heading whose digit runs become `\d+`; with `raw` the
 * pattern is used as-is.
 */
function buildMatcher(pattern: string, raw: boolean): RegExp {
  if (raw) return new RegExp(pattern);
  const body = pattern
    .split(/\d+/)
    .map(escapeRegExp)
    .join("\\d+");
  // Allow leading whitespace (full-width spaces included) before the heading.
  return new RegExp("^[\\s\\u3000]*" + body);
}

function main(): void {
  const program = new Command();
  program
    .name("chapter-braker")
    .description("Split a .txt into one file per chapter.")
    .argument("<file>", "the .txt file to split")
    .option(
      "-p, --pattern <pattern>",
      'chapter heading sample; digits are wildcards (e.g. "第1章")',
      "第1章",
    )
    .option("--regex", "treat --pattern as a raw regular expression", false)
    .parse();

  const file = program.args[0];
  const opts = program.opts<{ pattern: string; regex: boolean }>();

  if (!fs.existsSync(file)) {
    console.error(`error: no such file: ${file}`);
    process.exit(1);
  }

  const matcher = buildMatcher(opts.pattern, opts.regex);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  // Find the line index where each chapter starts.
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (matcher.test(line)) starts.push(i);
  });

  if (starts.length === 0) {
    console.error(
      `error: no chapter headings matched ${matcher} in ${path.basename(file)}`,
    );
    process.exit(1);
  }

  // Slice [start, nextStart) for each chapter; preamble is [0, firstStart).
  type Segment = { index: number; lines: string[] };
  const segments: Segment[] = [];

  const preamble = lines.slice(0, starts[0]);
  if (preamble.join("").trim().length > 0) {
    segments.push({ index: 0, lines: preamble });
  }

  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    segments.push({ index: i + 1, lines: lines.slice(start, end) });
  });

  const outDir = path.join(path.dirname(file), "out");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Pad width depends on the number of chapters (e.g. 2 -> 1, 150 -> 3).
  const width = String(starts.length).length;

  for (const seg of segments) {
    const name = String(seg.index).padStart(width, "0") + ".txt";
    const content = seg.lines.join("\n").replace(/\s+$/, "") + "\n";
    fs.writeFileSync(path.join(outDir, name), content, "utf8");
  }

  console.log(
    `Wrote ${starts.length} chapter(s)` +
      (segments.length > starts.length ? " + preamble (000.txt)" : "") +
      ` to ${outDir}`,
  );
}

main();
