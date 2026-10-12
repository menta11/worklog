# worklog

A Claude Code skill that reconstructs your workday from traces you already left behind — session logs, Git commits, and document changes — then turns them into daily reports and weekly summaries.

> 🌐 English | [简体中文](README.zh-CN.md)

## The Problem

The hardest part of writing a daily report isn't the writing — it's the remembering.

But the answers are already on your machine: what you said to the AI, what you committed, what documents you touched. Especially the numbers you jotted down in passing ("24 issues", "135s → 56s") — you won't recall them afterward, but they sit untouched in commit messages and document titles.

## The Solution

**worklog** gathers those traces, filters out the noise, lays them out on a timeline, and hands them to the AI to distill into structured output.

The material contains only facts, never conclusions — what's worth recording and how to phrase it is the AI's call.

## Commands

| Command | What it does |
|---------|-------------|
| `/worklog` | Capture today — daily report + keyframes |
| `/worklog -week` | Generate this week's report (fills in today first if missing) |
| `/worklog --backfill 26.10.8-26.10.10` | Recover a historical date range — keyframes only |

## Results

Measured on a single real workday:

| Metric | Result |
|--------|-------------|
| Extraction time | **~2.7 s** |
| Local repos scanned | 23 |
| Traces recovered | 10 commits / 62 user prompts / 38 documents |

More telling is the **reverse check**: the keyframes written by hand that day missed an entire block of work — worklog reconstructed it in full from the traces. Humans forget; traces don't.

## Installation

Copy the `worklog/` directory into your skills directory:

- **Claude Code**: `~/.claude/skills/`

On first run the skill walks you through configuration: your working directories, Git identity, and where to store the data.

### Using your own report format

`reference/` holds the output format templates. Drop your own template — or just a few of your past daily reports — into that directory and it takes precedence over the defaults. Whatever you add there is yours; add it to `.gitignore`.

## Structure

```
worklog/
├── SKILL.md            # Main skill file
├── reference/          # Output format templates (daily / weekly)
└── scripts/
    └── extract.mjs     # Trace extraction script (Node, zero dependencies)
```

## License

Released under the [MIT License](LICENSE) — © 2026 mengtao Liu.
