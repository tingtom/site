import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import remarkBase from './src/lib/remark-base.mjs';

// Deployed as a GitHub Pages project site, so it lives in a subfolder of the
// account's custom domain (GitHub serves project pages under it):
//   https://tmathews.co.uk/site/
// The same build also works at https://tingtom.github.io/site/. To move to the
// domain root later, set PUBLIC_BASE=/ and drop the path from PUBLIC_SITE_URL.
const base = process.env.PUBLIC_BASE || '/site/';

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || 'https://tmathews.co.uk/site',
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
