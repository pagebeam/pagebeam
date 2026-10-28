import { z } from 'zod';

const command = z.string().min(1);
export const captureViewportSchema = z.strictObject({
  name:z.string().regex(/^[\w-]+$/),width:z.number().int().positive(),height:z.number().int().positive(),scale:z.number().positive().default(2),
});
const service = z.strictObject({
  path: z.string().default('.'),
  start: command,
  ready: z.string().url(),
});

export const captureSchema = z.strictObject({
  environments: z.record(z.strictObject({
    backend: z.discriminatedUnion('kind', [
      z.strictObject({kind:z.literal('none')}),
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
  skipDelays: z.boolean().default(false),
  discovery: z.strictObject({
    account: z.string().optional(),
    context: z.string().optional(),
    viewports:z.array(captureViewportSchema).min(1).default([{name:'desktop',width:1440,height:900,scale:2},{name:'phone',width:390,height:844,scale:2}]),
    maxCalls:z.number().int().positive().default(40),
    maxDecisions: z.number().int().positive().max(30).default(8),
    timeoutMs: z.number().int().positive().default(180_000),
    parameters: z.record(z.string().min(1)).default({}),
    ready: z.string().min(1).optional(),
    controls: z.boolean().default(true),
    maxControls: z.number().int().positive().max(20).default(4),
  }).optional(),
  impact: z.strictObject({
    root: z.string().default('.'),
    ignore: z.array(z.string()).default([]),
    global: z.array(z.string()).default([]),
    routes: z.record(z.array(z.string()).min(1)).default({}),
    maxJourneys: z.number().int().positive().default(6),
  }).optional(),
  groups: z.record(z.strictObject({
    paths: z.array(z.string()).min(1), journeys: z.array(z.string()).min(1),
  })).default({}),
  mask: z.array(z.string()).default([]),
  redactEnv: z.array(z.string()).default([]),
});

export const explorationSchema = z.strictObject({
  goal: z.string().min(1),
  origins: z.array(z.string().url()).default([]),
  actions: z.array(z.enum(['goto', 'click', 'fill', 'select', 'press', 'type', 'wait', 'expect', 'shot', 'scroll'])).default(['goto', 'wait', 'expect', 'shot']),
  allowChanges: z.boolean().default(false),
  maxActions: z.number().int().positive().default(50),
  timeoutMs: z.number().int().positive().default(300_000),
});

export type CaptureConfig = z.infer<typeof captureSchema>;
export type CaptureEnvironment = CaptureConfig['environments'][string];
export type Exploration = z.infer<typeof explorationSchema>;
