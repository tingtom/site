# Wiring diagram processor

Extracts structured metadata from the 1993 FD3S service-manual scans and writes
it straight into the Astro frontmatter under `src/content/diagrams/`.

This is a rewrite of `rx7.pro`'s Sanity-era processor of the same name: it
speaks to the **OpenCode Go** endpoint instead of OpenRouter, and writes
markdown directly instead of emitting JSON for manual import into a CMS.

## Run it

```bash
export OPENCODE_API_KEY=<your OpenCode Go key>   # from opencode.ai/console
PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/process.mjs
```

Options:

| flag / env | effect |
| --- | --- |
| `--dry` | call the model but don't write any files |
| `PROC_MODEL` | model id, default `glm-5.3-flash` ($0.15 / $0.50 per M) |

## What it does

- Skips anything that already has a real title — only pages still titled
  `Wiring Diagram 1993 — Page NNNN` are processed, so it's safe to re-run.
- Reads the 1800px `public/diagrams/view/` derivative, not the 2–4 MB original.
- Writes `title`, `identifier`, `category`, `description`, `wireColors`,
  `components`, `connectors`, `ecuPins`, `notes`, `confidence`.
- **Leaves `slug`, `images`, `yearRange` and `sections` alone**, so no URL or
  layout changes.
- Title guard: if the model answers with a bare corner code (`Y`) or a page
  number it re-asks for a descriptive English name, then falls back to
  `Wiring Diagram 1993 — Page NNNN`.
- Four scans at a time, three retries with backoff, and a summary table of
  everything it wrote.

Cost for the full set of 87: **about $0.07**.

## Endpoint notes

`https://opencode.ai/inference/go/openai/v1/chat/completions` needs two things
beyond the bearer token:

- `x-opencode-session` — a stable id per conversation, used for routing
- a real `User-Agent` identifying the client

Every `opencode-go` model is **text output only**, so this script can translate
*text* off a scan but cannot generate a translated image. See the OpenCode Go
docs for the model list and limits.
