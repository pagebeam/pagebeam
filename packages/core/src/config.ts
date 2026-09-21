import { z } from 'zod';

const docsSchema = z.object({
  root: z.string(),
  include: z.array(z.string()).default(['**/*.{md,mdx,markdown}']),
  exclude: z.array(z.string()).default(['**/node_modules/**', '**/dist/**']),
  format: z
    .enum(['auto', 'docusaurus', 'starlight', 'astro', 'nextra', 'mkdocs', 'markdown'])
    .default('auto'),
  buildDir: z.string().optional(),
  publicDir: z.string().optional(),
});

const appSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
  include: z.array(z.string()).default(['**/*.{ts,tsx,js,jsx,vue,svelte}']),
  exclude: z
    .array(z.string())
    .default(['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/*.stories.*', '**/dist/**']),
  envFiles: z.array(z.string()).default(['**/.env.example']),
  openapi: z.object({ spec: z.string() }).optional(),
});

export type AppSource = z.infer<typeof appSchema>;

const checksSchema = z.object({
  links: z
    .union([
      z.literal(false),
      z.object({ external: z.boolean().default(false) }),
    ])
    .default({}),
  configKeys: z
    .union([
      z.literal(false),
      z.object({}),
    ])
    .default({}),
  openapi: z.union([z.literal(false), z.object({})]).default({}),
  strings: z
    .union([
      z.literal(false),
      z.object({ minConfidence: z.number().min(0).max(1).default(0.5) }),
    ])
    .default(false),
});

export const configSchema = z.object({
  docs: docsSchema,
  apps: z.array(appSchema).default([]),
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
