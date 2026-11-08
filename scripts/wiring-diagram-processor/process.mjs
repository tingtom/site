// Wiring diagram processor — extract structured metadata from the FD3S scan
// pages and write it straight into the Astro frontmatter (title, identifier,
// wire colours, components, connectors, ECU pins, category, notes).
//
//   export OPENCODE_API_KEY=<your OpenCode Go key>
//   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/process.mjs [--dry]
//
// Model defaults to glm-5.3-flash (cheap: ~$0.0007 a scan); override with
// PROC_MODEL. Only pages whose title is still the "Wiring Diagram 1993 —
// Page NNNN" placeholder are touched, and slug/images/yearRange/sections are
// preserved, so no URLs move.
//
// Provenance: a rewrite of rx7.pro's Sanity-era `wiring-diagram-processor`,
// which wrote JSON for manual import; this one writes the frontmatter
// directly and speaks to the OpenCode Go endpoint instead of OpenRouter.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(ROOT, 'src/content/diagrams');
const VIEW = path.join(ROOT, 'public/diagrams/view');
const DRY = process.argv.includes('--dry');
const MODEL = process.env.PROC_MODEL || 'glm-5.3-flash';
const CONCURRENCY = 4;
const KEY = process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('Set OPENCODE_API_KEY to your OpenCode Go key first.');
  process.exit(1);
}
const BASE = 'https://opencode.ai/inference/go/openai/v1';
const SESSION = 'wiring-diagram-processor-2026-11';
const UA = 'wiring-diagram-processor/1.0 (github:tingtom/site)';

const PROMPT = `Analyze this Mazda RX-7 FD3S wiring diagram image. Translate any Japanese text to English.

IMPORTANT: Return ONLY valid JSON with these exact keys. Do not include markdown or code block formatting.

{
  "title": "Exact title text as printed on the diagram (copy verbatim). If in Japanese, translate to English.",
  "identifier": "Alphanumeric code visible in top-left corner (e.g., 'Y', 'B-1a', '12A'). Empty string if none.",
  "wireColors": ["Red", "Black", "Green/White"],
  "components": ["ECU", "fuel pump", "starter motor"],
  "connectors": ["FPC", "EPC", "10P", "16P"],
  "ecuPins": ["ECU pin 1", "pin 20", "FPC pin 32"],
  "category": "Free-text category like Engine/ECU, Lighting, Audio, etc.",
  "yearRange": "1993-1996",
  "description": "One-sentence summary of what this diagram shows",
  "notes": "Any legends, voltage references, ground points, special instructions",
  "confidence": 0.95
}`;

const PROMPT_RETRY = `${PROMPT}

CRITICAL: "title" must be a descriptive English name for this diagram (what system it shows), never the corner identifier code, a page number, or a single letter. Aim for 3-8 words.`;

// A title that is just a code ("Y", "A-1b", "page 24") is useless on a card.
const titleLooksBad = (t, identifier) => {
  const s = String(t || '').trim();
  if (!s) return true;
  if (identifier && s.toLowerCase() === String(identifier).trim().toLowerCase()) return true;
  if (s.length <= 4) return true;
  if (/^(page|p)?\s*\d+$/i.test(s)) return true;
  return false;
};

const frontmatter = (src) => (src.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
const body = (src) => src.replace(/^---\n[\s\S]*?\n---\n?/, '');
const scalar = (fm, key) => {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(fm);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const strArray = (fm, key) => {
  const raw = (fm.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1];
  if (!raw || raw.trim() === '[]') return [];
  try {
    return JSON.parse(raw.trim());
  } catch {
    return [];
  }
};

const quote = (s) =>
  s === '' || /^[\s>|*&!#{}[\],:?"'#@-]/.test(s) || /: /.test(s) ? JSON.stringify(s) : s;

const serialize = (d) => {
  const lines = ['---'];
  const put = (k, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v))
      lines.push(`${k}: ${v.length ? `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]` : '[]'}`);
    else if (typeof v === 'number' || typeof v === 'boolean') lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${quote(String(v))}`);
  };
  put('title', d.title);
  put('slug', d.slug);
  put('description', d.description);
  put('images', d.images);
  put('category', d.category);
  put('yearRange', d.yearRange);
  put('identifier', d.identifier);
  put('wireColors', d.wireColors);
  put('components', d.components);
  put('connectors', d.connectors);
  put('ecuPins', d.ecuPins);
  put('notes', d.notes);
  put('confidence', d.confidence);
  put('sections', d.sections);
  lines.push('---', '', d.body ?? '');
  return lines.join('\n');
};

async function call(prompt, imagePath) {
  const bodyJson = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString('base64')}` } },
        ],
      },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
          'x-opencode-session': SESSION,
          'User-Agent': UA,
        },
        body: JSON.stringify(bodyJson),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
      const raw = data.choices[0].message.content;
      return { json: typeof raw === 'string' ? JSON.parse(raw) : raw, usage: data.usage };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function extract(view, identifier) {
  let { json, usage } = await call(PROMPT, view);
  if (titleLooksBad(json.title, identifier)) {
    const retry = await call(PROMPT_RETRY, view);
    if (!titleLooksBad(retry.json.title, identifier)) {
      json = { ...json, ...retry.json };
      usage = retry.usage;
    }
  }
  return { json, usage };
}

// ---- gather: placeholders + anything whose title is just a code ----
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ file: f, full: path.join(DIR, f), src: fs.readFileSync(path.join(DIR, f), 'utf8') }))
  .filter(({ src }) => {
    const fm = frontmatter(src);
    const title = scalar(fm, 'title');
    const identifier = scalar(fm, 'identifier');
    return /^title: Wiring Diagram 1993/m.test(src) || titleLooksBad(title, identifier);
  });

console.log(`${files.length} diagrams to process (model: ${MODEL}${DRY ? ', DRY RUN' : ''})`);

const results = [];
const errors = [];
const seenTitles = new Set();
let done = 0;
let tokensIn = 0;
let tokensOut = 0;

async function work({ file, full, src }) {
  const fm = frontmatter(src);
  const images = strArray(fm, 'images');
  const view = path.join(VIEW, images[0]);
  if (!fs.existsSync(view)) throw new Error(`no view derivative for ${images[0]}`);

  const { json, usage } = await extract(view, scalar(fm, 'identifier'));
  tokensIn += usage?.prompt_tokens || 0;
  tokensOut += usage?.completion_tokens || 0;

  const pageNum = (file.match(/p(\d+)/) || [])[1] || '';
  let title = String(json.title || '').trim();
  if (titleLooksBad(title, json.identifier)) title = `Wiring Diagram 1993 — Page ${pageNum}`;
  if (seenTitles.has(title)) title = `${title} — Page ${pageNum}`;
  seenTitles.add(title);

  const record = {
    title,
    slug: scalar(fm, 'slug'),
    description: json.description || '',
    images,
    category: json.category || '',
    yearRange: scalar(fm, 'yearRange'),
    identifier: json.identifier || '',
    wireColors: json.wireColors || [],
    components: json.components || [],
    connectors: json.connectors || [],
    ecuPins: json.ecuPins || [],
    notes: json.notes || '',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0.8,
    sections: strArray(fm, 'sections'),
    body: body(src),
  };

  if (!DRY) fs.writeFileSync(full, serialize(record));
  results.push({ page: pageNum, title, category: record.category, confidence: record.confidence });
  done++;
  process.stdout.write(`\r  ${done}/${files.length} done`);
}

const queue = [...files];
async function runner() {
  while (queue.length) {
    const item = queue.shift();
    try {
      await work(item);
    } catch (err) {
      done++;
      errors.push({ file: item.file, error: err.message });
      process.stdout.write(`\r  ${done}/${files.length} done (FAIL ${item.file}: ${err.message.slice(0, 60)})`);
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, runner));
console.log(`\n${done} processed, ${errors.length} failed, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`tokens: ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(4)} at glm-5.3-flash rates)`);

results.sort((a, b) => a.page.localeCompare(b.page));
console.log('\npage  conf  category                title');
for (const r of results)
  console.log(`${r.page.padEnd(5)} ${String(r.confidence).padEnd(5)} ${(r.category || '-').slice(0, 22).padEnd(24)} ${r.title.slice(0, 72)}`);
const low = results.filter((r) => r.confidence < 0.8);
console.log(`\nbelow 0.8 confidence: ${low.length ? low.map((r) => r.page).join(', ') : 'none'}`);
if (errors.length) console.log('errors:', JSON.stringify(errors, null, 1));

fs.writeFileSync('/tmp/opencode/proc-go-summary.json', JSON.stringify({ results, errors, tokensIn, tokensOut }, null, 2));
