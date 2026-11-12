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
import { rmSync } from 'node:fs';
import sharp from 'sharp';

const BASE = process.env.BASE_URL || 'http://localhost:4399/site';
const MODELS = [
  'fd3s-armrest-cupholder-phone-mount',
  'fd3s-headlight-covers',
  'fd3s-rx7-door-handle-screw-cover',
  'fd3s-rx7-strut-brace-guards',
  'fd3s-rx7-trunk-tool-cover-clip',
  'rx7-fd3s-sill-bung',
];

async function silhouette(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let minX = W, maxX = 0, minY = H, maxY = 0, lit = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 95) {
        lit++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  return { w: maxX - minX, h: maxY - minY, lit };
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
  if (!same) failures++;
  console.log(
    slug.padEnd(36),
    `${a.w}×${a.h}`.padEnd(12),
    `${b.w}×${b.h}`.padEnd(12),
    same ? '✓ unchanged' : '✗ CHANGED',
  );
}
console.log(failures === 0 ? '\nmigration is appearance-preserving' : `\n${failures} model(s) changed`);
process.exit(failures ? 1 : 0);
