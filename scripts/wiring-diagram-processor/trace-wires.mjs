/**
 * Trace a wire colour as a line on the diagram.
 *
 *   export OPENCODE_API_KEY=<your OpenCode Go key>
 *   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/trace-wires.mjs [--only p0031] [--limit 5] [--force] [--dry]
 *
 * The region capture (`locate-regions.mjs`) boxes components, connectors and
 * ECU pins — single things that are unambiguous on a drawing. A wire colour is
 * not: "Black" is printed next to dozens of wires on one page, so a box over
 * one of them would be a guess about which wire the chip means.
 *
 * What the drawing gives us instead is the colour label printed *beside* the
 * wire run it belongs to. This script asks for that run as an ordered polyline
 * — the wire itself, followed through crossings — and the page draws it over
 * the image when the chip is hovered or focused.
 *
 * Same contract as the region capture: the English scan is what is shown (a
 * line over Japanese-only pages points at something the reader is not looking
 * at), coordinates come back in pixels and are divided by the image size, and
 * `src/data/diagram-regions.json` holds fractions so the four 1235x1800
 * portrait crops and the landscape scans share one coordinate system. Proof
 * overlays land in `.work/wires/`, one per page.
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
const PROOFS = path.join(HERE, '.work/wires');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = process.env.PROC_MODEL || 'glm-5.3-flash';
const SESSION = 'diagram-wires-2026-11';
const UA = 'wiring-diagram-processor/1.0 (github:tingtom/site)';
const BATCH = 10; // colour labels per request
const RETRIES = 3;
const MAX_RUNS_PER_COLOUR = 3; // one label is often printed several times
const MAX_POINTS = 120;
const MIN_SPAN = 0.01; // a run shorter than 1% of the page is not a wire
const MIN_LENGTH = 0.025; // …nor is one that travels under 2.5% of the page

const args = process.argv.slice(2);
const only = args.includes('--only')
  ? args[args.indexOf('--only') + 1]?.replace(/\.jpg$/, '').replace(/^wiring-1993-/, '')
  : null;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const force = args.includes('--force');
const dry = args.includes('--dry');
const pageId = (page) => page.replace(/\.jpg$/, '').replace(/^wiring-1993-/, '');

/** Minimal frontmatter read: images and wire colours. */
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
  return { slug: file.replace(/\.md$/, ''), images: list('images'), wireColors: list('wireColors') };
}

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ()/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const pages = new Map();
for (const f of readdirSync(CONTENT).filter((f) => f.endsWith('.md'))) {
  const entry = entryFor(f);
  const colours = [...new Set(entry.wireColors)];
  for (const img of entry.images) {
    const page = img.split('/').pop();
    if (!pages.has(page)) pages.set(page, { colours: [], entries: [] });
    const slot = pages.get(page);
    slot.entries.push(entry.slug);
    for (const c of colours) if (!slot.colours.includes(c)) slot.colours.push(c);
  }
}

function promptFor(w, h, colours) {
  return `You are tracing wires on a Mazda RX-7 FD3S service-manual wiring diagram.

The image is exactly ${w}x${h} pixels. It is a scanned drawing: wires are lines, and a colour label such as "black/white (EM)" is printed beside the wire it belongs to.

Here are wire colour labels. Find each one where it is printed and trace the wire it names:

${colours.map((c) => `- ${c}`).join('\n')}

Return JSON:

{"items":[{"label":"","points":[[0,0],[1,1]]}]}

Rules:
- "label" is the name from the list above, character for character, even when the page prints it differently cased or split over two lines.
- "points" are [x, y] pixel coordinates in the ${w}x${h} image, ordered along that wire from one end to the other, with a point at every corner, bend and junction — enough points that the shape survives.
- Trace the wire itself. Where wires cross, keep following the same line; never jump onto another wire. Follow it past the label in both directions to the nearest component, connector or junction.
- If a colour label is printed more than once, return one item per occurrence: same label, different points.
- A colour in the list may be printed only as part of a two-colour name, such as "Yellow/white" or "black/purple". If you cannot find that colour printed on its own anywhere on the page, trace a run labelled with a two-colour name that contains it and report the single colour from the list, so "Yellow" can point at the run printed "Yellow/white".
- Never trace a colour that only appears inside a connector pinout table (a small callout box of pin colours with no wire running away from it) — there is no run there to draw.
- Skip any colour you cannot find or cannot follow to an end. An absent run is fine; a guessed one is not — a wrong line is worse than no line.
- Return ONLY the JSON object.`;
}

async function request(dataUrl, w, h, colours) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptFor(w, h, colours) },
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

const round4 = (n) => +n.toFixed(4);

/** Convert one returned run to fractions, or say why it is not usable. */
function toRun(item, w, h, batch) {
  const raw = typeof item.label === 'string' ? item.label.trim() : '';
  const label = batch.find((c) => c === raw) ?? batch.find((c) => norm(c) === norm(raw));
  if (!label) return { why: `${raw || '(no label)'} — not one of the colours asked for` };

  const pts = Array.isArray(item.points) ? item.points : [];
  const points = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]) / w;
    const y = Number(p[1]) / h;
    if (![x, y].every(Number.isFinite)) continue;
    if (x < -0.002 || y < -0.002 || x > 1.002 || y > 1.002) return { why: `${label} — a point is off the page` };
    points.push([round4(Math.min(1, Math.max(0, x))), round4(Math.min(1, Math.max(0, y)))]);
  }
  if (points.length < 2) return { why: `${label} — ${points.length} point(s), needs at least 2` };

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (span < MIN_SPAN) return { why: `${label} — too short to be a wire` };
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  if (length < MIN_LENGTH) return { why: `${label} — travels only ${Math.round(length * 100)}% of the page` };

  // Cap the point count: a wire drawn once by the model with 400 points is
  // 400 numbers in a committed JSON file for no extra fidelity on screen.
  let kept = points;
  if (kept.length > MAX_POINTS) {
    const step = kept.length / MAX_POINTS;
    kept = Array.from({ length: MAX_POINTS }, (_, i) => kept[Math.floor(i * step)]);
    kept.push(points[points.length - 1]);
  }
  return { run: { label, points: kept } };
}

async function proof(imagePath, runs, outFile) {
  const sharp = req('sharp');
  const meta = await sharp(imagePath).metadata();
  const width = Math.min(1600, meta.width);
  const base = await sharp(imagePath).resize({ width }).jpeg({ quality: 88 }).toBuffer();
  const framed = await sharp(base).metadata();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = runs
    .map((r) => {
      const pts = r.points.map(([x, y]) => `${(x * framed.width).toFixed(1)},${(y * framed.height).toFixed(1)}`).join(' ');
      const mid = r.points[Math.floor(r.points.length / 2)];
      return `<polyline points="${pts}" fill="none" stroke="#e11d48" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
        <text x="${(mid[0] * framed.width).toFixed(1)}" y="${(mid[1] * framed.height - 6).toFixed(1)}" font-family="sans-serif" font-size="${Math.round(framed.width * 0.011)}" fill="#e11d48">${esc(r.label)}</text>`;
    })
    .join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${framed.width}" height="${framed.height}">${lines}</svg>`;
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
  .filter(([page]) => force || !existing[page]?.wires?.length)
  .sort(([a], [b]) => a.localeCompare(b))
  .slice(0, limit);

if (!targets.length) {
  console.log('nothing to trace — every selected page already has wires (use --force to redo)');
  process.exit(0);
}
console.log(
  `${targets.length} page(s) to trace, ${[...pages.values()].reduce((n, p) => n + p.colours.length, 0)} colour labels in total`,
);

mkdirSync(PROOFS, { recursive: true });
let tokensIn = 0;
let tokensOut = 0;
let pagesWritten = 0;

async function trace(page, info) {
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
    console.log(`  skip ${page}: still Japanese — a line over it would point at text the reader cannot read`);
    return;
  }

  const sharp = req('sharp');
  const meta = await sharp(source).metadata();
  const { width: w, height: h } = meta;
  const colours = info.colours;
  if (!colours.length) {
    console.log(`  skip ${page}: no wire colours listed`);
    return;
  }
  const dataUrl = `data:image/jpeg;base64,${readFileSync(source).toString('base64')}`;

  console.log(`\n##### ${page}  ${w}x${h}  ${colours.length} colours  (${info.entries.join(', ')})`);
  const runs = [];
  const dropped = [];

  for (let i = 0; i < colours.length; i += BATCH) {
    const batch = colours.slice(i, i + BATCH);
    const result = await request(dataUrl, w, h, batch);
    tokensIn += result.tokens.prompt_tokens || 0;
    tokensOut += result.tokens.completion_tokens || 0;

    const perColour = new Map();
    for (const item of result.items) {
      const { run, why } = toRun(item, w, h, batch);
      if (why) {
        dropped.push(why);
        continue;
      }
      const seen = perColour.get(run.label) ?? 0;
      if (seen >= MAX_RUNS_PER_COLOUR) continue;
      perColour.set(run.label, seen + 1);
      runs.push(run);
    }
  }

  console.log(`  ${page}: ${runs.length} run(s) for ${new Set(runs.map((r) => r.label)).size}/${colours.length} colours, ${dropped.length} rejected`);
  for (const d of dropped.slice(0, 4)) console.log(`    ${d}`);
  if (dropped.length > 4) console.log(`    … ${dropped.length - 4} more`);

  if (!runs.length) {
    console.log(`  ${page}: nothing usable — the page keeps its chips as plain text`);
    return;
  }
  if (dry) return;

  const record = existing[page] ?? {};
  record.measured = record.measured ?? { w, h };
  record.model = MODEL;
  record.wires = runs.sort((a, b) => a.label.localeCompare(b.label));
  existing[page] = record;
  writeFileSync(OUT, `${JSON.stringify(existing, null, 2)}\n`);
  await proof(source, runs, path.join(PROOFS, page));
  pagesWritten++;
  appendFileSync(
    path.join(HERE, 'runs/wires.log'),
    `${page}\t${runs.length} runs\t${new Set(runs.map((r) => r.label)).size}/${colours.length} colours\t${dropped.length} rejected\t${info.entries.join(',')}\n`,
  );
}

const CONCURRENCY = Math.max(1, Number(args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : 6));
console.log(`concurrency ${CONCURRENCY}`);
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const [page, info] = targets[cursor++];
      await trace(page, info);
    }
  }),
);

console.log(
  `\n${dry ? 'dry run — nothing written; ' : ''}${pagesWritten} page(s) written, ` +
    `tokens ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(3)})`,
);
