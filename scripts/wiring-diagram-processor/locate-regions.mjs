/**
 * Locate the sidebar entries on a diagram scan.
 *
 *   export OPENCODE_API_KEY=<your OpenCode Go key>
 *   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/locate-regions.mjs [--only p0022] [--limit 5] [--force] [--dry]
 *
 * The diagram page has always listed components, connectors and ECU pins
 * beside a flat scan with nothing tying the two together. This is the step
 * that ties them: it shows the model the English scan the reader actually
 * sees, gives it that page's entry names, and asks for a tight box around each
 * one that is printed on the drawing.
 *
 * Why the English derivative and not the original: a highlight over the
 * author's translation names text the reader can see. On a page that is still
 * Japanese the box would sit on text they cannot read, so those pages are
 * skipped rather than half-done.
 *
 * Coordinates come back in pixels of the image it was shown and are divided by
 * that image's dimensions before anything is written — `src/data/diagram-
 * regions.json` stores fractions, so the four 1235x1800 portrait crops and the
 * 1800x1385 landscape scans land in one coordinate system.
 *
 * An overlay proof is written per page to `.work/regions/` (gitignored) so the
 * boxes can be checked against the scan instead of trusted.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.dirname + '/package.json');

const KEY = process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('Set OPENCODE_API_KEY to your OpenCode Go key first (see README).');
  process.exit(1);
}

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, '../..');
const CONTENT = path.join(ROOT, 'src/content/diagrams');
const DIAGRAMS = path.join(ROOT, 'public/diagrams');
const EN = path.join(DIAGRAMS, 'en');
const OUT = path.join(ROOT, 'src/data/diagram-regions.json');
const PROOFS = path.join(HERE, '.work/regions');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = process.env.PROC_MODEL || 'glm-5.3-flash';
const SESSION = 'diagram-regions-2026-11';
const UA = 'wiring-diagram-processor/1.0 (github:tingtom/site)';
const BATCH = 12; // names per request: bigger batches come back thin
const RETRIES = 3;

const args = process.argv.slice(2);
const only = args.includes('--only')
  ? args[args.indexOf('--only') + 1]?.replace(/\.jpg$/, '').replace(/^wiring-1993-/, '')
  : null;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const force = args.includes('--force');
const dry = args.includes('--dry');
const pageId = (page) => page.replace(/\.jpg$/, '').replace(/^wiring-1993-/, '');

/** Minimal frontmatter read: the lists this script needs, nothing else. */
function entryFor(file) {
  const text = readFileSync(path.join(CONTENT, file), 'utf8');
  const list = (key) => {
    const line = text.split('\n').find((l) => l.startsWith(`${key}:`));
    if (!line) return [];
    try {
      const v = JSON.parse(line.slice(key.length + 1).trim());
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : [];
    } catch {
      return [];
    }
  };
  return {
    slug: file.replace(/\.md$/, ''),
    images: list('images'),
    components: list('components'),
    connectors: list('connectors'),
    ecuPins: list('ecuPins'),
  };
}

const KIND = { components: 'component', connectors: 'connector', ecuPins: 'ecuPin' };

/** Case- and punctuation-insensitive form, for matching a model's reply back
 *  to the canonical sidebar string. */
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ()/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** page filename -> { names, kind } from every content entry that shows it. */
const pages = new Map();
for (const f of readdirSync(CONTENT).filter((f) => f.endsWith('.md'))) {
  const entry = entryFor(f);
  const names = new Map();
  for (const [key, kind] of Object.entries(KIND)) {
    for (const name of entry[key]) if (!names.has(name)) names.set(name, kind);
  }
  for (const img of entry.images) {
    const page = img.split('/').pop();
    if (!pages.has(page)) pages.set(page, { names: new Map(), entries: [] });
    const slot = pages.get(page);
    slot.entries.push(entry.slug);
    for (const [name, kind] of names) if (!slot.names.has(name)) slot.names.set(name, kind);
  }
}

function promptFor(w, h, names) {
  return `You are locating parts on a Mazda RX-7 FD3S service-manual wiring diagram.

The image is exactly ${w}x${h} pixels. It is a scanned drawing: wires are lines, components are boxes and symbols, connectors are plug outlines, and text names them. Some names also appear as rows in the system tables at the page edges.

Find where this page shows each of these parts, connectors and pins:

${names.map((n) => `- ${n}`).join('\n')}

Return JSON:

{"items":[{"label":"","seen":"","x":0,"y":0,"w":0,"h":0}]}

Rules:
- "label" is the name from the list above, character for character. Do not translate, abbreviate, re-case or add words — even when the page prints something shorter.
- "seen" is the text actually printed where you found it, when it differs from "label" (for example "Starter" for "Starter Motor", "ABS(4WAS)" for "ABS System"). Leave it empty when they are the same.
- Box the thing itself, not its neighbour. If the name labels a component's box or outline, box that outline; if it labels a short piece of text, box the text tightly with a couple of pixels of padding. Never box a whole table, a whole column, or several unrelated components at once.
- The drawing often prints a shorter or slightly different form of a name — "Starter" for "Starter Motor", "Combination meter" for "Combination Meter", "ABS" for "ABS System". That still counts: locate it and box it.
- A name split over two or three lines is one box around all of it.
- If the name is printed or drawn more than once, pick the clearest occurrence — the one with the most space around it.
- Skip a name only when this page genuinely does not show it, or when you would have to guess. An absent box is fine; a guessed box is not.
- x,y,w,h are pixels in the ${w}x${h} image.
- Return ONLY the JSON object.`;
}

async function request(dataUrl, w, h, names) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptFor(w, h, names) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
          'x-opencode-session': SESSION,
          'User-Agent': UA,
        },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const raw = data.choices[0].message.content;
      const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { items: Array.isArray(json.items) ? json.items : [], tokens: data.usage || {} };
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  throw lastError;
}

/** Box sanity: a label, not a page. Anything else is dropped and reported. */
const MIN = 0.0035; // ~6 px at 1800
const MAX = 0.45;
function sane(box) {
  const { x, y, w, h } = box;
  if (![x, y, w, h].every(Number.isFinite)) return 'not a number';
  if (w < MIN || h < MIN) return 'too small';
  if (w > MAX || h > MAX) return 'too big';
  if (x < 0 || y < 0 || x + w > 1.002 || y + h > 1.002) return 'off the page';
  if (w * h > 0.12) return 'covers too much';
  return null;
}

async function proof(imagePath, regions, outFile) {
  const sharp = req('sharp');
  const meta = await sharp(imagePath).metadata();
  // Resize first: sharp applies composite after resize regardless of call
  // order, so an overlay drawn at the source size would be rejected as bigger
  // than the base it is composited onto.
  const width = Math.min(1600, meta.width);
  const base = await sharp(imagePath).resize({ width }).jpeg({ quality: 88 }).toBuffer();
  const framed = await sharp(base).metadata();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const boxes = regions
    .map((r) => {
      const x = r.x * framed.width;
      const y = r.y * framed.height;
      const w = r.w * framed.width;
      const h = r.h * framed.height;
      const size = Math.max(13, Math.round(framed.width * 0.011));
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#e11d48" stroke-width="3"/>
        <text x="${x + 2}" y="${y - 4}" font-family="sans-serif" font-size="${size}" fill="#e11d48">${esc(r.label.slice(0, 36))}</text>`;
    })
    .join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${framed.width}" height="${framed.height}">${boxes}</svg>`;
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 84 })
    .toFile(outFile);
}

let existing = {};
try {
  existing = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  existing = {};
}

const targets = [...pages.entries()]
  .filter(([page]) => (only ? pageId(page) === only : true))
  .filter(([page]) => force || !existing[page]?.regions?.length)
  .sort(([a], [b]) => a.localeCompare(b))
  .slice(0, limit);

if (!targets.length) {
  console.log('nothing to locate — every selected page already has regions (use --force to redo)');
  process.exit(0);
}
console.log(`${targets.length} page(s) to locate, ${[...pages.values()].reduce((n, p) => n + p.names.size, 0)} names in total`);

mkdirSync(PROOFS, { recursive: true });
let tokensIn = 0;
let tokensOut = 0;
let pagesWritten = 0;

async function locate(page, info) {
  const source = existsSync(path.join(EN, page))
    ? path.join(EN, page)
    : existsSync(path.join(DIAGRAMS, 'view', page))
      ? path.join(DIAGRAMS, 'view', page)
      : path.join(DIAGRAMS, page);
  if (!existsSync(source)) {
    console.log(`  skip ${page}: no image on disk`);
    return;
  }
  if (!source.startsWith(EN)) {
    console.log(`  skip ${page}: still Japanese — a box would point at text the reader cannot read`);
    return;
  }

  const sharp = req('sharp');
  const meta = await sharp(source).metadata();
  const { width: w, height: h } = meta;
  const names = [...info.names.keys()];
  // One decode per page, reused across batches.
  const dataUrl = `data:image/jpeg;base64,${readFileSync(source).toString('base64')}`;

  console.log(`\n##### ${page}  ${w}x${h}  ${names.length} names  (${info.entries.join(', ')})`);
  const found = new Map();
  const dropped = [];

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const result = await request(dataUrl, w, h, batch);
    tokensIn += result.tokens.prompt_tokens || 0;
    tokensOut += result.tokens.completion_tokens || 0;

    for (const item of result.items) {
      const raw = typeof item.label === 'string' ? item.label.trim() : '';
      // Map back to the canonical sidebar string: models vary the casing even
      // when told not to, and a label the sidebar does not hold cannot be
      // linked to it.
      const label = batch.find((n) => n === raw) ?? batch.find((n) => norm(n) === norm(raw));
      if (!label) {
        dropped.push(`${raw || '(no label)'} — not one of the names asked for`);
        continue;
      }
      const box = {
        x: Number(item.x) / w,
        y: Number(item.y) / h,
        w: Number(item.w) / w,
        h: Number(item.h) / h,
      };
      const why = sane(box);
      if (why) {
        dropped.push(`${label} — ${why}`);
        continue;
      }
      if (found.has(label)) continue;
      found.set(label, {
        label,
        kind: info.names.get(label),
        x: +box.x.toFixed(4),
        y: +box.y.toFixed(4),
        w: +box.w.toFixed(4),
        h: +box.h.toFixed(4),
      });
    }
  }

  const regions = [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
  console.log(`  ${page}: ${regions.length}/${names.length} located, ${dropped.length} rejected`);
  for (const d of dropped.slice(0, 4)) console.log(`    ${d}`);
  if (dropped.length > 4) console.log(`    … ${dropped.length - 4} more`);

  if (!regions.length) {
    console.log(`  ${page}: nothing usable — leaving the page static`);
    return;
  }
  if (dry) return;

  existing[page] = { measured: { w, h }, model: MODEL, regions };
  writeFileSync(OUT, `${JSON.stringify(existing, null, 2)}\n`);
  await proof(source, regions, path.join(PROOFS, page));
  pagesWritten++;
  appendFileSync(
    path.join(HERE, 'runs/regions.log'),
    `${page}\t${regions.length}/${names.length}\t${dropped.length} rejected\t${info.entries.join(',')}\n`,
  );
}

// Pages are independent, so run a few at a time: one page is a handful of
// sequential requests, and 87 pages one after another takes hours.
const CONCURRENCY = Math.max(1, Number(args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : 4));
console.log(`concurrency ${CONCURRENCY}`);
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const [page, info] = targets[cursor++];
      await locate(page, info);
    }
  }),
);

console.log(
  `\n${dry ? 'dry run — nothing written; ' : ''}${pagesWritten} page(s) written, ` +
    `tokens ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(3)})`,
);
