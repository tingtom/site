/**
 * One-off image tuning for the site.
 *
 * The diagram scans are 212 MB of camera photos (avg 2.5 MB each) that were
 * being served at full resolution for a 280 px card thumbnail and for the
 * inline figure on a diagram page. This writes two derivatives per scan and
 * re-encodes the few oversized images elsewhere:
 *
 *   public/diagrams/thumbs/<file>  ~560 px wide   → cards, lists
 *   public/diagrams/view/<file>    ~1800 px wide   → the diagram page figure
 *   public/diagrams/<file>         untouched       → "full resolution" link
 *
 * src/lib/media.ts picks a derivative when it exists and falls back to the
 * original, so a scan uploaded through the CMS before this is re-run still
 * renders.
 *
 * Run with:  PATH=/opt/node22/bin:$PATH node scripts/optimize-images.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const DIAGRAMS = path.join(ROOT, 'public/diagrams');
const THUMBS = path.join(DIAGRAMS, 'thumbs');
const VIEWS = path.join(DIAGRAMS, 'view');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function derivatives() {
  await mkdir(THUMBS, { recursive: true });
  await mkdir(VIEWS, { recursive: true });
  const files = (await readdir(DIAGRAMS)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  let before = 0;
  let after = 0;
  const sizes = {};

  for (const file of files) {
    const src = path.join(DIAGRAMS, file);
    before += (await stat(src)).size;

    const thumb = path.join(THUMBS, file);
    const view = path.join(VIEWS, file);
    if (!(await exists(thumb))) {
      await sharp(src)
        .rotate()
        .resize({ width: 560, withoutEnlargement: true })
        .jpeg({ quality: 66, progressive: true, mozjpeg: true })
        .toFile(thumb);
    }
    if (!(await exists(view))) {
      await sharp(src)
        .rotate()
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 78, progressive: true, mozjpeg: true })
        .toFile(view);
    }
    const meta = await sharp(view).metadata();
    const tmeta = await sharp(thumb).metadata();
    sizes[file] = { w: meta.width, h: meta.height, tw: tmeta.width, th: tmeta.height };
    after += (await stat(thumb)).size + (await stat(view)).size;
  }

  // lets the figure reserve its aspect ratio before the bytes arrive
  await writeFile(path.join(DIAGRAMS, 'sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);

  console.log(
    `diagrams: ${files.length} scans, ${kb(before)} of originals → ${kb(after)} of thumbs/ + view/`,
  );
}

/**
 * Width-matched WebP candidates for `<img srcset>`.
 *
 * A 1024 px screenshot rendered into a 330 px card was shipping every byte;
 * these give the browser something right-sized to pick at each DPR.
 * `src/lib/media.ts#srcset` only lists candidates that exist here.
 */
async function responsive(dir, widths) {
  const base = path.join(ROOT, 'public', dir);
  const out = path.join(base, 'resp');
  await mkdir(out, { recursive: true });
  const files = (await readdir(base)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  let written = 0;
  let bytes = 0;

  for (const file of files) {
    const src = path.join(base, file);
    const meta = await sharp(src).metadata();
    if (!meta.width) continue;
    const stem = file.replace(/\.[^.]+$/, '');

    for (const w of widths) {
      if (w >= meta.width) continue;
      const target = path.join(out, `${stem}-${w}.webp`);
      if (await exists(target)) continue;
      await sharp(src)
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toFile(target);
      bytes += (await stat(target)).size;
      written++;
    }
  }

  console.log(`${dir}/resp: ${written} candidates, ${kb(bytes)}`);
}

/** Squeeze a JPEG or PNG in place, keeping the filename so frontmatter is untouched. */
async function inPlace(rel, { width, format }) {
  const target = path.join(ROOT, 'public', rel);
  if (!(await exists(target))) return console.log(`skip (missing): ${rel}`);
  const before = (await stat(target)).size;

  let pipeline = sharp(target).rotate();
  if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });

  const tmp = `${target}.tmp`;
  if (format === 'jpeg') {
    await pipeline.jpeg({ quality: 78, progressive: true, mozjpeg: true }).toFile(tmp);
  } else {
    await pipeline.png({ compressionLevel: 9, palette: true, quality: 85, effort: 7 }).toFile(tmp);
  }
  await rename(tmp, target);

  console.log(`${rel}: ${kb(before)} → ${kb((await stat(target)).size)}`);
}

await derivatives();

// rx7-bg.jpg was saved as a BMP under a .jpg name — 2.2 MB, and sharp and
// every CDN image pipeline refuse to decode it. ImageMagick reads BMP fine.
// Re-run safe: once it decodes as a real JPEG we leave it alone.
{
  const target = path.join(ROOT, 'public/images/rx7/rx7-bg.jpg');
  const decodes = await sharp(target)
    .metadata()
    .then(() => true, () => false);
  if (!decodes) {
    const before = (await stat(target)).size;
    const tmp = path.join(ROOT, 'public/images/rx7/.rx7-bg.tmp.jpg');
    execFileSync('convert', [
      target,
      '-auto-orient',
      '-resize',
      '1600x',
      '-quality',
      '78',
      '-strip',
      tmp,
    ]);
    await rename(tmp, target);
    console.log(
      `images/rx7/rx7-bg.jpg (BMP → JPEG): ${kb(before)} → ${kb((await stat(target)).size)}`,
    );
  }
}

// The two project images that dominate /personal/projects/ and /rx7/ load time.
await inPlace('images/projects/hle.jpg', { width: 1400, format: 'jpeg' });
await inPlace('images/projects/ucg.png', { width: 1400, format: 'png' });

// Right-sized candidates for srcset — card thumbnails and the RX7 hero.
await responsive('images/projects', [320, 480, 640, 800, 1024, 1400]);
await responsive('images/rx7', [400, 800, 1600]);
