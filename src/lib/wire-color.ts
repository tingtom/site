// Port of rx7_blog's wireColorUtils — pure logic, no framework.
const MAP: Record<string, { hex: string }> = {
  red: { hex: '#dc2626' },
  black: { hex: '#171717' },
  yellow: { hex: '#facc15' },
  green: { hex: '#16a34a' },
  white: { hex: '#e5e7eb' },
  blue: { hex: '#2563eb' },
  brown: { hex: '#b45309' },
  orange: { hex: '#ea580c' },
  purple: { hex: '#a855f7' },
  pink: { hex: '#ec4899' },
  gray: { hex: '#9ca3af' },
  grey: { hex: '#9ca3af' },
  violet: { hex: '#7c3aed' },
  turquoise: { hex: '#14b8a6' },
  peach: { hex: '#fdba74' },
};

const findKey = (s: string) => {
  const lower = s.toLowerCase();
  return Object.keys(MAP).find((k) => lower.includes(k)) ?? null;
};

/* --- contrast ------------------------------------------------------------ */

const luminance = (hex: string) => {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Black or white, whichever reads better — and for a split swatch, whichever
 * has the better *worst case* across both halves, since a 50/50 gradient
 * can't use one fixed text colour.
 *
 * Applied to solid chips too: green/pink/orange/purple all fail WCAG with
 * white (3.3–4.0 against 4.5 needed), which is what Lighthouse flagged on the
 * diagrams index.
 */
const bestFg = (...bgs: string[]) => {
  const worst = (fg: string) => Math.min(...bgs.map((bg) => contrast(fg, bg)));
  return worst('#ffffff') >= worst('#171717') ? '#ffffff' : '#171717';
};

/** Inline style for a wire-colour chip, or null when the colour is unknown. */
export function wireStyle(color: string): string | null {
  const sep = /[\/\-|]/.exec(color);
  if (sep) {
    const parts = color.split(sep[0]).map((p) => p.trim());
    if (parts.length >= 2) {
      const a = findKey(parts[0]);
      const b = findKey(parts[1]);
      if (a && b && a !== b) {
        const h1 = MAP[a].hex;
        const h2 = MAP[b].hex;
        return `background:linear-gradient(135deg,${h1} 50%,${h2} 50%);color:${bestFg(h1, h2)}`;
      }
    }
  }

  const k = findKey(color);
  if (k) return `background:${MAP[k].hex};color:${bestFg(MAP[k].hex)}`;
  return null;
}

/** Plain background/text colours, for use where a style attribute is awkward. */
export function wireColors(color: string): { bg: string; fg: string } {
  const style = wireStyle(color);
  if (!style) return { bg: 'transparent', fg: 'inherit' };
  const grad = /linear-gradient\(135deg,([^,]+),([^)]+)\)/.exec(style);
  if (grad) return { bg: grad[1].trim(), fg: /color:([^;]+)/.exec(style)?.[1] ?? 'inherit' };
  return {
    bg: /background:([^;]+)/.exec(style)?.[1] ?? 'transparent',
    fg: /color:([^;]+)/.exec(style)?.[1] ?? 'inherit',
  };
}
