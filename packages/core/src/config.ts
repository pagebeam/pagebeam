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
  // Required. Opening a running application adds to what its files say; it
  // cannot stand in for them, so an application named by url alone would be
  // accepted and then never read.
  path: z.string(),
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
        enrich: z.boolean().optional(),
      }),
    ])
    .default({}),
  configKeys: z
    .union([z.literal(false), z.strictObject({ enrich: z.boolean().optional() })])
    .default({}),
  openapi: z
    .union([
      z.literal(false),
      z.strictObject({
        // Whether to count how many operations the prose describes.
        // auto: not where the site builds its reference from the
        // specification, because then the pages are the specification and
        // counting the prose answers a question nobody asked.
        coverage: z.enum(['auto', 'always', 'never']).default('auto'),
        enrich: z.boolean().optional(),
      }),
    ])
    .default({}),
  moved: z.union([z.literal(false), z.strictObject({ enrich: z.boolean().optional() })]).default(false),
  undocumented: z
    .union([z.literal(false), z.strictObject({ enrich: z.boolean().optional() })])
    .default({}),
  strings: z
    .union([
      z.literal(false),
      z.strictObject({
        minConfidence: z.number().min(0).max(1).default(0.5),
        enrich: z.boolean().optional(),
      }),
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
      // The type, and any scope, that every commit and the pull request title
      // are written under. Conventional Commits by default, because a
      // repository enforcing anything usually enforces that. Empty writes no
      // prefix at all.
      commitPrefix: z.string().default('docs'),
      // Left unsaid, a pull request opens as a draft when anything in it was
      // written by a model and as a normal one when everything was worked out
      // from the source. Saying so either way settles it outright.
      draft: z.boolean().optional(),
    })
    .default({}),
  checks: checksSchema.default({}),
  // Anything answering the OpenAI chat completions shape, which a router run
  // beside this does. Absent means the deterministic checks answer alone and
  // findings they cannot mend are reported without a change to propose.
  model: z
    .strictObject({
      // Any endpoint answering the OpenAI chat completions shape, run wherever
      // the user wants it: a provider's own address, a gateway, or a router on
      // the same machine. pagebeam does not care which and ships none of them.
      baseUrl: z.string().url(),
      name: z.string(),
      // Named, never written down. A key belongs in the environment.
      apiKeyEnv: z.string().optional(),
      // For a provider that wants something besides a bearer token.
      headers: z.record(z.string()).default({}),
      // On once a provider is named. Set false to keep the provider configured
      // and stop asking it.
      enrich: z.boolean().default(true),
      // Whether the product's own source may leave this machine. A page and
      // the evidence for a finding are about the documentation; the source is
      // the product itself, and sending it to somebody else's service is a
      // separate decision from asking for a draft. Off unless said.
      sendSource: z.boolean().default(false),
      // Files the project already keeps for whoever writes its documentation.
      // Named rather than guessed at, because what is in them is the project's
      // business: voice, terminology, structure, or anything else. They are
      // added to what the model is told and cannot displace how it must answer.
      skills: z.array(z.string()).default([]),
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .optional(),
});

export type PagebeamConfig = z.infer<typeof configSchema>;
export type PagebeamConfigInput = z.input<typeof configSchema>;

export function defineConfig(config: PagebeamConfigInput): PagebeamConfigInput {
  return config;
}

export function parseConfig(value: unknown): PagebeamConfig {
  return configSchema.parse(value);
}
