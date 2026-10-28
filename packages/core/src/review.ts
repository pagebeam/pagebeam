import { z } from 'zod';
import { stepSchema } from './config.js';

export const reviewChangesSchema=z.strictObject({
  changes:z.array(z.strictObject({
    id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/),
    description:z.string().min(1),
    surface:z.enum(['default','interaction','error','responsive','nonvisual']),
    files:z.array(z.string()).min(1),
    labels:z.array(z.string().min(1)).max(4).default([]),
  })),
  ignored:z.array(z.strictObject({file:z.string(),reason:z.string().min(1)})),
  unresolved:z.array(z.strictObject({file:z.string(),reason:z.string().min(1)})),
});
export type ReviewChanges=z.infer<typeof reviewChangesSchema>;

export const reviewPlanSchema = z.strictObject({
  nonvisual:z.array(z.strictObject({intent:z.string().min(1),reason:z.string().min(1)})).default([]),
  states: z.array(z.strictObject({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/),
    goal: z.string().min(1),
    before:z.string().min(1).optional(),
    intents:z.array(z.string()).default([]),
    kind:z.enum(['default','interaction','error']).default('default'),
    route: z.string().startsWith('/'),
    account: z.string().min(1),
    viewports: z.array(z.string().min(1)).min(1),
    files: z.array(z.string()).min(1),
  })),
  ignored: z.array(z.strictObject({file: z.string(), reason: z.string().min(1)})),
  unresolved: z.array(z.strictObject({file: z.string(), reason: z.string().min(1)})),
});

export const reviewDecisionSchema = z.strictObject({
  actions: z.array(stepSchema).max(6),
  done: z.boolean(),
  assertions: z.array(z.strictObject({selector: z.string().min(1), text: z.string().optional(),value:z.string().optional()}).refine(value=>value.text===undefined||value.value===undefined,{message:'Use text or value, not both'})).default([]),
}).superRefine((decision, context) => {
  for (const [index, action] of decision.actions.entries()) {
    if ('verify' in action || 'shot' in action || 'fill' in action && action.fill.valueEnv || 'type' in action && typeof action.type !== 'string') {
      context.addIssue({code:'custom',path:['actions',index],message:'Review decisions cannot execute scripts, read environment values or take screenshots'});
    }
    if ('wait' in action && typeof action.wait === 'number' && action.wait > 3000) context.addIssue({code:'custom',path:['actions',index],message:'A numeric wait may not exceed 3000ms'});
  }
  if (decision.done && !decision.assertions.length) context.addIssue({code:'custom',path:['assertions'],message:'A completed state needs at least one observable assertion'});
});

export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
export type ReviewState = ReviewPlan['states'][number];
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
