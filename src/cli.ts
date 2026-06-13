#!/usr/bin/env -S npx tsx
/**
 * cli.ts — Korean -> Chinese web-novel translator.
 *
 *   book-translate extract   <book> [--only 1,2,360] [--force]
 *   book-translate glossary  <book> [--chapters 5] [--model …] [--force]
 *   book-translate translate <book> [--only …] [--model …] [--retranslate]
 *   book-translate build     <book> [--format epub,pdf] [--per-chapter] [--only …]
 *   book-translate run       <book> [--model …] [--format …] [--per-chapter]
 *
 * <book> is the book's folder (e.g. "怪谈通勤"), containing a Raws/ subfolder.
 * Set ANTHROPIC_API_KEY for glossary/translate.
 */
import { Command } from "commander";
import fs from "node:fs";
import { runExtract } from "./extract.js";
import { runGlossary } from "./glossary.js";
import { runTranslate } from "./translate.js";
import { runBuild } from "./build.js";
import { DEFAULT_MODEL, log } from "./util.js";

function assertBook(dir: string): void {
  if (!fs.existsSync(dir)) {
    console.error(`error: no such book folder: ${dir}`);
    process.exit(1);
  }
}

const program = new Command();
program
  .name("book-translate")
  .description("Translate web-novel raws (Korean -> Chinese) and build epub/pdf.");

program
  .command("extract")
  .argument("<book>", "book folder containing a Raws/ subfolder")
  .option("--only <list>", "limit to episodes, e.g. 1,2,360 or 1-5,360")
  .option("--force", "re-extract even if NNN.ko.txt exists")
  .action(async (book, opts) => {
    assertBook(book);
    await runExtract(book, opts);
  });

program
  .command("glossary")
  .argument("<book>", "book folder")
  .option("--only <list>", "sample these episodes, e.g. 100-110 (default: first --chapters)")
  .option("--chapters <n>", "how many chapters to sample", (v) => parseInt(v, 10))
  .option("--model <id>", `model (default ${DEFAULT_MODEL})`)
  .option("--force", "adopt the model's rendering when it differs from a pinned one")
  .action(async (book, opts) => {
    assertBook(book);
    await runGlossary(book, opts);
  });

program
  .command("translate")
  .argument("<book>", "book folder")
  .option("--only <list>", "limit to episodes, e.g. 1,2,360 or 1-5,360")
  .option("--model <id>", `model (default ${DEFAULT_MODEL})`)
  .option("--retranslate", "re-translate even if NNN.zh.txt exists")
  .option("--batch-chars <n>", "source chars per API call", (v) => parseInt(v, 10))
  .option("--concurrency <n>", "batches translated in parallel (default 4)", (v) => parseInt(v, 10))
  .action(async (book, opts) => {
    assertBook(book);
    await runTranslate(book, {
      ...opts,
      batchChars: opts.batchChars,
      concurrency: opts.concurrency,
    });
  });

program
  .command("build")
  .argument("<book>", "book folder")
  .option("--format <list>", "epub, pdf, or epub,pdf", "epub,pdf")
  .option("--per-chapter", "also emit one file per chapter")
  .option("--only <list>", "limit to episodes")
  .action(async (book, opts) => {
    assertBook(book);
    await runBuild(book, opts);
  });

program
  .command("run")
  .description("extract -> glossary (if missing) -> translate -> build")
  .argument("<book>", "book folder")
  .option("--only <list>", "limit to episodes")
  .option("--model <id>", `model (default ${DEFAULT_MODEL})`)
  .option("--format <list>", "epub, pdf, or epub,pdf", "epub,pdf")
  .option("--per-chapter", "also emit one file per chapter")
  .option("--retranslate", "re-translate even if NNN.zh.txt exists")
  .action(async (book, opts) => {
    assertBook(book);
    log("== extract ==");
    await runExtract(book, { only: opts.only });
    if (!fs.existsSync(`${book}/context.yaml`)) {
      log("== glossary (auto-seed) ==");
      await runGlossary(book, { model: opts.model });
    }
    log("== translate ==");
    await runTranslate(book, { only: opts.only, model: opts.model, retranslate: opts.retranslate });
    log("== build ==");
    await runBuild(book, { only: opts.only, format: opts.format, perChapter: opts.perChapter });
  });

program.parseAsync().catch((e) => {
  console.error("error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
