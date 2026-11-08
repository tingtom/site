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
    file: z.string(),
    preview: z.string().default(''),
    category: z.string().default(''),
    downloads: z.number().default(0),
    date: z.coerce.date().optional(),
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
