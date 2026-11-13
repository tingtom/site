import { readFileSync } from 'node:fs';
import path from 'node:path';
import { u } from './url';

/**
 * Where a named entry lives on a diagram scan.
 *
 * Every box is stored as a **fraction of the image** (`x + w <= 1`), never in
 * pixels: four pages are tight portrait crops (1235x1800) while the rest are
 * landscape scans (1800x1385), and a pixel box that is right in one coordinate
 * system silently misses in the other.
 *
 * `src/data/diagram-regions.json` is written by
 * `scripts/wiring-diagram-processor/locate-regions.mjs`, which records the
 * pixel size it measured on as `measured` and divides every box by it. The
 * fractions are the contract; `measured` is provenance.
 */
export type RegionKind = 'component' | 'connector' | 'ecuPin';

export interface Region {
  /** Must match an entry string in the page's frontmatter, exactly. */
  label: string;
  kind: RegionKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PageRegions {
  measured?: { w: number; h: number };
  model?: string;
  regions?: Array<Partial<Region>>;
}

const FILE = path.join(process.cwd(), 'src/data/diagram-regions.json');
const KINDS: RegionKind[] = ['component', 'connector', 'ecuPin'];

let cache: Record<string, PageRegions> | null = null;

function read(): Record<string, PageRegions> {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, PageRegions>;
    } catch {
      cache = {};
    }
  }
  return cache;
}

const isFraction = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Regions for one scan, ready to paint.
 *
 * Invalid entries are dropped rather than rendered: a `NaN` or an out-of-range
 * fraction would put a box somewhere arbitrary, which is worse than no
 * interaction at all. Boxes are sorted largest first so the small ones land on
 * top where labels overlap.
 */
export function diagramRegions(file: string): Region[] {
  const name = file.split('/').pop() ?? '';
  const page = read()[name];
  if (!page?.regions?.length) return [];

  const seen = new Set<string>();
  return page.regions
    .filter((r): r is Region => {
      if (typeof r.label !== 'string' || !r.label.trim()) return false;
      if (!KINDS.includes(r.kind as RegionKind)) return false;
      if (![r.x, r.y, r.w, r.h].every(isFraction)) return false;
      if (r.w! <= 0 || r.h! <= 0) return false;
      if (r.x! + r.w! > 1.002 || r.y! + r.h! > 1.002) return false;
      return true;
    })
    .filter((r) => {
      // One box per entry: a second box with the same label would be a
      // different occurrence the sidebar cannot distinguish, so keep the first
      // (largest, after the sort below).
      if (seen.has(r.label)) return false;
      seen.add(r.label);
      return true;
    })
    .sort((a, b) => b.w * b.h - a.w * a.h);
}

/** Does this page have a box for this exact entry string? */
export function hasRegion(file: string, label: string): boolean {
  return diagramRegions(file).some((r) => r.label === label);
}

/** The scan a region is on, from an entry that may show several pages. */
export function regionPage(images: string[], label: string): string | null {
  return images.find((img) => hasRegion(img, label)) ?? null;
}

export const KIND_NOUN: Record<RegionKind, string> = {
  component: 'component',
  connector: 'connector',
  ecuPin: 'ECU pin',
};

/** Full-resolution href for the page's own scan, for the caption link. */
export function regionHref(file: string): string {
  return u(`/diagrams/${file}`);
}
