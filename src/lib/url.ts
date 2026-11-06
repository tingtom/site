const BASE = import.meta.env.BASE_URL;

/** Prefix a root-absolute path with the deployed base (`/site/`). */
export function u(path) {
  if (/^(https?:|mailto:|tel:|#|data:)/.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  const prefix = BASE === '/' ? '' : BASE.replace(/\/$/, '');
  return `${prefix}${p}`;
}

/** True when `href` is the current page (used for active nav states). */
export function isActive(pathname, href) {
  const target = u(href);
  if (target === `${BASE}` || target === `${BASE}index.html`) {
    return pathname === target || pathname === `${BASE}index.html`;
  }
  return pathname === target || pathname.startsWith(`${target}/`);
}
