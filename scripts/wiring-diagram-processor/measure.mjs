// Learn PLACEMENT and SIZE from already-translated scans.
//
//   export OPENCODE_API_KEY=<your OpenCode Go key>
//   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/measure.mjs \
//     <dir of translated jpgs> [dir of matching originals] [out.json]
//
// Sends the original and the translation of the same page side by side and
// asks for the Japanese box and the English box of every label it replaced.
// From the pairs we get the two things that decide whether a translation looks
// native: WHERE the text goes (offset from the original) and HOW BIG it is
// (height ratio against the Japanese it replaces).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.dirname + '/package.json');
const sharp = req('sharp');

const KEY = process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('Set OPENCODE_API_KEY to your OpenCode Go key first.');
  process.exit(1);
}
const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = process.env.PROC_MODEL || 'glm-5.3-flash';
const CONCURRENCY = 4;

const TRANS_DIR = process.argv[2];
const ORIG_DIR = process.argv[3] || '/root/projects/site/public/diagrams';
const OUT = process.argv[4] || '/tmp/opencode/measure.json';
if (!TRANS_DIR) {
  console.error('usage: measure.mjs <translated dir> [originals dir] [out.json]');
  process.exit(1);
}

const PROMPT = (w, h) => `Two images of the SAME Mazda RX-7 FD3S service-manual page: image 1 is the original (Japanese labels), image 2 is its translation (English labels). Both are ${w}x${h} pixels and share a coordinate system.

For every English label in image 2, find the Japanese label in image 1 that it replaced and return:

{"items":[{"ja":{"x":0,"y":0,"w":0,"h":0},"en":{"x":0,"y":0,"w":0,"h":0},"ja_text":"…","en_text":"…"}]}

Rules:
- Coordinates are in ${w}x${h} pixels for BOTH images.
- "ja" tightly bounds the Japanese glyphs; "en" tightly bounds the English text that replaced them.
- If these two images are NOT the same page, return {"items":[],"error":"different page"}.
- Only labels that were actually translated — skip anything still Japanese in image 2, and skip printed English that exists in both.
- Be exhaustive: wire colours, component names, connectors, legends, table cells.
Return ONLY the JSON.`;

async function ask(origPath, transPath) {
  const resized = await Promise.all(
    [origPath, transPath].map((f) =>
      sharp(f)
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer(),
    ),
  );
  const [a, b] = resized;
  const dims = await Promise.all(resized.map((buf) => sharp(buf).metadata()));
  const W = dims[0].width;
  const H = dims[0].height;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'x-opencode-session': 'measure-2026-11',
      'User-Agent': 'wiring-diagram-processor/1.0 (github:tingtom/site)',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT(W, H) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${a.toString('base64')}` } },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` } },
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
  return { json: typeof raw === 'string' ? JSON.parse(raw) : raw, usage: data.usage || {} };
}

// Pair each translated file with its original scan by matching the base name
// ("Starter_alternator.jpg" -> wiring-1993-p0025.jpg is unknown, so fall back
// to asking the model for the page number and mapping through the index)
function findOriginal(transFile) {
  const base = path.basename(transFile, '.jpg').replace(/\s*diagram\s*$/i, '').trim().toLowerCase();
  const files = fs.readdirSync(ORIG_DIR).filter((f) => /^wiring-\d+-p\d+\.jpg$/i.test(f));
  // no reliable name match — caller passes a mapping instead
  return { base, files };
}

const transFiles = fs.readdirSync(TRANS_DIR).filter((f) => /\.jpe?g$/i.test(f));
const mapping = fs.existsSync(path.join(path.dirname(OUT), 'page-map.json'))
  ? JSON.parse(fs.readFileSync(path.join(path.dirname(OUT), 'page-map.json'), 'utf8'))
  : null;

const targets = [];
for (const f of transFiles) {
  if (mapping && mapping[f]) targets.push([f, path.join(ORIG_DIR, mapping[f])]);
}

if (!targets.length) {
  console.log(`No page-map.json found next to ${OUT} — pass a mapping of translated file -> original filename.`);
  console.log('Create it with:  {"Starter_alternator.jpg": "wiring-1993-p0025.jpg", ...}');
  process.exit(2);
}

console.log(`${targets.length} pairs to measure (model: ${MODEL})`);

const results = [];
let done = 0;
let tokensIn = 0;
let tokensOut = 0;
const queue = [...targets];

async function worker() {
  while (queue.length) {
    const [transFile, origPath] = queue.shift();
    try {
      const { json, usage } = await ask(origPath, path.join(TRANS_DIR, transFile));
      tokensIn += usage.prompt_tokens || 0;
      tokensOut += usage.completion_tokens || 0;
      results.push({ file: transFile, items: json.items || [] });
    } catch (err) {
      results.push({ file: transFile, items: [], error: String(err.message).slice(0, 120) });
    }
    done++;
    process.stdout.write(`\r  ${done}/${targets.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log('');

// --- statistics: placement offset and size ratio ---
const pairs = results.flatMap((r) => r.items || []);
const dxs = [], dys = [], hRatios = [], wRatios = [];
for (const p of pairs) {
  if (!p.ja || !p.en || !p.ja.h || !p.ja.w) continue;
  dxs.push(p.en.x - p.ja.x);
  dys.push(p.en.y - p.ja.y);
  hRatios.push(p.en.h / p.ja.h);
  wRatios.push(p.en.w / p.ja.w);
}
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : null);

console.log(`label pairs matched: ${pairs.length} across ${results.filter((r) => r.items.length).length} scans`);
console.log('');
console.log('PLACEMENT (English box minus Japanese box, px at 1600 wide):');
console.log(`  dx  median ${median(dxs)?.toFixed(1)}   p25 ${pct(dxs, 0.25)?.toFixed(1)}  p75 ${pct(dxs, 0.75)?.toFixed(1)}`);
console.log(`  dy  median ${median(dys)?.toFixed(1)}   p25 ${pct(dys, 0.25)?.toFixed(1)}  p75 ${pct(dys, 0.75)?.toFixed(1)}`);
console.log('');
console.log('SIZE (English height ÷ Japanese height):');
console.log(`  ratio median ${median(hRatios)?.toFixed(3)}   p25 ${pct(hRatios, 0.25)?.toFixed(3)}  p75 ${pct(hRatios, 0.75)?.toFixed(3)}`);
console.log(`  width ratio median ${median(wRatios)?.toFixed(3)}`);
const smaller = hRatios.filter((r) => r < 0.95).length;
const same = hRatios.filter((r) => r >= 0.95 && r <= 1.15).length;
const bigger = hRatios.filter((r) => r > 1.15).length;
console.log(`  ${smaller} smaller (≤0.95), ${same} about the same, ${bigger} bigger (≥1.15)`);

fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, pairs: results, stats: {
  placements: pairs.length,
  dx_median: median(dxs), dy_median: median(dys),
  height_ratio_median: median(hRatios), width_ratio_median: median(wRatios),
} }, null, 2));
console.log(`\nwritten: ${OUT}`);
console.log(`tokens: ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(4)})`);
