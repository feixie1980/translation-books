# translation-books

Translate web-novel raws with the Claude API and build **epub** / **pdf** with a
table of contents. The translation direction is per-book (`sourceLang` /
`targetLang` in `book.yaml`) — e.g. **Korean → Simplified Chinese** or
**Chinese → English**.

Each book is a subfolder of `works/`. Source chapters live in `<book>/Raws/`
(one chapter per `.docx`, `.html`, or `.txt` file). Outputs and intermediate
files are source-controlled alongside the raws.

## Layout

```
works/
  <book>/                 # e.g. works/怪谈通勤
    Raws/                 # source: "Ch. 12.docx", "360.html", … (one chapter per file)
    book.yaml             # optional: title, author, langs, title format
    context.yaml          # style + glossary (auto-seeded; edit to pin renderings)
    work/chapters/        # intermediate, cached, git-tracked:
      0012.ko.txt         #   normalized source     (.ko/.zh are fixed labels for
      0012.zh.txt         #   translation            source/target — any language)
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
pnpm book glossary works/怪谈通勤 --only 100-110     # grow it from a later arc

# 3. Translate source -> target  (skips chapters already translated)
pnpm book translate works/怪谈通勤
pnpm book translate works/怪谈通勤 --only 360 --model claude-opus-4-8 --retranslate

# 4. Build epub/pdf with a TOC of translated chapter titles
pnpm book build works/怪谈通勤 --format epub,pdf
pnpm book build works/怪谈通勤 --per-chapter         # also one file per chapter

# Or the whole pipeline at once (first run only — see note below)
pnpm book run works/怪谈通勤
```

## Recommended workflow (translating in batches)

For a long book, translate in batches (e.g. 20 chapters at a time) and keep the
glossary current as new names and concepts appear. **Order matters:** `translate`
loads `context.yaml` once at the start of a run, so a term must be pinned *before*
you translate the chapter it appears in — always run `glossary` (and review it)
before `translate` for each batch.

```sh
# Once, up front — extract everything (no API, free; lets glossary scan any range)
pnpm book extract works/伪像报告

# Then per 20-chapter batch (1-20, then 21-40, …):
pnpm book glossary  works/伪像报告 --only 1-20    # 1. pin this batch's new names first
#   2. REVIEW works/伪像报告/context.yaml — resolve reported conflicts and fix any
#      renderings that fight the style guide. Your edits persist across batches.
pnpm book translate works/伪像报告 --only 1-20    # 3. translate with the current glossary

pnpm book build works/伪像报告                    # build at the end, or periodically
```

The review step is what makes this worthwhile: the glossary *proposes* renderings;
you lock them in. Later batches reuse your pinned terms (the model is shown them and
asked to return only new ones), so a name pinned in batch 1 stays consistent through
the whole book.

> **Don't use `pnpm book run` for batches.** It auto-seeds the glossary *only when
> `context.yaml` is missing*, so from batch 2 onward it would skip the glossary
> update. Use the explicit `glossary → review → translate` loop above instead;
> `run` is for a quick first pass on a fresh book.

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
   (docx/html/txt)   │          src/context.ts   (style + glossary <-> context.yaml)
                     │
              src/util.ts  (config, chapter discovery, paths, cost — used by all)
```

### What each file does

| File | Responsibility |
|------|----------------|
| **`cli.ts`** | Entry point. Defines the `extract` / `glossary` / `translate` / `build` / `run` commands and their flags with `commander`, then calls the matching `runX()`. `run` chains all stages (auto-seeding the glossary if `context.yaml` is missing). |
| **`util.ts`** | Shared foundation used by every stage: loads `book.yaml` (`loadBookConfig`, including `sourceLang`/`targetLang`, title format, and output `lang`/`tocTitle`), discovers source chapters and parses their episode number from the filename (`discoverRawChapters`, `episodeFromFilename`), computes all on-disk paths (`koPath`/`zhPath`/`metaPath`/`outDir`), parses the `--only` filter (`parseOnly`), splits text into paragraphs (`splitParagraphs`), reads/writes per-chapter metadata, and reports token cost (`PRICING`, `estimateCost`). |
| **`sources.ts`** | **Stage 1 parsing.** `extractChapter()` turns one raw file into normalized plain text — `.docx` via `mammoth`, `.html` via `cheerio`, `.txt` read directly (already one paragraph per line, e.g. from `chapter-braker.ts`). The HTML path finds the element with the most direct `<p>` children, takes its (obfuscated) content class, and collects every `<p>` under that class in document order, since KakaoPage splits a chapter across sibling blocks. Strips the `RAW` / "NNN화" header and page chrome. |
| **`extract.ts`** | **Stage 1 driver.** `runExtract()` walks discovered chapters, calls `extractChapter()`, writes the normalized source to `work/chapters/NNN.ko.txt` (the `.ko`/`.zh` suffixes are fixed source/target labels, not language-specific), and records source metadata (char/paragraph counts) to `NNN.meta.json`. Skips files already extracted unless `--force`. |
| **`context.ts`** | The per-book translation context (`context.yaml`): a free-form `style` string plus a `glossary` of source → target term mappings. `loadContext`/`saveContext` read & write the YAML and `buildSystemPrompt(ctx, sourceLang, targetLang)` renders both into the system prompt that pins proper nouns. (Glossary merging now lives in `glossary.ts`.) |
| **`anthropic.ts`** | The only place that talks to the Claude API. `getClient()` constructs the SDK client (requires `ANTHROPIC_API_KEY`); `call()` / `callStream()` make one `messages.create` request with the system prompt sent as a **cache-controlled block** (so the identical style+glossary is billed at the cached rate across calls). `callStream` streams snapshots for live progress. Both wrap the request in `withRetry`, which **waits and retries on rate limits (429), overload (529), transient 5xx, and connection errors** — honoring the `Retry-After` header, otherwise exponential backoff — instead of failing the run. |
| **`glossary.ts`** | **Glossary stage.** `runGlossary()` samples extracted chapters — the first few, or any window via `--only` — and asks the model (via `anthropic.call`) to extract recurring proper nouns as JSON. Already-pinned terms are shown to the model so it returns only *new* ones; the merge (keyed on the source term) adds new terms, fills in missing renderings, and **reports conflicts** rather than overwriting a pinned rendering (`--force` adopts the model's). Lets the glossary evolve across a long book without clobbering edits. |
| **`translate.ts`** | **Stage 3.** `runTranslate()` reads `NNN.ko.txt`, groups paragraphs into batches under a source-character budget (`batchByChars`), and sends each batch as numbered lines with the `context.ts` system prompt (built from the book's `sourceLang`/`targetLang`). Batches **stream** (`callStream`) and run through a **bounded concurrency pool** (`runPool`, `--concurrency`, default 4), with aggregate live progress. Responses are matched back by line number so paragraph structure is preserved **1:1** (a dropped paragraph falls back to the source). Writes `NNN.zh.txt` and updates `NNN.meta.json` with model + token usage. Skips chapters already translated unless `--retranslate`. |
| **`build.ts`** | **Stage 4.** `runBuild()` collects translated chapters (ordered by episode), renders each as HTML, and emits **epub** (`epub-gen-memory`) and/or **pdf** (a single HTML doc with an anchored TOC, printed via headless Chrome through `puppeteer`). The TOC heading (`tocTitle`) and output `lang` come from `book.yaml`; chapter titles are either `titleFormat` (`第N话`) or, with `titleFromFirstLine`, each chapter's translated first line. `--per-chapter` also writes one file per chapter under `out/chapters/`. |

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
- **Content filtering:** if the API blocks a batch's output ("Output blocked by
  content filtering policy" — common in horror/violent prose), `translate`
  doesn't abort. It bisects the batch to translate the clean paragraphs and
  isolates the offending one(s) down to single paragraphs, which **fall back to
  the source text**. Blocked paragraph numbers are logged and recorded in
  `NNN.meta.json` (`blockedParas`) so you can hand-translate them. The filter is
  somewhat non-deterministic, so a `--retranslate` re-run may clear it.
- **Titles:** `titleFormat` (e.g. `第{n}话`) when raws have no descriptive
  headings. If a raw keeps its heading as the first line (e.g. `第1章 …` from
  `chapter-braker.ts`), set `titleFromFirstLine: true` in `book.yaml` to use the
  translated first line as the chapter title in the TOC and drop it from the body.
- **Output language:** `lang` (BCP-47) and `tocTitle` default from `targetLang`
  (`English` → `en` / "Contents", otherwise `zh` / "目录"); override in `book.yaml`.

## context.yaml

Keeps proper nouns consistent across chapters. `glossary` entries pin a source
term to a fixed target-language rendering; `style` is free-form guidance injected
into the translation system prompt. `glossary` auto-seeds proper nouns it finds,
but **review the renderings** before a full translation run.

### Evolving the glossary

New characters and concepts appear deeper into a long book, so the glossary is
designed to grow without clobbering your edits:

- `pnpm book glossary <book> --only 100-110` samples any chapter window (the
  whole range by default; cap with `--chapters`). Re-run it on later arcs as the
  story introduces new terms.
- The **already-pinned terms are shown to the model**, which is asked to reuse
  them verbatim and return only *new* terms — so re-runs don't duplicate or
  re-render what you already have.
- The merge is keyed on the source term: new terms are **added**, known terms
  with no rendering are **filled in**, and if the model proposes a *different*
  rendering for a pinned term it's reported as a **conflict** and your value is
  kept (re-run with `--force` to adopt the model's, or edit by hand). One entry
  per source term — no duplicates, no silently overwritten renderings.
