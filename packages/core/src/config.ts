import { z } from 'zod';

const docsSchema = z.object({
  root: z.string(),
  include: z.array(z.string()).default(['**/*.{md,mdx,markdown}']),
  exclude: z.array(z.string()).default(['**/node_modules/**', '**/dist/**']),
  format: z
    .enum(['auto', 'docusaurus', 'starlight', 'astro', 'nextra', 'mkdocs', 'markdown'])
    .default('auto'),
  siteUrl: z.string().url().optional(),
  buildDir: z.string().optional(),
  publicDir: z.string().optional(),
});

const appSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  ref: z.string().optional(),
  url: z.string().url().optional(),
  include: z.array(z.string()).default(['**/*.{ts,tsx,js,jsx,vue,svelte}']),
  exclude: z
    .array(z.string())
    .default(['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/*.stories.*', '**/dist/**']),
  envFiles: z.array(z.string()).default(['**/.env.example']),
  openapi: z.object({ spec: z.string() }).optional(),
  i18n: z.object({ catalogs: z.array(z.string()) }).optional(),
});

export type AppSource = z.infer<typeof appSchema>;

const checksSchema = z.object({
  links: z
    .union([
      z.literal(false),
      z.object({
        external: z.boolean().default(false),
        timeoutMs: z.number().int().positive().default(10_000),
        concurrency: z.number().int().positive().default(8),
        allowlist: z.array(z.string()).default([]),
      }),
    ])
    .default({}),
  configKeys: z
    .union([
      z.literal(false),
      z.object({
        pattern: z.string().default('[A-Z][A-Z0-9_]{3,}'),
        stoplist: z.array(z.string()).default([]),
      }),
    ])
    .default({}),
  openapi: z.union([z.literal(false), z.object({})]).default({}),
  strings: z
    .union([
      z.literal(false),
      z.object({
        minConfidence: z.number().min(0).max(1).default(0.5),
        autoFixAbove: z.number().min(0).max(1).default(0.8),
        stoplist: z.array(z.string()).default([]),
      }),
    ])
    .default(false),
  screenshots: z.union([z.literal(false), z.object({})]).default(false),
  coverage: z.union([z.literal(false), z.object({})]).default(false),
});

const prSchema = z.object({
  mode: z.enum(['rolling', 'per-finding']).default('rolling'),
  branchPrefix: z.string().default('pagebeam'),
  base: z.string().optional(),
  labels: z.array(z.string()).default(['documentation']),
  reviewers: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
  maxFindings: z.number().int().positive().default(50),
});

export const configSchema = z.object({
  docs: docsSchema,
  apps: z.array(appSchema).default([]),
  checks: checksSchema.default({}),
  pr: prSchema.default({}),
  model: z
    .object({
      provider: z.enum(['anthropic', 'openai', 'none']).default('none'),
      model: z.string().optional(),
    })
    .default({ provider: 'none' }),
});

export type PagebeamConfig = z.infer<typeof configSchema>;
export type PagebeamConfigInput = z.input<typeof configSchema>;

export function defineConfig(config: PagebeamConfigInput): PagebeamConfigInput {
  return config;
}

export function parseConfig(value: unknown): PagebeamConfig {
  return configSchema.parse(value);
}
