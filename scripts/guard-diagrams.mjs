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

// 1. every image named in content exists on disk
let missing = [];
for (const f of entries) {
  const text = readFileSync(path.join(CONTENT, f), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('images:'));
  if (!line) continue;
  for (const m of line.matchAll(/"([^"]+)"/g)) {
    if (!existsSync(path.join(DIAGRAMS, m[1]))) missing.push(`${f} → ${m[1]}`);
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

console.log(failures ? `\n${failures} FAILED` : '\nDIAGRAM GUARD PASS');
process.exit(failures ? 1 : 0);
