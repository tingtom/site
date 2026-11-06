import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import remarkBase from './src/lib/remark-base.mjs';

// Deployed as a GitHub Pages *project* site, so it lives under a subfolder:
//   https://tingtom.github.io/site/
// At the custom-domain cutover (tmathews.co.uk) set PUBLIC_BASE=/ so the
// site serves from the domain root instead.
const base = process.env.PUBLIC_BASE || '/site/';

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || 'https://tingtom.github.io/site',
  base,
  output: 'static',
  // Inline all CSS into <head>: no render-blocking stylesheet request, and the
  // self-hosted fontsource faces bundle into it too.
  build: { inlineStylesheets: 'always' },
  markdown: {
    processor: satteri({
      // Prefix every root-absolute link/image in markdown with the base path,
      // and rewrite the old site's /blog and /projects URLs to their new homes.
      mdastPlugins: [() => remarkBase({ base })],
    }),
  },
});
