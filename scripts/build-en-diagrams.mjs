/**
 * Build the English derivatives for the hand-supplied translations.
 *
 *   PATH=/opt/node22/bin:$PATH node scripts/build-en-diagrams.mjs
 *
 * The supplied scans (`scripts/wiring-diagram-processor/.source/…zip`, kept out
 * of git because they are 195 MB) are matched to page numbers by
 * `wiring-diagram-processor/build-manifest.mjs`. Pages the author's set does
 * not cover take the machine pipeline instead: drop its full-size output at
 * `.source/machine/<page>.jpg` and this picks it up as `machine`, never
 * `supplied`. This turns that manifest into something the site can serve:
 *
 *   public/diagrams/en/<page>.jpg   ~1800 px wide, the figure on the page
 *   public/diagrams/en/sizes.json   intrinsic sizes, so the box is reserved
 *   public/diagrams/en/provenance.json
 *                                   supplied | machine per page, so the page
 *                                   can say which it is showing
 *
 * The Japanese originals are not touched: they stay put for the "full
 * resolution" link and for pages whose translation does not exist yet, and
 * `src/lib/media.ts` falls back to them the moment `en/<page>.jpg` is missing.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'scripts/wiring-diagram-processor');
const MANIFEST = path.join(DIR, 'supplied-manifest.json');
const ZIP = path.join(DIR, '.source');
const EXTRACT = path.join(ZIP, 'extracted');
const OUT = path.join(ROOT, 'public/diagrams/en');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const exists = (p) => existsSync(p);
const readdir = (p) => readdirSync(p);

if (!exists(MANIFEST)) {
  console.error(`missing ${path.relative(ROOT, MANIFEST)} — run build-manifest.mjs first`);
  process.exit(1);
}

// Unpack once; the archive is gitignored, so a fresh clone has to bring it.
if (!exists(EXTRACT)) {
  const zip = readdir(ZIP).find((f) => f.endsWith('.zip'));
  if (!zip) {
    console.error(`no archive in scripts/wiring-diagram-processor/.source — supply it first`);
    process.exit(1);
  }
  mkdirSync(EXTRACT, { recursive: true });
  execFileSync('unzip', ['-q', '-o', path.join(ZIP, zip), '-d', EXTRACT]);
  console.log(`extracted ${zip}`);
}

// The archive holds a single folder; walk into it so the mapping can use the
// bare filenames it recorded.
const suppliedDir = readdir(EXTRACT).find((d) => existsSync(path.join(EXTRACT, d)));
const DIR_OF_FILES = suppliedDir ? path.join(EXTRACT, suppliedDir) : EXTRACT;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
mkdirSync(OUT, { recursive: true });

const sizes = {};
const provenance = {};
let bytes = 0;

// Pages the author did not cover get the machine pipeline instead; its raw
// output lands beside the supplied scans (gitignored, full size) and is sized
// the same way here. `provenance` records which is which so the page can say
// "Machine-translated" rather than implying the same hands made both.
const MACHINE = path.join(ZIP, 'machine');
const todo = [
  ...Object.entries(manifest.pages).map(([page, entry]) => ({ page, entry })),
  ...(manifest.missing ?? []).map((page) => ({ page, entry: null })),
];

for (const { page, entry } of todo) {
  const supplied = entry ? path.join(DIR_OF_FILES, entry.file) : null;
  const machine = path.join(MACHINE, page);
  const isMachine = supplied === null || !existsSync(supplied);
  const src = isMachine ? machine : supplied;
  if (!exists(src)) {
    console.error(
      isMachine
        ? `  still Japanese: ${page} — run translate-one.mjs for it`
        : `  no source: supplied "${entry.file}" for ${page}`,
    );
    continue;
  }
  const out = path.join(OUT, page);
  await sharp(src)
    .rotate() // apply EXIF if present; the tight-crop scans carry none
    // longest edge 1800, matching view/: the four tight-cropped supplies are
    // portrait, and sizing them by width alone would have made them 1800×2600
    // and heavier than the scan they replace.
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, progressive: true, mozjpeg: true })
    .toFile(out);
  const meta = await sharp(out).metadata();
  sizes[page] = { w: meta.width, h: meta.height };
  // Every page in `pages` came from a translation of its own, placed either by
  // correlation or by its spread partner; `method` records which, `provenance`
  // records whose hands a reader should be told about.
  provenance[page] = isMachine ? 'machine' : 'supplied';
  bytes += statSync(out).size;
  if (entry?.method === 'spread-partner') console.log(`  ${page} ← ${entry.file} (spread partner)`);
  if (isMachine) console.log(`  ${page} ← machine pipeline`);
}

// A page whose machine output is deleted must not keep serving the old
// derivative: rebuild the directory from exactly what this run produced.
const produced = new Set(Object.keys(sizes));
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.jpg'))) {
  if (!produced.has(f)) {
    unlinkSync(path.join(OUT, f));
    console.log(`  removed stale en/${f}`);
  }
}

// Pages nobody has translated yet stay Japanese; the provenance record says so
// rather than leaving the reader to wonder. `??=` because a page that just got
// a machine translation keeps that fact instead.
for (const page of manifest.missing ?? []) provenance[page] ??= 'none';
// A duplicate supplied file covers a page already handled above.

writeFileSync(path.join(OUT, 'sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);
writeFileSync(path.join(OUT, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

const still = Object.entries(provenance)
  .filter(([, v]) => v === 'none')
  .map(([k]) => k);
const machine = Object.entries(provenance)
  .filter(([, v]) => v === 'machine')
  .map(([k]) => k);
console.log(
  `en: ${produced.size} pages → ${kb(bytes)} of English derivatives` +
    (machine.length
      ? `, ${machine.length} of them machine-translated (${machine.join(' ')})`
      : ', none machine-translated') +
    (still.length ? `, ${still.length} still Japanese (${still.join(' ')})` : ', none still Japanese'),
);
console.log(`written to public/diagrams/en/`);
