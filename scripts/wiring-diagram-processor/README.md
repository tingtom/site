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

## English scans: end to end

The metadata above makes pages findable; this half makes them readable. The
site serves `public/diagrams/en/<page>.jpg` in front of the Japanese original
when one exists, so the whole job is producing those files and recording where
each came from.

```bash
# 1. tie the author's hand-translated scans to page numbers
npm run diagrams:manifest -- "<dir holding the supplied translated jpgs>"
#    → supplied-manifest.json, and page-map.json for step 4

# 2. machine-translate whatever the set does not cover — one command
export OPENCODE_API_KEY=<your OpenCode Go key>
npm run diagrams:machine
#    reads the manifest, skips pages already translated, runs one page per
#    work dir, logs each run to scripts/wiring-diagram-processor/runs/,
#    then rebuilds what step 3 would have rebuilt
#    (--force redoes them; the four harness pages: p0019 p0020 p0022 p0024)

# 3. build what the site serves, then check the three agree
npm run diagrams:en      # → en/*.jpg + sizes.json + provenance.json
npm run guard:diagrams   # content ↔ disk ↔ provenance ↔ built HTML

# 4. re-derive placement and size from the author's examples (optional)
#    → measure.json beside page-map.json, the numbers draw.py is built on
PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/measure.mjs \
  "<dir holding the supplied translated jpgs>" public/diagrams \
  scripts/wiring-diagram-processor/measure.json

# 5. locate the sidebar entries on each scan (optional, additive)
export OPENCODE_API_KEY=<your OpenCode Go key>
npm run diagrams:regions         # ← every page; --only p0022, --limit N, --force, --dry
#    → src/data/diagram-regions.json, proof overlays in .work/regions/
```

Step 1 is only needed when the supplied set changes. Step 2's output is
gitignored full-size; step 3 resizes it to a longest edge of 1800, matching
`view/`, and records provenance as `supplied` or `machine` — the diagram page
labels the figure accordingly, so a generated translation is never passed off
as a reviewed one. Pages with neither are still Japanese and say so. Step 4
reproduces the numbers the drawing code was tuned against; see
[`runs/summary.md`](runs/summary.md) for what the machine runs actually did.

`translate-one.mjs` runs a convergence loop: extract labels, draw them with
`draw.py`, verify the *drawn* result quadrant by quadrant for Japanese that
survived, merge what it found, and redraw from the original scan so nothing
compounds. Two clean verification passes in a row end it (max six rounds).
Each round prints what `draw.py` declined and why — declined labels are not
failures, they are boxes that need re-thinking, and the report file beside the
output says which.

### Region capture

`locate-regions.mjs` is what lets a diagram page answer "what is this plug /
box / wire?" — it gives the sidebar entries somewhere to point at. One page at
a time, it shows the model the **English** scan (the page the reader actually
sees — a box over Japanese text names something they cannot read, so pages
still in Japanese are skipped) and that page's `components` / `connectors` /
`ecuPins`, then asks where each one is drawn. The drawing often prints a
shorter form than the metadata — `Starter` for `Starter Motor`, `ABS(4WAS)` for
`ABS System` — and the prompt says that still counts.

Coordinates are divided by the image size before writing, so
`src/data/diagram-regions.json` stores fractions:

```json
"wiring-1993-p0022.jpg": {
  "measured": { "w": 1800, "h": 1385 },
  "model": "glm-5.3-flash",
  "regions": [
    { "label": "Fuel Pump", "kind": "component", "x": 0.0656, "y": 0.2563, "w": 0.0611, "h": 0.0116 }
  ]
}
```

Fractions are the contract, not pixels: four pages are tight portrait crops
(1235x1800) while the rest are landscape (1800x1385), and a pixel box correct in
one coordinate system silently misses in the other. `measured` is provenance.
Boxes that leave the page, sit under 6px, or cover a quarter of the sheet are
dropped rather than written.

A proof overlay is written to `.work/regions/<page>.jpg` for every page — the
boxes drawn back onto the scan in red, with their labels — so a capture can be
checked by eye. Each page's yield is appended to `runs/regions.log` (page,
located/asked, rejected, entry), which is the record of what the model found and
what it could not. The coverage is deliberately partial: a name the model cannot
find stays plain text in the sidebar instead of becoming a link to nowhere, and
pages with no usable boxes stay exactly as they were.

## Endpoint notes

`https://opencode.ai/inference/go/openai/v1/chat/completions` needs two things
beyond the bearer token:

- `x-opencode-session` — a stable id per conversation, used for routing
- a real `User-Agent` identifying the client

Every `opencode-go` model is **text output only**, so this script can translate
*text* off a scan but cannot generate a translated image. See the OpenCode Go
docs for the model list and limits.
