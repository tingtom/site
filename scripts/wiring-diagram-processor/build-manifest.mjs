// Build the manifest that maps each supplied English scan to its 1993 page.
//
// The scans are hand translations of the same pages, so layout survives and a
// normalised 64×64 grayscale correlation is enough to identify the source.
// Four supplied files are cropped differently from our scans and cannot be
// correlated; their names pair them with a "… diagram" page that does match,
// and each pair is a two-page spread (system, then its diagram), so the
// unmatched half is the page immediately before.
//
//   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/build-manifest.mjs <dir>
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.dirname + '/../../package.json')('sharp');
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TRANS = process.argv[2];
if (!TRANS) {
  console.error('usage: build-manifest.mjs <dir of supplied translated jpgs>');
  process.exit(1);
}
const ORIG = path.join(import.meta.dirname, '../../public/diagrams');
const OUT = path.join(import.meta.dirname, 'supplied-manifest.json');

const N = 64;
const sig = async (file, rot = 0) => {
  let img = sharp(file);
  if (rot) img = img.rotate(rot);
  const { data } = await img
    .flatten({ background: '#fff' })
    .removeAlpha()
    .grayscale()
    .resize(N, N, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = N * N;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += data[i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (data[i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = (data[i] - mean) / sd;
  return v;
};

const originals = readdirSync(ORIG).filter((f) => /^wiring-1993-p\d+\.jpg$/.test(f)).sort();
const origSig = [];
for (const f of originals) origSig.push({ f, v: await sig(path.join(ORIG, f)) });

const files = readdirSync(TRANS).filter((f) => f.endsWith('.jpg')).sort();
const results = [];
for (const f of files) {
  const variants = [];
  for (const rot of [0, 90, 180, 270]) variants.push({ rot, v: await sig(path.join(TRANS, f), rot) });
  const scored = origSig.map(({ f: o, v: os }) => {
    let best = -1, bestRot = 0;
    for (const { rot, v } of variants) {
      let dot = 0;
      for (let i = 0; i < N * N; i++) dot += v[i] * os[i];
      if (dot > best) { best = dot; bestRot = rot; }
    }
    return { o, c: best / (N * N), rot: bestRot };
  });
  scored.sort((a, b) => b.c - a.c);
  results.push({ file: f, match: scored[0], second: scored[1] });
}

// A file that does not correlate is the system half of a spread whose diagram
// half did: the two pages are consecutive, system then diagram.
const byPage = new Map();
for (const r of results) if (r.match.c >= 0.9) byPage.set(r.match.o, r);

const pages = {};
const unmatched = [];
for (const r of results) {
  if (r.match.c >= 0.9) {
    pages[r.match.o] = { file: r.file, score: +r.match.c.toFixed(3), rot: r.match.rot, method: 'correlation' };
    continue;
  }
  const base = r.file.replace(/\.jpg$/, '');
  const partner = results.find(
    (p) => p.file === `${base} diagram.jpg` && p.match.c >= 0.9,
  );
  const n = partner ? Number(partner.match.o.match(/p(\d+)\.jpg/)[1]) - 1 : NaN;
  const target = Number.isFinite(n) ? `wiring-1993-p${String(n).padStart(4, '0')}.jpg` : null;
  if (target && !pages[target] && originals.includes(target)) {
    pages[target] = {
      file: r.file,
      score: +r.match.c.toFixed(3),
      rot: 0,
      method: 'spread-partner',
      note: `does not correlate; placed by its “${base} diagram” partner on the next page`,
    };
  } else {
    unmatched.push({ file: r.file, bestGuess: r.match.o, score: +r.match.c.toFixed(3) });
  }
}

// One supplied file is a duplicate of another (same page, different filename).
const byFile = new Map();
for (const [page, v] of Object.entries(pages)) byFile.set(v.file, page);
const duplicates = results.filter((r) => !byFile.has(r.file)).map((r) => ({
  file: r.file,
  duplicateOf: pages[r.match.o]?.file ?? null,
  page: r.match.o,
}));

const missing = originals.filter((o) => !pages[o]);

const manifest = {
  generated: new Date().toISOString(),
  source: path.basename(TRANS),
  counts: {
    supplied: files.length,
    mapped: Object.keys(pages).length,
    duplicates: duplicates.length,
    missing: missing.length,
  },
  pages,
  duplicates,
  missing,
  unmatched,
};
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');

console.log(`supplied ${files.length} · mapped ${manifest.counts.mapped} · duplicates ${duplicates.length} · missing ${missing.length}`);
if (duplicates.length) for (const d of duplicates) console.log('  duplicate', d.file, '→ same page as', d.duplicateOf);
if (missing.length) console.log('  missing:', missing.join(' '));
if (unmatched.length) for (const u of unmatched) console.log('  unmatched', u.file, '→', u.bestGuess, u.score);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
