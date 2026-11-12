/**
 * Render every model's card preview from its own 3D file.
 *
 * The cards used to carry whatever was to hand — a 90×90 icon blown up to
 * fill a 16:10 box, a photo with a mean brightness of 11, a render from some
 * arbitrary angle — so the grid read as six unrelated things. This drives
 * headless Chromium at the model page's own viewer in `?render=1` mode, which
 * pins the canvas to the viewport, stops the auto-rotation and hides the rest
 * of the page, then saves the frame. Same lights, same material, same camera
 * solve as a visitor sees, so a preview cannot drift from the live viewer.
 *
 * Output: public/images/models/<slug>.webp at 1600×1000 (exactly the card's
 * 16:10, so `object-fit: cover` crops nothing), and the entry's `preview:`
 * field is pointed at it.
 *
 * Usage:
 *   PATH=/opt/node22/bin:$PATH node scripts/render-model-previews.mjs
 *   ... --only fd3s-rx7-strut-brace-guards     one model
 *   ... --no-update                            render, leave frontmatter alone
 *
 * Needs a server on BASE_URL (default http://localhost:4321/site). If none is
 * running it starts `astro dev` itself and stops it again afterwards.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'src/content/models');
const PUBLIC = path.join(ROOT, 'public');
const BASE = process.env.BASE_URL || 'http://localhost:4321/site';
const SIZE = { w: 1600, h: 1000 };

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const update = !args.includes('--no-update');

/** Chromium/Chrome, wherever this machine keeps it. */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('No Chromium found — set CHROMIUM=/path/to/chromium');
}

/** Pull `slug`, `file` and `preview` out of a frontmatter block. */
function parseEntry(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const field = (name) => {
    const m = match[1].match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  return { head: match[1], slug: field('slug'), file: field('file'), preview: field('preview') };
}

/**
 * Point `preview:` at the generated file, adding the field if the entry never
 * had one. Only the top-level key is touched — `files:` lists their own
 * `file:` keys deeper in the block, which is why this anchors on column 0.
 */
function setPreview(head, value) {
  if (/^preview:/m.test(head)) return head.replace(/^preview:.*$/m, `preview: ${value}`);
  const anchor = /^file:.*$/m.exec(head);
  if (anchor) {
    const at = head.indexOf(anchor[0]) + anchor[0].length;
    return `${head.slice(0, at)}\npreview: ${value}${head.slice(at)}`;
  }
  return `${head}\npreview: ${value}`;
}

/**
 * Is something listening? Probes with a trailing slash because Astro serves
 * `/site/` but 404s on `/site`, and a 404 still proves the server is up — so
 * any HTTP answer counts as reachable, only a connection failure does not.
 */
async function reachable(url) {
  try {
    await fetch(url.replace(/\/?$/, '/'), { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

/** Wait for the dev server, starting one if nothing is listening. */
async function ensureServer() {
  if (await reachable(BASE)) return { started: false };
  console.log(`No server at ${BASE} — starting astro dev…`);
  spawn('npm', ['run', 'dev'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await reachable(BASE)) return { started: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Dev server did not come up at ${BASE} within 90s`);
}

async function stopServer() {
  try {
    execFileSync(path.join(ROOT, 'node_modules/.bin/astro'), ['dev', 'stop'], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    /* already gone — nothing to do */
  }
}

/**
 * One screenshot.
 *
 * Chromium writes the file and *then* sometimes hangs on shutdown — the Vite
 * HMR websocket on a dev page keeps it from going idle — so waiting for the
 * process to exit is the wrong signal and costs a timeout on every run. Poll
 * for the file instead, kill the browser once its size has stopped moving,
 * and let the caller validate the bytes.
 */
async function capture(chromium, url, out, budget) {
  rmSync(out, { force: true });

  const child = spawn(
    chromium,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      `--window-size=${SIZE.w},${SIZE.h}`,
      `--virtual-time-budget=${budget}`,
      `--screenshot=${out}`,
      url,
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();

  const deadline = Date.now() + 90_000;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const size = existsSync(out) ? statSync(out).size : -1;
    if (size > 0 && size === previous) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
    previous = size;
    await new Promise((r) => setTimeout(r, 250));
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }

  if (!existsSync(out)) throw new Error('chromium wrote no screenshot');
}

/**
 * Did the model actually reach the frame? A capture taken before the mesh
 * loads is just background and grid, which would ship as a blank card. Bright
 * pixels are the model — the grid tops out around 70, the background is 22.
 */
async function isUsable(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let lit = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 100) lit++;
  }
  return lit / (info.width * info.height) > 0.01;
}

const chromium = findChromium();
const server = await ensureServer();

const files = (await readdir(CONTENT)).filter((f) => f.endsWith('.md')).sort();
const entries = [];
for (const file of files) {
  const text = await readFile(path.join(CONTENT, file), 'utf8');
  const parsed = parseEntry(text);
  if (!parsed) continue;
  if (!parsed.file.startsWith('/models/')) continue; // hosted on Printables: no mesh to render
  if (only && parsed.slug !== only) continue;
  entries.push({ md: file, ...parsed });
}

if (entries.length === 0) {
  console.log('Nothing to render — no entries with a local model file matched.');
  if (server.started) await stopServer();
  process.exit(0);
}

const rows = [];
let failures = 0;

for (const entry of entries) {
  const url = `${BASE.replace(/\/$/, '')}/rx7/models/${entry.slug}/?render=1`;
  const png = path.join(PUBLIC, 'images/models', `.${entry.slug}.render.png`);
  const webp = path.join(PUBLIC, 'images/models', `${entry.slug}.webp`);
  const rel = `/images/models/${entry.slug}.webp`;

  process.stdout.write(`${entry.slug} … `);
  try {
    let ok = false;
    for (const budget of [12_000, 30_000]) {
      await capture(chromium, url, png, budget);
      if (await isUsable(png)) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error('model never appeared in frame');

    // toFile() resolves to the info object itself — unlike toBuffer() with
    // resolveWithObject, there is no { data, info } wrapper to destructure.
    const info = await sharp(png)
      .resize(SIZE.w, SIZE.h, { fit: 'cover' })
      .webp({ quality: 82, effort: 4 })
      .toFile(webp);
    rmSync(png, { force: true });

    const changed = entry.preview !== rel;
    if (update && changed) {
      const full = path.join(CONTENT, entry.md);
      const text = await readFile(full, 'utf8');
      await writeFile(full, text.replace(entry.head, setPreview(entry.head, rel)));
    }

    const kb = `${(statSync(webp).size / 1024).toFixed(0)} KB`;
    rows.push({ slug: entry.slug, changed });
    console.log(`ok ${info.width}×${info.height} ${kb}${changed ? ' → preview updated' : ''}`);
  } catch (err) {
    failures++;
    rows.push({ slug: entry.slug, error: err.message });
    console.log(`FAILED — ${err.message}`);
  }
}

console.log(`\n${rows.length - failures}/${rows.length} rendered into public/images/models/`);
if (failures) console.log(`${failures} failed — their existing previews were left untouched.`);

if (server.started) {
  console.log('Stopping the dev server this script started.');
  await stopServer();
}
process.exit(failures ? 1 : 0);
