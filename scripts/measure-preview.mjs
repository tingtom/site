// How does a rendered preview sit? Measures the model's silhouette from a
// capture: bounding box, aspect, and how wide its base is relative to its
// widest point — a narrow base reads as "standing on edge", a broad one as
// "settled".
import sharp from 'sharp';

const path = process.argv[2];
const { data, info } = await sharp(path)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// model pixels: brighter than the grid (which tops out around 70) and the
// background (22). Red models have r well above g/b; keep it general.
const isModel = (r, g, b) => Math.max(r, g, b) > 95;

let minX = W,
  maxX = 0,
  minY = H,
  maxY = 0,
  lit = 0,
  red = 0;
const colCount = new Array(W).fill(0);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * C;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    if (!isModel(r, g, b)) continue;
    lit++;
    if (r > g + 40 && r > b + 40) red++;
    colCount[x]++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

const bw = maxX - minX;
const bh = maxY - minY;
const aspect = bw / bh;

// width of the silhouette in its lowest 10%, as a fraction of the widest row
let baseCols = 0;
let widest = 0;
for (let x = minX; x <= maxX; x++) {
  let inBase = 0;
  for (let y = maxY - Math.max(1, Math.round(bh * 0.1)); y <= maxY; y++) {
    const i = (y * W + x) * C;
    if (isModel(data[i], data[i + 1], data[i + 2])) inBase++;
  }
  if (inBase) baseCols++;
}
for (let x = minX; x <= maxX; x++) {
  let n = 0;
  for (let y = minY; y <= maxY; y++) {
    const i = (y * W + x) * C;
    if (isModel(data[i], data[i + 1], data[i + 2])) n++;
  }
  if (n > 0) widest++;
}

const baseRatio = widest ? baseCols / widest : 0;

console.log(
  path.split('/').pop().padEnd(34),
  `${bw}×${bh}`.padEnd(10),
  'aspect ' + aspect.toFixed(2).padStart(5),
  '| base ' + (100 * baseRatio).toFixed(0).padStart(3) + '% of width',
  '| red ' + ((100 * red) / Math.max(lit, 1)).toFixed(0) + '%',
  aspect > 1.05 ? '→ wide, settled' : aspect < 0.85 ? '→ TALL/narrow (on edge)' : '→ roughly square',
);
