import { z } from 'zod';

const docsSchema = z.strictObject({
  root: z.string(),
  include: z.array(z.string()).default(['**/*.{md,mdx,markdown,astro}']),
  exclude: z.array(z.string()).default(['**/node_modules/**', '**/dist/**']),
  format: z
    .enum(['auto', 'docusaurus', 'starlight', 'astro', 'nextra', 'mkdocs', 'markdown'])
    .default('auto'),
  buildDir: z.string().optional(),
  routeBase: z.string().default(''),
  publicDir: z.string().optional(),
});

const appSchema = z.strictObject({
  name: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
  routes: z
    .array(z.union([z.string(), z.strictObject({ path: z.string(), prepare: z.string().optional() })]))
    .default([]),
  auth: z
    .strictObject({
      storageState: z.string().optional(),
      storageStateEnv: z.string().optional(),
      script: z.string().optional(),
      confirm: z.string().optional(),
    })
    .optional(),
  renderTimeoutMs: z.number().int().positive().default(15_000),
  include: z.array(z.string()).default(['**/*.{ts,tsx,js,jsx,vue,svelte}']),
  exclude: z
    .array(z.string())
    .default(['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/*.stories.*', '**/dist/**']),
  envFiles: z.array(z.string()).default(['**/.env.example']),
  openapi: z.strictObject({ spec: z.string() }).optional(),
});

export type AppSource = z.infer<typeof appSchema>;

const checksSchema = z.strictObject({
  links: z
    .union([
      z.literal(false),
      z.strictObject({
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
      z.strictObject({}),
    ])
    .default({}),
  openapi: z.union([z.literal(false), z.strictObject({})]).default({}),
  moved: z.union([z.literal(false), z.strictObject({})]).default(false),
  strings: z
    .union([
      z.literal(false),
      z.strictObject({ minConfidence: z.number().min(0).max(1).default(0.5) }),
    ])
    .default(false),
});

export const configSchema = z.strictObject({
  docs: docsSchema,
  apps: z.array(appSchema).default([]),
  history: z
    .strictObject({ sinceDays: z.number().int().positive().default(30) })
    .default({}),
  propose: z
    .strictObject({
      repo: z.string().default('.'),
      branch: z.string().default('pagebeam/drift'),
      base: z.string().default('main'),
      labels: z.array(z.string()).default([]),
      reviewers: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    })
    .default({}),
  checks: checksSchema.default({}),
});

export type PagebeamConfig = z.infer<typeof configSchema>;
export type PagebeamConfigInput = z.input<typeof configSchema>;

export function defineConfig(config: PagebeamConfigInput): PagebeamConfigInput {
  return config;
}

export function parseConfig(value: unknown): PagebeamConfig {
  return configSchema.parse(value);
}
