/**
 * Guard the diagram image pipeline.
 *
 *   PATH=/opt/node22/bin:$PATH node scripts/guard-diagrams.mjs
 *
 * Fails when the pieces that must agree have drifted apart: a content entry
 * pointing at a scan that is not on disk, an English derivative with no size
 * record, a page whose provenance does not match what is served, or a built
 * page that lost the link back to the Japanese original.
 *
 * Run it after `npm run build`; it reads `dist/`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CONTENT = path.join(ROOT, 'src/content/diagrams');
const DIAGRAMS = path.join(ROOT, 'public/diagrams');
const EN = path.join(DIAGRAMS, 'en');
const DIST = path.join(ROOT, 'dist/rx7/diagrams');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const ok = (msg) => console.log(`  ok   ${msg}`);

const originals = readdirSync(DIAGRAMS).filter((f) => /^wiring-1993-p\d+\.jpg$/.test(f));
const entries = readdirSync(CONTENT).filter((f) => f.endsWith('.md'));
const enSizes = JSON.parse(readFileSync(path.join(EN, 'sizes.json'), 'utf8'));
const provenance = JSON.parse(readFileSync(path.join(EN, 'provenance.json'), 'utf8'));

// 1. every image named in content exists on disk, and each page's entry names
//    are recorded for the region checks below
let missing = [];
const contentByPage = new Map();
const listOf = (text, key) => {
  const line = text.split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return [];
  try {
    const v = JSON.parse(line.slice(key.length + 1).trim());
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
};
for (const f of entries) {
  const text = readFileSync(path.join(CONTENT, f), 'utf8');
  const images = listOf(text, 'images');
  const slugLine = text.split('\n').find((l) => l.startsWith('slug:'));
  const pageSlug = slugLine ? slugLine.slice('slug:'.length).trim().replace(/^["']|["']$/g, '') : f.replace(/\.md$/, '');
  const names = new Set([...listOf(text, 'components'), ...listOf(text, 'connectors'), ...listOf(text, 'ecuPins')]);
  const colours = new Set(listOf(text, 'wireColors'));
  for (const img of images) {
    if (!existsSync(path.join(DIAGRAMS, img))) missing.push(`${f} → ${img}`);
    contentByPage.set(img.split('/').pop(), { slug: pageSlug, names, colours, file: f });
  }
}
missing.length ? missing.forEach(fail) : ok(`${entries.length} content entries, every image on disk`);

// 2. English derivatives and their size records agree, both ways
const enFiles = readdirSync(EN).filter((f) => f.endsWith('.jpg'));
const enNoSize = enFiles.filter((f) => !enSizes[f]);
const sizeNoFile = Object.keys(enSizes).filter((f) => !enFiles.includes(f));
enNoSize.forEach((f) => fail(`en/${f} has no size record`));
sizeNoFile.forEach((f) => fail(`sizes.json lists ${f} but en/${f} is missing`));
if (!enNoSize.length && !sizeNoFile.length) ok(`${enFiles.length} English derivatives, all sized`);

// 3. provenance covers every original, and agrees with what is on disk
const provKeys = Object.keys(provenance);
const unlisted = originals.filter((o) => !provKeys.includes(o));
unlisted.forEach((o) => fail(`${o} has no provenance entry`));
for (const [page, source] of Object.entries(provenance)) {
  if (!['supplied', 'machine', 'none'].includes(source)) fail(`${page}: unknown provenance "${source}"`);
  const onDisk = existsSync(path.join(EN, page));
  if (source === 'none' && onDisk) fail(`${page} is marked "none" but en/ exists`);
  if (source !== 'none' && !onDisk) fail(`${page} is marked "${source}" but en/ is missing`);
}
if (!unlisted.length) ok(`provenance covers all ${originals.length} originals`);

// 4. the built pages still show a scan and link back to the Japanese original
if (!existsSync(DIST)) {
  fail('dist/rx7/diagrams missing — run npm run build first');
} else {
  const pages = readdirSync(DIST).filter((f) => f !== 'index.html');
  let translated = 0;
  for (const slug of pages) {
    const html = readFileSync(path.join(DIST, slug, 'index.html'), 'utf8');
    const img = html.match(/<img src="([^"]*\/diagrams\/[^"]+)"/);
    if (!img) {
      fail(`${slug}: no diagram image`);
      continue;
    }
    const disk = path.join(ROOT, 'dist', img[1].replace(/^\/site\//, ''));
    if (!existsSync(disk)) fail(`${slug}: image not built — ${img[1]}`);
    if (/diagrams\/en\//.test(img[1])) translated++;
    if (!/original Japanese scan|full resolution/.test(html)) fail(`${slug}: no link back to the original scan`);
  }
  ok(`${pages.length} built pages, ${translated} showing English, all with an original-scan link`);
}

// 5. region data is valid, names something the sidebar lists, and reaches the
//    built page — the three have to agree or a box highlights the wrong entry
const REGIONS = path.join(ROOT, 'src/data/diagram-regions.json');
let regionData = {};
try {
  regionData = JSON.parse(readFileSync(REGIONS, 'utf8'));
} catch {
  fail('src/data/diagram-regions.json is missing or not JSON');
}

const KINDS = ['component', 'connector', 'ecuPin'];
let regionCount = 0;
let pagesWithRegions = 0;
const regionPages = [];
for (const [page, record] of Object.entries(regionData)) {
  const entry = contentByPage.get(page);
  if (!entry) {
    fail(`${page}: region data for a page no content entry shows`);
    continue;
  }
  const measured = record.measured;
  if (!measured || !(measured.w > 0) || !(measured.h > 0)) {
    fail(`${page}: no measured image size — fractions cannot be checked`);
  }
  if (!existsSync(path.join(EN, page))) {
    fail(`${page}: regions point at a page with no English scan (text the reader cannot read)`);
  }
  const regions = Array.isArray(record.regions) ? record.regions : [];
  if (!regions.length) fail(`${page}: region data with no regions`);
  const seen = new Set();
  for (const r of regions) {
    regionCount++;
    if (typeof r.label !== 'string' || !r.label.trim()) {
      fail(`${page}: region with no label`);
      continue;
    }
    if (seen.has(r.label)) fail(`${page}: "${r.label}" has more than one box`);
    seen.add(r.label);
    if (!KINDS.includes(r.kind)) fail(`${page}/"${r.label}": kind "${r.kind}" is not one of ${KINDS.join(', ')}`);
    const frac = ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
    if (!frac) {
      fail(`${page}/"${r.label}": coordinates are not numbers`);
      continue;
    }
    if (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0) fail(`${page}/"${r.label}": box has no area`);
    if (r.x + r.w > 1.002 || r.y + r.h > 1.002) fail(`${page}/"${r.label}": box escapes the image`);
    if (r.w < 0.0035 || r.h < 0.0035) fail(`${page}/"${r.label}": box too small to hit (${r.w}×${r.h})`);
    if (!entry.names.has(r.label)) fail(`${page}/"${r.label}": not an entry in ${entry.file}`);
  }
  pagesWithRegions++;
  regionPages.push({ page, slug: entry.slug, count: regions.length, labels: [...seen] });
}
if (regionCount) {
  ok(`${pagesWithRegions} pages, ${regionCount} regions — all fractions, all naming a sidebar entry`);
} else {
  ok('no region data yet — every diagram page stays static');
}

// 6. each region page renders one box per region, linked both ways, and the
//    image is not wrapped in an anchor (a link inside a link is invalid)
for (const { page, slug, count, labels } of regionPages) {
  const file = path.join(DIST, slug, 'index.html');
  if (!existsSync(file)) {
    fail(`${page}: no built page at dist/rx7/diagrams/${slug}`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  const boxes = (html.match(/class="region"/g) ?? []).length;
  if (boxes !== count) fail(`${page}: ${count} regions in data, ${boxes} boxes built`);
  const unlinked = labels.filter((l) => !html.includes(`data-region="${l}"`));
  unlinked.slice(0, 3).forEach((l) => fail(`${page}: "${l}" never reached the page`));
  const figure = html.slice(html.indexOf('<figure class="diagram-figure'), html.indexOf('</figure>'));
  if (/<a[^>]*>\s*<img/.test(figure)) fail(`${page}: image is still wrapped in an anchor on a region page`);
  const entryLinks = (html.match(/class="entry-link"/g) ?? []).length;
  if (entryLinks !== new Set(labels).size) {
    fail(`${page}: ${new Set(labels).size} entries have regions, ${entryLinks} entry links built`);
  }
}
if (regionPages.length) {
  ok(`${regionPages.length} built pages carry their regions, entries linked both ways`);
}

// 7. wire traces: fractions, a shape worth drawing, a colour the sidebar
//    actually lists, and one line per run in the built page
let wireCount = 0;
let pagesWithWires = 0;
const wirePages = [];
for (const [page, record] of Object.entries(regionData)) {
  const wires = Array.isArray(record.wires) ? record.wires : [];
  if (!wires.length) continue;
  const entry = contentByPage.get(page);
  if (!entry) {
    fail(`${page}: wire data for a page no content entry shows`);
    continue;
  }
  pagesWithWires++;
  wireCount += wires.length;
  for (const w of wires) {
    if (typeof w.label !== 'string' || !w.label.trim()) {
      fail(`${page}: wire with no label`);
      continue;
    }
    if (!entry.colours.has(w.label)) fail(`${page}/"${w.label}": not a wire colour in ${entry.file}`);
    const pts = Array.isArray(w.points) ? w.points : [];
    if (pts.length < 2) {
      fail(`${page}/"${w.label}": ${pts.length} point(s), needs at least 2`);
      continue;
    }
    let bad = null;
    let length = 0;
    const xs = [];
    const ys = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Array.isArray(p) || p.length < 2 || ![p[0], p[1]].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        bad = `point ${i} is not a pair of numbers`;
        break;
      }
      if (p[0] < -0.002 || p[0] > 1.002 || p[1] < -0.002 || p[1] > 1.002) {
        bad = `point ${i} is off the image`;
        break;
      }
      xs.push(p[0]);
      ys.push(p[1]);
      if (i) length += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    }
    if (bad) {
      fail(`${page}/"${w.label}": ${bad}`);
      continue;
    }
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (span < 0.01 || length < 0.025) fail(`${page}/"${w.label}": too short to be a wire`);
  }
  wirePages.push({ page, slug: entry.slug, count: wires.length });
}
if (wireCount) {
  ok(`${pagesWithWires} pages, ${wireCount} wire traces — all fractions, all naming a listed colour`);
} else {
  ok('no wire traces yet — wire chips stay plain text');
}

for (const { page, slug, count } of wirePages) {
  const file = path.join(DIST, slug, 'index.html');
  if (!existsSync(file)) {
    fail(`${page}: no built page at dist/rx7/diagrams/${slug}`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  const lines = (html.match(/<polyline class="wire"/g) ?? []).length;
  if (lines !== count) fail(`${page}: ${count} wire traces in data, ${lines} lines built`);
}
if (wirePages.length) ok(`${wirePages.length} built pages carry their wire layer`);

// …and a page with no trace data must not have grown a layer of its own.
if (existsSync(DIST)) {
  const withWires = new Set(wirePages.map((w) => w.slug));
  for (const slug of readdirSync(DIST).filter((f) => f !== 'index.html')) {
    if (withWires.has(slug)) continue;
    const html = readFileSync(path.join(DIST, slug, 'index.html'), 'utf8');
    if (/<polyline class="wire"/.test(html)) fail(`${slug}: wire layer built but no wire data`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nDIAGRAM GUARD PASS');
process.exit(failures ? 1 : 0);
