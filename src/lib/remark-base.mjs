// Astro 7 renders markdown with Sätteri, whose plugins are visitor objects
// rather than unified transformers. This one prefixes every root-absolute URL
// with the deployed base path (markdown lives at any depth, so `/images/…`
// would otherwise escape the subfolder) and rewrites the legacy paths from the
// old react-static site to their new homes.
const LEGACY = {
  '/projects': '/personal/projects',
  '/blog': '/personal/blog',
};

export default function remarkBase({ base = '/', redirects = LEGACY } = {}) {
  const prefix = base !== '/' ? base.replace(/\/$/, '') : '';

  const rewrite = (url) => {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return url;
    if (/^(https?:|mailto:|tel:)/.test(url)) return url;

    let out = url;
    for (const [from, to] of Object.entries(redirects)) {
      if (out === from) {
        out = to;
        break;
      }
      if (out.startsWith(`${from}/`)) {
        out = to + out.slice(from.length);
        break;
      }
    }
    return prefix ? `${prefix}${out}` : out;
  };

  const setUrl = (node, ctx) => {
    const next = rewrite(node.url);
    if (next !== node.url) ctx.replaceNode(node, { ...node, url: next });
  };

  return {
    name: 'remark-base',
    link: setUrl,
    image: setUrl,
    definition: setUrl,
    html(node, ctx) {
      if (typeof node.value !== 'string' || !node.value.includes('="/')) return;
      const next = node.value.replace(/(src|href)="(\/[^"]*)"/g, (match, attr, url) => {
        const rewritten = rewrite(url);
        return rewritten === url ? match : `${attr}="${rewritten}"`;
      });
      if (next !== node.value) ctx.replaceNode(node, { ...node, value: next });
    },
  };
}
