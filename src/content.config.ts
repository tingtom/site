import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const sections = z.array(z.string()).default(['personal']);

// Optional: entries authored in the CMS are named after their title, so the
// filename (entry.id) is used as the slug when the field is left blank.
// Sveltia writes an explicit `slug: ''` for a blank field, so empty means
// absent — without this the post's URL would come out as an empty string.
const slug = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    slug,
    date: z.coerce.date(),
    mins: z.number().default(0),
    summary: z.string().default(''),
    sections,
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    slug,
    summary: z.string().default(''),
    image: z.string().default(''),
    homepage: z.boolean().default(false),
    sections,
  }),
});

const models = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/models' }),
  schema: z.object({
    title: z.string(),
    slug,
    description: z.string().default(''),
    // A second line for the sidebar: print times, material hints, provenance.
    // Model pages render no body markdown — the description sits in the
    // sidebar next to the preview, and repeating it under a second heading
    // made every page say the same thing twice.
    notes: z.string().default(''),
    // Optional: a model whose files live somewhere else (Printables, GitHub
    // releases) has no local STL to preview, and forcing one would mean
    // rehosting someone else's work under a licence that may not allow it.
    // With no file the detail page skips the 3D viewer and leads with `files`.
    file: z.string().optional(),
    preview: z.string().default(''),
    category: z.string().default(''),
    downloads: z.number().default(0),
    date: z.coerce.date().optional(),
    // Attribution for a model designed by someone else. CC BY-NC-ND work can be
    // hosted here only with the credit and licence kept intact, so both are
    // rendered on the card and the detail page rather than buried in prose.
    credit: z.string().default(''),
    licence: z.string().default(''),
    source: z.string().default(''),
    // Downloads that are not the previewed file: the other side of a pair, the
    // STEP originals, a zip, print notes. Each row can either hold an uploaded
    // file (`file`) or point somewhere else (`href`) — upload OR link, not
    // forced to one. `href` stays optional so existing URL-only rows and
    // hand-written frontmatter keep parsing.
    files: z
      .array(
        z.object({
          label: z.string(),
          file: z.string().default(''),
          href: z.string().default(''),
          note: z.string().default(''),
        }),
      )
      .default([]),
    sections,
  }),
});

const diagrams = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/diagrams' }),
  schema: z.object({
    title: z.string(),
    slug,
    description: z.string().default(''),
    images: z.array(z.string()).min(1),
    category: z.string().default(''),
    yearRange: z.string().default(''),
    identifier: z.string().default(''),
    wireColors: z.array(z.string()).default([]),
    components: z.array(z.string()).default([]),
    connectors: z.array(z.string()).default([]),
    ecuPins: z.array(z.string()).default([]),
    notes: z.string().default(''),
    confidence: z.number().optional(),
    sections,
  }),
});

export const collections = { posts, projects, models, diagrams };
