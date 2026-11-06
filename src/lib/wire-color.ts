// Port of rx7_blog's wireColorUtils — pure logic, no framework.
const MAP: Record<string, { hex: string; fg: string }> = {
  red: { hex: '#dc2626', fg: '#ffffff' },
  black: { hex: '#171717', fg: '#ffffff' },
  yellow: { hex: '#facc15', fg: '#171717' },
  green: { hex: '#16a34a', fg: '#ffffff' },
  white: { hex: '#e5e7eb', fg: '#171717' },
  blue: { hex: '#2563eb', fg: '#ffffff' },
  brown: { hex: '#b45309', fg: '#ffffff' },
  orange: { hex: '#ea580c', fg: '#ffffff' },
  purple: { hex: '#a855f7', fg: '#ffffff' },
  pink: { hex: '#ec4899', fg: '#ffffff' },
};

const findKey = (s: string) => {
  const lower = s.toLowerCase();
  return Object.keys(MAP).find((k) => lower.includes(k)) ?? null;
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
        return `background:linear-gradient(135deg,${h1} 50%,${h2} 50%);color:${MAP[a].fg}`;
      }
    }
  }

  const k = findKey(color);
  if (k) return `background:${MAP[k].hex};color:${MAP[k].fg}`;
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
