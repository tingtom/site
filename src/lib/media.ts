import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { u } from './url';

/**
 * Resolve a media path referenced from frontmatter.
 *
 * Hand-authored entries store a bare filename (`ucg.png`), while Sveltia writes
 * the configured `public_folder` (`/images/projects/ucg.png`). Accept both so
 * neither side has to care which produced the value.
 */
export function asset(file: string, dir: string): string {
  if (!file) return '';
  return u(file.startsWith('/') ? file : `${dir}/${file}`);
}

/**
 * Resolve a diagram scan to a derivative when one has been generated.
 *
 * The scans are 2–4 MB camera photos; `scripts/optimize-images.mjs` writes
 * `thumbs/` (cards, ~560 px) and `view/` (page figures, ~1800 px) next to the
 * original, which stays where it is for the "full resolution" link. Anything
 * uploaded since the last run simply falls back to the original.
 */
export function diagramSrc(file: string, kind: 'thumb' | 'view'): string {
  const base = asset(file, '/diagrams');
  if (!base) return '';
  const name = base.split('/').pop() ?? '';
  const dir = kind === 'thumb' ? 'thumbs' : 'view';
  const generated = path.join(process.cwd(), 'public', 'diagrams', dir, name);
  if (name && fs.existsSync(generated)) return u(`/diagrams/${dir}/${name}`);
  return base;
}

let sizes: Record<string, { w: number; h: number; tw?: number; th?: number }> | null = null;

function readSizes() {
  if (!sizes) {
    try {
      sizes = JSON.parse(
        readFileSync(path.join(process.cwd(), 'public', 'diagrams', 'sizes.json'), 'utf8'),
      );
    } catch {
      sizes = {};
    }
  }
  return sizes;
}

/**
 * Intrinsic size of a scan's `view/` derivative, written by the optimize
 * script, so a figure can reserve its aspect ratio instead of shifting the
 * page when the image lands.
 */
export function diagramSize(file: string): { w: number; h: number } | null {
  const name = asset(file, '/diagrams').split('/').pop();
  if (!name) return null;
  const entry = readSizes()[name];
  return entry ? { w: entry.w, h: entry.h } : null;
}

/** Same, for the `thumbs/` derivative that cards render. */
export function diagramThumbSize(file: string): { w: number; h: number } | null {
  const name = asset(file, '/diagrams').split('/').pop();
  if (!name) return null;
  const entry = readSizes()[name];
  return entry?.tw ? { w: entry.tw, h: entry.th ?? 0 } : null;
}

let enSizes: Record<string, { w: number; h: number }> | null = null;
let provenance: Record<string, string> | null = null;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'diagrams', 'en', file), 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The English translation of a scan, when one has been built.
 *
 * `scripts/build-en-diagrams.mjs` writes `en/<page>.jpg` from the author's
 * hand-translated scans, keyed by the page number of the original it replaces.
 * Four harness pages have no translation yet, and the four pages whose
 * supplied file was missing or machine-translated later fall back here — so a
 * null return means "this page is still Japanese", which the figure says
 * rather than letting the reader assume.
 */
export function diagramEn(file: string): string | null {
  const name = asset(file, '/diagrams').split('/').pop();
  if (!name) return null;
  const disk = path.join(process.cwd(), 'public', 'diagrams', 'en', name);
  return fs.existsSync(disk) ? u(`/diagrams/en/${name}`) : null;
}

/** Intrinsic size of that translation, so the figure reserves its box. */
export function diagramEnSize(file: string): { w: number; h: number } | null {
  const name = asset(file, '/diagrams').split('/').pop();
  if (!name) return null;
  enSizes ??= readJson<Record<string, { w: number; h: number }>>('sizes.json') ?? {};
  const entry = enSizes[name];
  return entry ? { w: entry.w, h: entry.h } : null;
}

/**
 * Where the displayed translation came from: `supplied` (the author's own
 * hand translation), `machine` (the pipeline's), or `none` (still Japanese).
 * The page labels the figure accordingly, because a reader should be able to
 * tell a reviewed translation from a generated one.
 */
export function diagramTranslation(file: string): 'supplied' | 'machine' | 'none' {
  const name = asset(file, '/diagrams').split('/').pop();
  if (!name) return 'none';
  provenance ??= readJson<Record<string, string>>('provenance.json') ?? {};
  return (provenance[name] as 'supplied' | 'machine' | 'none') ?? 'none';
}

const sizeCache = new Map<string, { w: number; h: number } | null>();

/**
 * `srcset` for a public image, built from the WebP candidates that
 * `scripts/optimize-images.mjs` writes into `<dir>/resp/`.
 *
 * Returns null when none exist (an image added since the last run, or one too
 * small to be worth rescaling), in which case callers fall back to a plain
 * `src`.
 */
export function srcset(file: string, dir: string, widths: number[]): string | null {
  if (!file) return null;
  const rel = file.startsWith('/') ? file : `${dir}/${file}`;
  const parsed = path.parse(rel);
  const candidates: string[] = [];

  for (const w of widths) {
    const name = `${parsed.name}-${w}.webp`;
    const disk = path.join(process.cwd(), 'public', parsed.dir, 'resp', name);
    if (fs.existsSync(disk)) candidates.push(`${u(`${parsed.dir}/resp/${name}`)} ${w}w`);
  }

  return candidates.length ? candidates.join(', ') : null;
}

/**
 * Intrinsic size of any file under `public/`, read at build time with sharp.
 *
 * Cards set `width`/`height` from this so the browser can reserve the box
 * before the bytes arrive (Lighthouse's `unsized-images`). Falls back to null
 * when the file is missing or unreadable, in which case the attribute is
 * simply omitted.
 */
export async function imageSize(
  file: string,
  dir: string,
): Promise<{ w: number; h: number } | null> {
  if (!file) return null;
  const disk = path.join(process.cwd(), 'public', file.startsWith('/') ? file : `${dir}/${file}`);
  if (sizeCache.has(disk)) return sizeCache.get(disk) ?? null;

  let result: { w: number; h: number } | null = null;
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(disk).metadata();
    if (meta.width && meta.height) result = { w: meta.width, h: meta.height };
  } catch {
    result = null;
  }
  sizeCache.set(disk, result);
  return result;
}
