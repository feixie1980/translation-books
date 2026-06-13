# translation-books

Translate web-novel raws (currently **Korean → Simplified Chinese**) with the
Claude API and build **epub** / **pdf** with a table of contents.

Each book is a subfolder of `works/`. Source chapters live in `<book>/Raws/`
(one chapter per `.docx` or `.html` file). Outputs and intermediate files are
source-controlled alongside the raws.

## Layout

```
works/
  <book>/                 # e.g. works/怪谈通勤
    Raws/                 # source: "Ch. 12.docx", "360.html", … (one chapter per file)
    book.yaml             # optional: title, author, langs, title format
    context.yaml          # style + glossary (auto-seeded; edit to pin renderings)
    work/chapters/        # intermediate, cached, git-tracked:
      0012.ko.txt         #   normalized Korean source
      0012.zh.txt         #   Chinese translation
      0012.meta.json      #   per-chapter metadata (model, tokens, …)
    out/
      <title>.epub
      <title>.pdf
      chapters/           # with --per-chapter
```

Chapters are identified by **episode number**, parsed from the filename
(`Ch. 12.docx` → 12, `360.html` → 360) and ordered numerically. Gaps are fine.

## Setup

```sh
pnpm install
pnpm exec puppeteer browsers install chrome   # one-time: Chromium for PDF
export ANTHROPIC_API_KEY=sk-ant-...            # for glossary + translate
```

## Usage

```sh
# 1. Raws -> normalized text  (no API)
pnpm book extract works/怪谈通勤
pnpm book extract works/怪谈通勤 --only 1,2,360      # subset; --force to redo

# 2. Auto-seed the glossary from a few chapters (edit context.yaml after)
pnpm book glossary works/怪谈通勤 --chapters 5

# 3. Translate KO -> ZH  (skips chapters already translated)
pnpm book translate works/怪谈通勤
pnpm book translate works/怪谈通勤 --only 360 --model claude-opus-4-8 --retranslate

# 4. Build epub/pdf with a TOC of translated chapter titles
pnpm book build works/怪谈通勤 --format epub,pdf
pnpm book build works/怪谈通勤 --per-chapter         # also one file per chapter

# Or the whole pipeline at once
pnpm book run works/怪谈通勤
```

### Splitting a single .txt into chapters

`src/chapter-braker.ts` is a standalone helper (separate from the pipeline
above) that breaks one combined `.txt` into one file per chapter:

```sh
npx tsx src/chapter-braker.ts works/伪像报告/Raws/test.txt --pattern "第1章"
```

- **Input:** one `.txt` file. **Output:** an `out/` folder next to it (cleared
  if it already exists), containing `001.txt`, `002.txt`, … Zero-padding width
  is derived from the chapter count (2 chapters → `1.txt`; 150 → `001.txt`).
- **`--pattern`** is a *sample heading* whose digit runs are treated as
  wildcards, so `第1章` matches `第1章`, `第2章`, `第42章`, … Different files can
  use different samples. Add `--regex` to pass a raw regular expression instead.
- Text before the first heading (title / author / intro) is saved to `000.txt`.

## Code architecture

The tool is a small TypeScript CLI run with `tsx` (no build step). All sources
live in `src/`. The pipeline is **four stages**, each a command that reads from
and writes to disk, so any stage can run independently and is skipped when its
output already exists (re-run freely; use `--force`/`--retranslate` to redo).

```
                 src/cli.ts  (commander: parses args, dispatches)
                     │
   extract ──────────┼───────── glossary ──── translate ──────── build
   runExtract()      │          runGlossary()  runTranslate()     runBuild()
   src/extract.ts    │          src/glossary.ts src/translate.ts  src/build.ts
        │            │               │              │                  │
   src/sources.ts    │          src/anthropic.ts (Claude API client + prompt cache)
   (docx/html parse) │          src/context.ts   (style + glossary <-> context.yaml)
                     │
              src/util.ts  (config, chapter discovery, paths, cost — used by all)
```

### What each file does

| File | Responsibility |
|------|----------------|
| **`cli.ts`** | Entry point. Defines the `extract` / `glossary` / `translate` / `build` / `run` commands and their flags with `commander`, then calls the matching `runX()`. `run` chains all stages (auto-seeding the glossary if `context.yaml` is missing). |
| **`util.ts`** | Shared foundation used by every stage: loads `book.yaml` (`loadBookConfig`), discovers source chapters and parses their episode number from the filename (`discoverRawChapters`, `episodeFromFilename`), computes all on-disk paths (`koPath`/`zhPath`/`metaPath`/`outDir`), parses the `--only` filter (`parseOnly`), splits text into paragraphs (`splitParagraphs`), reads/writes per-chapter metadata, and reports token cost (`PRICING`, `estimateCost`). |
| **`sources.ts`** | **Stage 1 parsing.** `extractChapter()` turns one raw file into normalized plain text — `.docx` via `mammoth`, `.html` via `cheerio`. The HTML path finds the element with the most direct `<p>` children, takes its (obfuscated) content class, and collects every `<p>` under that class in document order, since KakaoPage splits a chapter across sibling blocks. Strips the `RAW` / "NNN화" header and page chrome. |
| **`extract.ts`** | **Stage 1 driver.** `runExtract()` walks discovered chapters, calls `extractChapter()`, writes `work/chapters/NNN.ko.txt`, and records source metadata (char/paragraph counts) to `NNN.meta.json`. Skips files already extracted unless `--force`. |
| **`context.ts`** | The per-book translation context (`context.yaml`): a free-form `style` string plus a `glossary` of `ko → zh` term mappings. `loadContext`/`saveContext` read & write the YAML, `mergeGlossary` adds new terms without clobbering edited renderings, and `buildSystemPrompt` renders both into the system prompt that pins proper nouns. |
| **`anthropic.ts`** | The only place that talks to the Claude API. `getClient()` constructs the SDK client (requires `ANTHROPIC_API_KEY`); `call()` / `callStream()` make one `messages.create` request with the system prompt sent as a **cache-controlled block** (so the identical style+glossary is billed at the cached rate across calls). `callStream` streams snapshots for live progress. Both wrap the request in `withRetry`, which **waits and retries on rate limits (429), overload (529), transient 5xx, and connection errors** — honoring the `Retry-After` header, otherwise exponential backoff — instead of failing the run. |
| **`glossary.ts`** | **Glossary stage.** `runGlossary()` samples the first few extracted chapters, asks the model (via `anthropic.call`) to extract recurring proper nouns as JSON, merges them into `context.yaml`. Runs entirely from the CLI so new books don't need a manual glossary to start. |
| **`translate.ts`** | **Stage 3.** `runTranslate()` reads `NNN.ko.txt`, groups paragraphs into batches under a source-character budget (`batchByChars`), and sends each batch as numbered lines with the `context.ts` system prompt. Batches **stream** (`callStream`) and run through a **bounded concurrency pool** (`runPool`, `--concurrency`, default 4), with aggregate live progress. Responses are matched back by line number so paragraph structure is preserved **1:1** (a dropped paragraph falls back to the source). Writes `NNN.zh.txt` and updates `NNN.meta.json` with model + token usage. Skips chapters already translated unless `--retranslate`. |
| **`build.ts`** | **Stage 4.** `runBuild()` collects translated chapters (ordered by episode), renders each as HTML, and emits **epub** (`epub-gen-memory`, with a `目录` TOC of `第N话` titles) and/or **pdf** (a single HTML doc with an anchored TOC, printed via headless Chrome through `puppeteer`). `--per-chapter` also writes one file per chapter under `out/chapters/`. |

### Data flow on disk

```
Raws/Ch.12.docx ──extract──▶ work/chapters/0012.ko.txt ──translate──▶ work/chapters/0012.zh.txt
Raws/360.html   ──extract──▶ work/chapters/0360.ko.txt        │                    │
                                   │                          │                    ▼
                                   └──────glossary───▶ context.yaml ──▶ (translate system prompt)
                                                                                   │
                                            work/chapters/NNN.zh.txt ──build──▶ out/<title>.{epub,pdf}
```

Each `NNN.meta.json` carries the episode number, source file/format, char &
paragraph counts, and (after translation) the model and token usage. All of
`work/` and `out/` is git-tracked, so translations and outputs are versioned
alongside the raws.

## Defaults

- **Model:** `claude-sonnet-4-6` (override per command with `--model`, e.g.
  `--model claude-opus-4-8` for top quality). Roughly $0.13 per ~5k-char chapter
  on Sonnet (~$0.21 on Opus); the style+glossary system prompt is prompt-cached.
- **Caching:** every stage skips work already on disk; re-run freely. Use
  `--force` (extract) / `--retranslate` (translate) to redo.
- **Speed:** translation streams responses (live per-paragraph progress) and
  runs up to 4 batches in parallel. Tune with `--concurrency <n>` (e.g. `1` to
  serialize, higher to go faster if your API rate limit allows).
- **Rate limits:** API calls automatically wait and retry on `429`/overload/
  transient errors (honoring `Retry-After`), so a run keeps going instead of
  dying. If you hit limits often, lower `--concurrency`.
- **Titles:** `第{n}话` (the Korean raws have no descriptive chapter titles).

## context.yaml

Keeps proper nouns consistent across chapters. `glossary` entries pin a source
term to a fixed Chinese rendering; `style` is free-form guidance injected into
the translation system prompt. `glossary` auto-seeds proper nouns it finds, but
**review the `zh` values** before a full translation run.
