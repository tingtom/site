// Diagram translation — stage 1 (the model) plus the convergence loop.
//
//   export OPENCODE_API_KEY=<your OpenCode Go key>
//   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/translate-one.mjs \
//     <image> <out.jpg> [workdir]
//
// Loop: extract Japanese labels -> draw.py paints English -> verify the RESULT
// quadrant by quadrant for anything that survived -> merge -> redraw from the
// ORIGINAL (never from a drawn image, so nothing compounds) -> stop after two
// clean verification passes.
//
// The model only returns text + coordinates. All pixel work is draw.py's.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.dirname + '/package.json');

const KEY = process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('Set OPENCODE_API_KEY to your OpenCode Go key first.');
  process.exit(1);
}
const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = process.env.PROC_MODEL || 'glm-5.3-flash';
const MAX_ROUNDS = 6;
const CLEAN_NEEDED = 2;
const SESSION = 'diagram-translate-2026-11';
const UA = 'wiring-diagram-processor/1.0 (github:tingtom/site)';
const DRAW_PY = path.join(import.meta.dirname, 'draw.py');

const SOURCE = process.argv[2];
const OUT = process.argv[3];
const WORK = process.argv[4] || path.join(import.meta.dirname, '.work');
if (!SOURCE || !OUT) {
  console.error('usage: translate-one.mjs <image> <out.jpg> [workdir]');
  process.exit(1);
}
fs.mkdirSync(WORK, { recursive: true });

function promptFor(w, h) {
  return `You are preparing a Japanese Mazda RX-7 FD3S wiring diagram page for translation.

The image is exactly ${w}x${h} pixels.

Find EVERY piece of Japanese text visible here and return it as JSON:

{"items":[{"x":0,"y":0,"w":0,"h":0,"ja":"","en":"","vertical":false}]}

Rules:
- x,y,w,h are pixels in the ${w}x${h} image and must tightly bound the JAPANESE GLYPHS ONLY — a couple of pixels of padding is fine. Do NOT include neighbouring printed text such as A-01, X-03, 40A B2, or the page number, and do not include box outlines or leader lines.
- "ja" is the Japanese text exactly as printed.
- "en" is a natural English translation using standard automotive wiring terminology. Established terms: グロー -> glow (plug), コンビネーション・メータ -> combination meter, スターター -> starter, オルタネーター -> alternator, イグニッション -> ignition, リレー -> relay, ソレノイド -> solenoid.
- "vertical" is true for tategaki (top-to-bottom) text.
- Skip anything already in English, page numbers, and alphanumeric codes (FPC, X-01, JC-02 ...).
- MT and AT are already English (manual / automatic transmission): never translate them, never expand them to "manual transmission", and never include them in "en".
- Parenthesised kana such as (ト), (ミ) or (エ) are Japanese too — include them as their own item (translate the kana, keep the brackets), do not treat them as codes.
- Never invent labels: only return text you can actually see on the page at its own position — repeated wire colours on different wires are separate items, but never return the same label twice.
- Be exhaustive: include tiny labels under 20px tall, text inside tables, and text near the edges.
- If there is no Japanese left, return {"items":[]}.
Return ONLY the JSON object.`;
}

async function extract(imagePath, width, height) {
  const sharp = req('sharp');
  const meta = await sharp(imagePath).metadata();
  const w = width || meta.width;
  const h = height || meta.height;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'x-opencode-session': SESSION,
      'User-Agent': UA,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptFor(w, h) },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString('base64')}` },
            },
          ],
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  const raw = data.choices[0].message.content;
  const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { items: Array.isArray(json.items) ? json.items : [], tokens: data.usage || {} };
}

/**
 * Verify in four overlapping quadrants rather than one whole-page look: on
 * the full image the model reported "no Japanese left" while 白黒 was still
 * plainly visible near the right edge. Smaller crops make it read the little
 * labels.
 *
 * Crops are cut with integer offsets computed first — rounding top and height
 * independently overshoots the image by a pixel and sharp rejects it.
 */
async function verifyQuadrants(imagePath) {
  const sharp = req('sharp');
  const meta = await sharp(imagePath).metadata();
  const overlapPx = Math.round(Math.min(meta.width, meta.height) * 0.08);
  const halfW = Math.round(meta.width / 2);
  const halfH = Math.round(meta.height / 2);

  const cuts = [];
  for (const [name, left, top] of [
    ['tl', 0, 0],
    ['tr', halfW - overlapPx, 0],
    ['bl', 0, halfH - overlapPx],
    ['br', halfW - overlapPx, halfH - overlapPx],
  ]) {
    const l = Math.max(0, Math.min(left, meta.width - 1));
    const t = Math.max(0, Math.min(top, meta.height - 1));
    const w = Math.min(halfW + overlapPx, meta.width - l);
    const h = Math.min(halfH + overlapPx, meta.height - t);
    const file = path.join(WORK, `verify-${name}.jpg`);
    await sharp(imagePath).extract({ left: l, top: t, width: w, height: h }).jpeg({ quality: 90 }).toFile(file);
    cuts.push({ file, left: l, top: t });
  }

  const found = [];
  const tokens = { prompt_tokens: 0, completion_tokens: 0 };
  for (const cut of cuts) {
    const r = await extract(cut.file);
    tokens.prompt_tokens += r.tokens.prompt_tokens || 0;
    tokens.completion_tokens += r.tokens.completion_tokens || 0;
    for (const it of r.items) found.push({ ...it, x: it.x + cut.left, y: it.y + cut.top });
  }
  return { items: found, tokens };
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1, a.w * a.h);
}

/**
 * De-dupe against what was actually DRAWN, not against the label list: a label
 * draw.py declined has to be retried, and treating "already in the list" as
 * "already applied" is what made an earlier version loop forever.
 */
function merge(existing, extra, drawn = []) {
  const out = [...existing];
  for (const it of extra) {
    if (!(it.en || '').trim()) continue;
    if (drawn.some((d) => overlap(it, d) > 0.15 || overlap(d, it) > 0.15)) continue;
    const dupDrawn = drawn.some(
      (k) =>
        k.en.trim().toLowerCase() === it.en.trim().toLowerCase() &&
        Math.hypot((k.x + k.w / 2) - (it.x + it.w / 2), (k.y + k.h / 2) - (it.y + it.h / 2)) < 90,
    );
    if (dupDrawn) continue;
    if (out.some((k) => overlap(it, k) > 0.45)) continue;
    out.push(it);
  }
  return out;
}

function readReport(drawnPath) {
  try {
    return JSON.parse(fs.readFileSync(drawnPath + '.report.json', 'utf8'));
  } catch {
    return { drawn: [], skipped: [] };
  }
}

function draw(labelsPath, outPath) {
  return execFileSync('python3', [DRAW_PY, labelsPath, outPath, '--source', SOURCE], {
    encoding: 'utf8',
  }).trim();
}

const sharp = req('sharp');
const meta = await sharp(SOURCE).metadata();
console.log(`source ${path.basename(SOURCE)} (${meta.width}x${meta.height}) model=${MODEL}`);

const labels = { source: SOURCE, width: meta.width, height: meta.height, model: MODEL, items: [] };
let tokensIn = 0;
let tokensOut = 0;
let drawnBoxes = [];
let cleanStreak = 0;
let lastDrawn = null;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const labelsPath = path.join(WORK, `labels-round${round}.json`);
  let result;

  if (round === 1) {
    result = await extract(SOURCE);
    labels.items = result.items;
  } else {
    result = await verifyQuadrants(lastDrawn);
    const before = labels.items.length;
    labels.items = merge(labels.items, result.items, drawnBoxes);
    const added = labels.items.length - before;
    console.log(
      `  round ${round}: verification found ${result.items.length}, ${added} new after de-dupe`,
    );
    if (added === 0) {
      cleanStreak += 1;
      if (cleanStreak >= CLEAN_NEEDED) {
        console.log(`  verification clean ${CLEAN_NEEDED}x in a row — done`);
        break;
      }
      console.log(`  clean pass ${cleanStreak}/${CLEAN_NEEDED} — checking again`);
    } else {
      cleanStreak = 0;
    }
  }
  tokensIn += result.tokens.prompt_tokens || 0;
  tokensOut += result.tokens.completion_tokens || 0;

  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
  lastDrawn = path.join(WORK, `drawn-round${round}.jpg`);
  console.log(`  round ${round}: ${labels.items.length} labels -> ${draw(labelsPath, lastDrawn)}`);

  const report = readReport(lastDrawn);
  drawnBoxes = report.drawn;
  if (report.skipped?.length) {
    const by = {};
    for (const s of report.skipped) by[s.reason] = (by[s.reason] || 0) + 1;
    console.log('    declined: ' + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', '));
  }
  if (round === 1 && labels.items.length === 0) break;
}

const finalLabels = path.join(WORK, 'labels-final.json');
fs.writeFileSync(finalLabels, JSON.stringify(labels, null, 2));
console.log('final: ' + draw(finalLabels, OUT));
console.log(
  `tokens: ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(4)})`,
);
console.log(`output: ${OUT}`);
