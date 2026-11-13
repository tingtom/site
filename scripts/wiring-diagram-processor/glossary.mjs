// Learn terminology from a folder of already-translated scans.
//
//   export OPENCODE_API_KEY=<your OpenCode Go key>
//   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/glossary.mjs \
//     <dir of translated jpgs> [out.json]
//
// For each scan: is it translated, and what Japanese/English label pairs does
// it contain? The pairs are aggregated into a glossary (the most frequent
// English rendering wins per Japanese term) that can be pasted into the
// extraction prompt, so our wording matches yours instead of drifting.
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
const CONCURRENCY = 5;

const DIR = process.argv[2];
const OUT = process.argv[3] || '/tmp/opencode/glossary.json';
if (!DIR) {
  console.error('usage: glossary.mjs <dir of translated jpgs> [out.json]');
  process.exit(1);
}

const PROMPT = `This is a page from a Mazda RX-7 FD3S service manual. Return JSON:

{"translated": true|false, "title": "...", "pairs": [{"ja": "...", "en": "..."}]}

- "translated" is true when the labels on the page have been rewritten in English; false when they are still Japanese.
- "title" is the page's printed heading, as it appears (English if it is English).
- "pairs": every label you can read that has a Japanese form and its English rendering — wire colours (青緑 -> light green), component names (バッテリ -> battery), connector names, switch names, legend entries. Skip labels that are only codes (X-01, 40A B1) or only numbers.
- If the page is not translated, still return its title and an empty pairs array.
Return ONLY the JSON.`;

async function ask(file) {
  const buf = await sharp(file)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'x-opencode-session': 'glossary-2026-11',
      'User-Agent': 'wiring-diagram-processor/1.0 (github:tingtom/site)',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
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

const files = fs.readdirSync(DIR).filter((f) => /\.jpe?g$/i.test(f));
console.log(`${files.length} scans in ${DIR} (model: ${MODEL})`);

const results = new Array(files.length);
let done = 0;
let tokensIn = 0;
let tokensOut = 0;
let failures = 0;

const queue = files.map((f, i) => [f, i]);
async function worker() {
  while (queue.length) {
    const [f, i] = queue.shift();
    try {
      const { json, usage } = await ask(path.join(DIR, f));
      tokensIn += usage.prompt_tokens || 0;
      tokensOut += usage.completion_tokens || 0;
      results[i] = { file: f, ...json };
    } catch (err) {
      failures++;
      results[i] = { file: f, error: String(err.message).slice(0, 120), translated: false, pairs: [] };
    }
    done++;
    if (done % 10 === 0 || done === files.length) process.stdout.write(`\r  ${done}/${files.length}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log('');

const translated = results.filter((r) => r && r.translated);
console.log(`translated: ${translated.length} / ${files.length}  (failures: ${failures})`);
console.log(`tokens: ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(4)})`);

// aggregate: most frequent English rendering wins per Japanese term
const glossary = {};
for (const r of translated) {
  for (const p of r.pairs || []) {
    const ja = String(p.ja || '').trim();
    const en = String(p.en || '').trim();
    if (!ja || !en) continue;
    glossary[ja] ||= {};
    glossary[ja][en] = (glossary[ja][en] || 0) + 1;
  }
}
const flat = {};
for (const [ja, variants] of Object.entries(glossary)) {
  const best = Object.entries(variants).sort((a, b) => b[1] - a[1])[0];
  flat[ja] = { en: best[0], votes: best[1], variants: Object.keys(variants).length };
}

const entries = Object.entries(flat).sort((a, b) => b[1].votes - a[1].votes);
console.log(`glossary: ${entries.length} Japanese terms from ${Object.keys(glossary).length} source terms`);

fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, generated: new Date().toISOString(), scans: results, glossary: flat }, null, 2));
console.log(`written: ${OUT}`);

console.log('\ntop terms:');
for (const [ja, v] of entries.slice(0, 25)) console.log(`  ${ja.padEnd(22)} -> ${v.en.padEnd(28)} x${v.votes}${v.variants > 1 ? `  (${v.variants} variants)` : ''}`);

const inconsistent = entries.filter(([, v]) => v.variants > 1);
console.log(`\nterms with competing translations: ${inconsistent.length}`);
for (const [ja, v] of inconsistent.slice(0, 15)) {
  const all = Object.entries(glossary[ja]).map(([en, n]) => `${en} x${n}`).join(', ');
  console.log(`  ${ja}: ${all}`);
}
