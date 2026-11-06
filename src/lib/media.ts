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
