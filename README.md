# tingtom.site

One site, two halves: **personal** (blog + projects) and **rx7** (wiring
diagrams, 3D models, RX7 posts).

Built with [Astro](https://astro.build) and edited through
[Sveltia CMS](https://github.com/sveltia/sveltia-cms) at `/admin/`.

## Layout

```
/                     split-screen landing: Personal | RX7
/personal/            intro, latest posts, featured projects
/personal/blog/       + [slug]
/personal/projects/   + [slug]
/rx7/                 RX7 hub
/rx7/blog/            RX7-filtered view of the same posts collection
/rx7/diagrams/        + [slug] — client-side search over the rendered cards
/rx7/models/          + [slug] — in-browser STL/GLB viewer
/admin/               Sveltia CMS (noindex)
```

Navigation is deliberately not a top menu bar: a brand mark top-left, a
Personal ⇄ RX7 toggle top-right, and vertical tabs pinned to the left edge that
collapse into a horizontal strip on narrow screens.

## Content collections

| Collection  | Folder                  | Notes                                        |
| ----------- | ----------------------- | -------------------------------------------- |
| `posts`     | `src/content/posts`     | `sections: [personal, rx7]` picks which blog |
| `projects`  | `src/content/projects`  |                                              |
| `models`    | `src/content/models`    | `file` points into `public/models`           |
| `diagrams`  | `src/content/diagrams`  | `images[]` points into `public/diagrams`     |

`slug` is optional: hand-migrated entries carry their own, and anything
authored in the CMS falls back to the filename.

## Local development

```bash
npm install
npm run dev
```

Requires Node ≥ 22.23.4 (Astro 7).

## Deploying

GitHub Actions builds `dist/` and publishes it to Pages on every push to
`main`.

The site is served from a **subfolder of your custom domain** —
`https://tmathews.co.uk/site/` (GitHub serves project pages under the
account's custom domain) — and is also reachable at
`https://tingtom.github.io/site/`. Two values control that, both in
`.github/workflows/deploy.yml` and `astro.config.mjs`:

- `PUBLIC_BASE` — `/site/` now, `/` if it ever moves to the domain root
- `PUBLIC_SITE_URL` — the canonical origin used for sitemap/OG URLs

## CMS

`/admin/` runs Sveltia against this repo. There is no OAuth proxy — sign in
with a fine-grained GitHub PAT scoped to this repository with
**Contents: Read and write**. The token is stored in the browser only.
