import { z } from 'zod';

const command = z.string().min(1);
const service = z.strictObject({
  path: z.string().default('.'),
  start: command,
  ready: z.string().url(),
});

export const captureSchema = z.strictObject({
  environments: z.record(z.strictObject({
    backend: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('url'), url: z.string().url(), revision: z.string().min(1) }),
      z.strictObject({
        kind: z.literal('image'), path: z.string().default('.'), compose: z.string(),
        service: z.string().regex(/^[\w-]+$/), image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
        ready: z.string().url(),
      }),
      service.extend({ kind: z.literal('directory'), revision: z.string().optional() }),
      service.extend({ kind: z.literal('mock'), fixtures: z.string(), version: z.string().min(1), validate: command }),
    ]),
    frontend: service.optional(),
    frontendRevision: z.string().optional(),
    env: z.record(z.string()).default({}),
    requiredEnv: z.array(z.string()).default([]),
    prepare: z.array(command).default([]),
    cleanup: z.array(command).default([]),
    fixtures: z.strictObject({
      path: z.string().optional(), version: z.string().min(1),
      restore: command.optional(),
    }).optional(),
    disposable: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(120_000),
  })),
  groups: z.record(z.strictObject({
    paths: z.array(z.string()).min(1), journeys: z.array(z.string()).min(1),
  })).default({}),
  mask: z.array(z.string()).default([]),
  redactEnv: z.array(z.string()).default([]),
});

export const explorationSchema = z.strictObject({
  goal: z.string().min(1),
  origins: z.array(z.string().url()).default([]),
  actions: z.array(z.enum(['goto', 'click', 'fill', 'select', 'press', 'type', 'wait', 'expect', 'shot'])).default(['goto', 'wait', 'expect', 'shot']),
  allowChanges: z.boolean().default(false),
  maxActions: z.number().int().positive().default(50),
  timeoutMs: z.number().int().positive().default(300_000),
});

export type CaptureConfig = z.infer<typeof captureSchema>;
export type CaptureEnvironment = CaptureConfig['environments'][string];
export type Exploration = z.infer<typeof explorationSchema>;
