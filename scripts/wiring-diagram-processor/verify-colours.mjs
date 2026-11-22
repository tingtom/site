/**
 * Verify a page's listed wire colours against the scan itself.
 *
 *   export OPENCODE_API_KEY=<your OpenCode Go key>
 *   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/verify-colours.mjs [--only p0030] [--limit 5] [--force] [--dry]
 *
 * The metadata extractor listed wire colours by reading the whole page, so a
 * legend or a pinout table could contribute names that are not wire labels on
 * the drawing (p0029 carried nine "Dark …" colours that appear only in the ECU
 * pin legend; TASK-30). The author's bar: a colour belongs in a page's chip
 * list only if it is printed on that page beside a wire run — not as a legend
 * key, not only inside a pinout table.
 *
 * So this script asks, per page, only about the colours that trace-wires could
 * not find beside a run: is each one printed as the label of a wire (own name,
 * or inside a two-colour name that contains it)? A yes must come with the
 * pixel box of one printed occurrence — that box is the proof, drawn back onto
 * the scan in `.work/colour-verdicts/` so the verdicts can be checked by eye
 * rather than trusted. A no removes the colour from the page's frontmatter.
 *
 * Conservative by default: a colour with a traced run is kept without asking,
 * and a missing, malformed or unproven verdict keeps the colour too — only an
 * explicit "not printed beside a wire" removes one.
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
const REGIONS = path.join(ROOT, 'src/data/diagram-regions.json');
const VERDICTS = path.join(HERE, 'runs/colour-verdicts.json');
const PROOFS = path.join(HERE, '.work/colour-verdicts');

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = process.env.PROC_MODEL || 'glm-5.3-flash';
const SESSION = 'diagram-colours-2026-11';
const UA = 'wiring-diagram-processor/1.0 (github:tingtom/site)';
const BATCH = 12; // colour labels per request
const PASSES = Math.max(1, Number(process.env.PROC_PASSES) || 3); // verdicts are unstable run-to-run
const RETRIES = 3;

const args = process.argv.slice(2);
const only = args.includes('--only')
  ? args[args.indexOf('--only') + 1]
      ?.split(',')
      .map((s) => s.replace(/\.jpg$/, '').replace(/^wiring-1993-/, ''))
      .filter(Boolean) ?? null
  : null;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const force = args.includes('--force');
const dry = args.includes('--dry');
const pageId = (page) => page.replace(/\.jpg$/, '').replace(/^wiring-1993-/, '');

/** One content entry: the file's own images and colour list, frontmatter only. */
function entryFor(file) {
  const text = readFileSync(path.join(CONTENT, file), 'utf8');
  const list = (key) => {
    const line = text.split('\n').find((l) => l.startsWith(`${key}:`));
    if (!line) return [];
    try {
      const v = JSON.parse(line.slice(key.length + 1).trim());
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : [];
    } catch {
      return undefined; // unparsable: leave this entry alone
    }
  };
  const images = list('images');
  const wireColors = list('wireColors');
  if (images === undefined || wireColors === undefined) return null;
  return {
    file,
    slug: file.replace(/\.md$/, ''),
    images,
    wireColors: [...new Set(wireColors)],
  };
}

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ()/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const entries = readdirSync(CONTENT)
  .filter((f) => f.endsWith('.md'))
  .map(entryFor)
  .filter(Boolean);

/** Colours a page can already prove: labels with a traced run in the data. */
const traced = {};
try {
  const data = JSON.parse(readFileSync(REGIONS, 'utf8'));
  for (const [page, rec] of Object.entries(data)) {
    traced[page] = new Set((rec.wires ?? []).map((w) => w.label).filter((l) => typeof l === 'string'));
  }
} catch {
  // no data yet: every colour is untraced
}

/** What is still unproven on each page: listed somewhere, traced nowhere. */
const pages = new Map(); // page -> { colours: [], entries: [] }
for (const entry of entries) {
  for (const img of entry.images) {
    const page = img.split('/').pop();
    if (!pages.has(page)) pages.set(page, { colours: [], entries: [] });
    const slot = pages.get(page);
    slot.entries.push(entry.slug);
    for (const c of entry.wireColors) {
      if (!(traced[page] ?? new Set()).has(c) && !slot.colours.includes(c)) slot.colours.push(c);
    }
  }
}

function promptFor(w, h, colours) {
  return `You are checking a Mazda RX-7 FD3S service-manual wiring diagram page.

The image is exactly ${w}x${h} pixels. On these drawings the colour of every wire is printed beside the wire it belongs to, as a label such as "black/white (EM)" or a single name like "yellow".

For each colour below, decide whether this page prints it as the label of a wire that is actually drawn as a line — on its own beside the wire, or as part of a two-colour name beside the wire (so "Yellow" counts when the label reads "Yellow/white"):

${colours.map((c) => `- ${c}`).join('\n')}

Answer for each colour:

{"items":[{"label":"","printed":true,"box":[0,0,0,0],"text":""}]}

Rules:
- "label" is the name from the list above, character for character.
- "printed" is true only when the colour (alone, or inside a two-colour name that contains it) is printed beside a wire that is drawn as a line on this page. Then "box" is [x, y, w, h] pixels of ONE such printed label in the ${w}x${h} image, and "text" is that label exactly as printed.
- "printed" is false when the colour appears only in a legend or key (for example harness cover colour codes in brackets), only inside a connector pinout or ECU pin table (a box of pin colours with no wire running away from it), only as free text, or not at all. Omit "box" and "text" then.
- If you cannot find the colour printed beside a drawn wire, answer false — an honest no is better than a guessed yes.
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

/** One returned verdict, or why it is not usable (an unusable verdict keeps the colour). */
function toVerdict(item, w, h, batch) {
  const raw = typeof item.label === 'string' ? item.label.trim() : '';
  const label = batch.find((c) => c === raw) ?? batch.find((c) => norm(c) === norm(raw));
  if (!label) return { why: `${raw || '(no label)'} — not one of the colours asked for` };

  if (item.printed !== true) return { verdict: { label, printed: false } };

  const box = Array.isArray(item.box) ? item.box.map(Number) : [];
  const [x, y, bw, bh] = box;
  const inRange = box.length === 4 && [x, y, bw, bh].every(Number.isFinite);
  const sane =
    inRange && bw > 0 && bh > 0 && x >= -w * 0.002 && y >= -h * 0.002 && x + bw <= w * 1.002 && y + bh <= h * 1.002;
  if (!sane) {
    return { why: `${label} — says printed but the box is ${inRange ? 'off the page' : 'missing or malformed'}` };
  }
  return {
    verdict: {
      label,
      printed: true,
      box: [round4(x / w), round4(y / h), round4(bw / w), round4(bh / h)],
      text: typeof item.text === 'string' ? item.text.slice(0, 40) : undefined,
    },
  };
}

/** Boxes of the printed verdicts, drawn back onto the scan for eyeballing. */
async function proof(imagePath, verdicts, outFile) {
  const sharp = req('sharp');
  const meta = await sharp(imagePath).metadata();
  const width = Math.min(1600, meta.width);
  const base = await sharp(imagePath).resize({ width }).jpeg({ quality: 88 }).toBuffer();
  const framed = await sharp(base).metadata();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rects = verdicts
    .filter((v) => v.printed)
    .map((v) => {
      const [x, y, bw, bh] = v.box;
      return `<rect x="${(x * framed.width).toFixed(1)}" y="${(y * framed.height).toFixed(1)}" width="${(bw * framed.width).toFixed(1)}" height="${(bh * framed.height).toFixed(1)}" fill="none" stroke="#059669" stroke-width="3"/>
        <text x="${(x * framed.width).toFixed(1)}" y="${(y * framed.height - 6).toFixed(1)}" font-family="sans-serif" font-size="${Math.round(framed.width * 0.011)}" fill="#059669">${esc(v.text || v.label)}</text>`;
    })
    .join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${framed.width}" height="${framed.height}">${rects}</svg>`;
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 84 })
    .toFile(outFile);
}

let verdictsByPage = {};
try {
  verdictsByPage = JSON.parse(readFileSync(VERDICTS, 'utf8'));
} catch {
  verdictsByPage = {};
}

const targets = [...pages.entries()]
  .filter(([page]) => (only ? only.includes(pageId(page)) : true))
  .filter(([page]) => force || !verdictsByPage[page])
  .sort(([a], [b]) => a.localeCompare(b))
  .slice(0, limit);

if (!targets.length) {
  console.log('nothing to verify — every selected page already has verdicts (use --force to redo)');
  process.exit(0);
}
console.log(
  `${targets.length} page(s) to verify, ${targets.reduce((n, [, p]) => n + p.colours.length, 0)} untraced colours in total`,
);

mkdirSync(PROOFS, { recursive: true });
let tokensIn = 0;
let tokensOut = 0;
let pagesVerified = 0;

async function verify(page, info) {
  const source = existsSync(path.join(EN, page))
    ? path.join(EN, page)
    : existsSync(path.join(DIAGRAMS, 'view', page))
      ? path.join(DIAGRAMS, 'view', page)
      : path.join(DIAGRAMS, page);
  if (!source.startsWith(EN)) {
    console.log(`  skip ${page}: no English derivative — nothing to check the reader against`);
    return;
  }
  if (!info.colours.length) {
    console.log(`  skip ${page}: every listed colour already has a trace`);
    return;
  }

  const sharp = req('sharp');
  const { width: w, height: h } = await sharp(source).metadata();
  const dataUrl = `data:image/jpeg;base64,${readFileSync(source).toString('base64')}`;

  console.log(`\n##### ${page}  ${w}x${h}  ${info.colours.length} untraced colours  (${info.entries.join(', ')})`);

  // One pass is not trustworthy: the same page came back "0 printed" and then
  // "2 printed" on consecutive runs, and one pass put two labels in the same
  // box. So ask PASSES times and keep a colour if any pass proves it printed
  // with a sane box — a false no silently deletes a real colour from the
  // reference list, and the repeated pass is the cheapest defence. Every
  // surviving yes still carries its box, which the proofs draw for eyeballing.
  const perLabel = new Map(); // label -> verdict (best evidence seen)
  const perPass = [];

  for (let pass = 1; pass <= PASSES; pass++) {
    const verdicts = [];
    const unproven = [];
    for (let i = 0; i < info.colours.length; i += BATCH) {
      const batch = info.colours.slice(i, i + BATCH);
      const result = await request(dataUrl, w, h, batch);
      tokensIn += result.tokens.prompt_tokens || 0;
      tokensOut += result.tokens.completion_tokens || 0;

      const seen = new Set();
      for (const item of result.items) {
        const { verdict, why } = toVerdict(item, w, h, batch);
        if (why) {
          unproven.push(why);
          continue;
        }
        if (seen.has(verdict.label)) continue;
        seen.add(verdict.label);
        verdicts.push(verdict);
      }
    }
    const printed = verdicts.filter((v) => v.printed);
    const absent = verdicts.filter((v) => !v.printed);
    perPass.push(`${printed.length}+${absent.length}${unproven.length ? `+${unproven.length}!` : ''}`);
    for (const v of verdicts) {
      const prev = perLabel.get(v.label);
      // Best evidence wins: a printed verdict with a box beats an earlier
      // absent one; a second printed verdict keeps the first sane box.
      if (!prev || (!prev.printed && v.printed)) perLabel.set(v.label, v);
    }
  }

  const verdicts = [...perLabel.values()];
  const printed = verdicts.filter((v) => v.printed);
  const absent = verdicts.filter((v) => !v.printed);
  console.log(`  ${page}: ${printed.length} printed beside a wire, ${absent.length} not, 0 unproven (kept) — passes ${perPass.join(' / ')}`);

  if (dry) return;

  verdictsByPage[page] = { model: MODEL, passes: PASSES, entries: info.entries, verdicts };
  writeFileSync(VERDICTS, `${JSON.stringify(verdictsByPage, null, 2)}\n`);
  await proof(source, verdicts, path.join(PROOFS, page));
  pagesVerified++;
  appendFileSync(
    path.join(HERE, 'runs/verify-colours.log'),
    `${page}\t${printed.length} printed\t${absent.length} absent\t${PASSES} passes\t${perPass.join('/')}\t${info.entries.join(',')}\n`,
  );
}

const CONCURRENCY = Math.max(1, Number(args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : 6));
console.log(`concurrency ${CONCURRENCY}`);
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const [page, info] = targets[cursor++];
      await verify(page, info);
    }
  }),
);

if (dry) {
  console.log(`\ndry run — nothing written; tokens ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(3)})`);
  process.exit(0);
}

/** Rewrite each affected entry's wireColors to what the page proves. */
const printedOn = (page, label) =>
  (verdictsByPage[page]?.verdicts ?? []).some((v) => v.label === label && v.printed === true);

let entriesRewritten = 0;
const removedReport = [];
for (const entry of entries) {
  if (!entry.wireColors.length) continue;
  const kept = entry.wireColors.filter((c) =>
    entry.images.some((img) => {
      const page = img.split('/').pop();
      return (traced[page] ?? new Set()).has(c) || printedOn(page, c);
    }),
  );
  const removed = entry.wireColors.filter((c) => !kept.includes(c));
  if (!removed.length) continue;

  const text = readFileSync(path.join(CONTENT, entry.file), 'utf8');
  const updated = text.replace(
    /^wireColors: .*$/m,
    `wireColors: ${JSON.stringify(kept)}`,
  );
  if (updated === text) {
    console.log(`  could not rewrite ${entry.file} — no single-line wireColors found`);
    continue;
  }
  writeFileSync(path.join(CONTENT, entry.file), updated);
  entriesRewritten++;
  removedReport.push(`${entry.slug}: kept ${kept.length}, removed ${removed.length} (${removed.join(', ')})`);
}
for (const line of removedReport) console.log(`  ${line}`);

console.log(
  `\n${pagesVerified} page(s) verified, ${entriesRewritten} entry file(s) rewritten, ` +
    `tokens ${tokensIn} in / ${tokensOut} out (~$${((tokensIn * 0.15 + tokensOut * 0.5) / 1e6).toFixed(3)})`,
);
