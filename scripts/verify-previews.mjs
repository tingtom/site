// Re-render every model and compare its silhouette against the preview
// already saved on disk — a mismatch means a viewer change silently altered
// what a model looks like.
//
// This is the check that would have caught the silent failures along the way.
// It proved the collapse of orientation/yaw into a single `rotation` field
// was appearance-preserving, and it is worth re-running after any edit to
// axisFix(), fit() or the material code.
//
// Usage: BASE_URL=http://localhost:4399/site node scripts/verify-previews.mjs
import { execFileSync } from 'node:child_process';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BASE = process.env.BASE_URL || 'http://localhost:4399/site';
const CONTENT = path.join(process.cwd(), 'src/content/models');

// Every model that has a local file — the set grows as files are uploaded,
// so it is discovered rather than listed.
const MODELS = readdirSync(CONTENT)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({
    slug: (readFileSync(path.join(CONTENT, f), 'utf8').match(/^slug:\s*(\S+)/m) || [])[1] ?? f.replace(/\.md$/, ''),
    file: (readFileSync(path.join(CONTENT, f), 'utf8').match(/^file:\s*(.+)$/m) || [])[1] ?? '',
  }))
  .filter((m) => m.file.startsWith('/models/'))
  .map((m) => m.slug);

async function silhouette(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let minX = W, maxX = 0, minY = H, maxY = 0, lit = 0, edge = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 95) {
        lit++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        // touching the frame means the model is cropped out of the card
        if (y < 4 || y > H - 5 || x < 4 || x > W - 5) edge++;
      }
    }
  return { w: maxX - minX, h: maxY - minY, lit, edge, W, H };
}

let failures = 0;
console.log('model'.padEnd(36), 'saved'.padEnd(12), 're-rendered'.padEnd(12), 'verdict');
for (const slug of MODELS) {
  const png = `/tmp/opencode/migrate-${slug}.png`;
  rmSync(png, { force: true });
  execFileSync(
    '/usr/bin/chromium',
    [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--hide-scrollbars',
      '--window-size=1600,1000', '--virtual-time-budget=12000',
      `--screenshot=${png}`,
      `${BASE}/rx7/models/${slug}/?render=1`,
    ],
    { stdio: 'ignore', timeout: 90_000 },
  );
  const a = await silhouette(`public/images/models/${slug}.webp`);
  const b = await silhouette(png);
  // A few pixels of tolerance: same geometry, same camera, so it should be
  // near-identical; a real regression shows up as a different bounding box.
  const same = Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2;
  // The saved preview must also be a usable card image in its own right.
  const usable = a.W === 1600 && a.H === 1000 && a.edge === 0 && a.lit > 3000;
  const ok = same && usable;
  if (!ok) failures++;
  const why = !same ? 'silhouette changed' : !usable ? `cropped (edge ${a.edge})` : '';
  console.log(
    slug.padEnd(36),
    `${a.w}×${a.h}`.padEnd(12),
    `${b.w}×${b.h}`.padEnd(12),
    ok ? '✓ unchanged' : `✗ ${why}`,
  );
}
console.log(failures === 0 ? `\nall ${MODELS.length} previews: correct size, uncropped, reproducible` : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
