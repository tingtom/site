import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { u } from '../lib/url';

const now = new Date().toISOString();

export const GET: APIRoute = async ({ site }) => {
  const origin = (site ?? new URL('https://tingtom.github.io/site/')).origin;

  const paths = ['/', '/personal/', '/personal/blog/', '/personal/projects/', '/rx7/', '/rx7/blog/', '/rx7/diagrams/', '/rx7/models/'];

  const [posts, projects, models, diagrams] = await Promise.all([
    getCollection('posts'),
    getCollection('projects'),
    getCollection('models'),
    getCollection('diagrams'),
  ]);

  for (const p of posts) {
    paths.push(p.data.sections.includes('rx7') ? `/rx7/blog/${p.data.slug ?? p.id}` : `/personal/blog/${p.data.slug ?? p.id}`);
  }
  for (const p of projects) paths.push(`/personal/projects/${p.data.slug ?? p.id}`);
  for (const m of models) paths.push(`/rx7/models/${m.data.slug ?? m.id}`);
  for (const d of diagrams) paths.push(`/rx7/diagrams/${d.data.slug ?? d.id}`);

  const urls = paths
    .map((p) => `  <url>\n    <loc>${origin}${u(p)}</loc>\n    <lastmod>${now}</lastmod>\n  </url>`)
    .join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
};
