# translation-books

Translate web-novel raws (currently **Korean → Simplified Chinese**) with the
Claude API and build **epub** / **pdf** with a table of contents.

Each book is a subfolder of this repo. Source chapters live in `<book>/Raws/`
(one chapter per `.docx` or `.html` file). Outputs and intermediate files are
source-controlled alongside the raws.

## Layout

```
<book>/
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
pnpm book extract 怪谈通勤
pnpm book extract 怪谈通勤 --only 1,2,360      # subset; --force to redo

# 2. Auto-seed the glossary from a few chapters (edit context.yaml after)
pnpm book glossary 怪谈通勤 --chapters 5

# 3. Translate KO -> ZH  (skips chapters already translated)
pnpm book translate 怪谈通勤
pnpm book translate 怪谈通勤 --only 360 --model claude-opus-4-8 --retranslate

# 4. Build epub/pdf with a TOC of translated chapter titles
pnpm book build 怪谈通勤 --format epub,pdf
pnpm book build 怪谈通勤 --per-chapter         # also one file per chapter

# Or the whole pipeline at once
pnpm book run 怪谈通勤
```

## Defaults

- **Model:** `claude-opus-4-8` (override per command with `--model`). Roughly
  $0.19 per ~5k-char chapter; the style+glossary system prompt is prompt-cached.
- **Caching:** every stage skips work already on disk; re-run freely. Use
  `--force` (extract) / `--retranslate` (translate) to redo.
- **Titles:** `第{n}话` (the Korean raws have no descriptive chapter titles).

## context.yaml

Keeps proper nouns consistent across chapters. `glossary` entries pin a source
term to a fixed Chinese rendering; `style` is free-form guidance injected into
the translation system prompt. `glossary` auto-seeds proper nouns it finds, but
**review the `zh` values** before a full translation run.
