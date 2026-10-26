import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CaptureReport } from './capture.js';
import type { Comparison } from './compare.js';
import { markdownRenderer, htmlRenderer, type Outcome, type OutcomeRenderer, type OutcomePublisher, type CaptureOutcome, type Publication } from './outcome.js';

type Run = { directory: string; report: CaptureReport };

export function captureOutcome(directory: string, head: Run, base?: Run, comparison?: Comparison): CaptureOutcome {
  const root = path.resolve(directory);
  const file = (run: Run, name: string): string => {
    const relative = path.relative(root, path.resolve(run.directory, name));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('evidence is outside the outcome directory');
    return relative.split(path.sep).join('/');
  };
  const checkpoints = comparison?.captures ?? head.report.results.flatMap(result => result.steps.filter(step => step.file).map(step => ({journey: result.journey, viewport: result.viewport, step: step.step, head: `${result.journey}/${result.viewport}/${step.file!}`, base: null})));
  const captures = checkpoints.map(shot => ({ ...shot, head: shot.head ? file(head, shot.head) : null, base: shot.base && base ? file(base, shot.base) : null }));
  const images = [...new Set(captures.flatMap(shot => [shot.head, shot.base]).filter((value): value is string => value !== null))];
  const reports = [head, ...(base ? [base] : [])].map(run => file(run, 'report.json'));
  return {
    schemaVersion: 1, kind: 'capture', status: head.report.status === 'failed' || base?.report.status === 'failed' ? 'failed' : comparison && !comparison.compatible ? 'incomplete' : head.report.status,
    head: { id: head.report.id, revision: head.report.revision, status: head.report.status },
    ...(base ? { base: { id: base.report.id, revision: base.report.revision, status: base.report.status } } : {}),
    compatible: comparison?.compatible ?? null, reasons: comparison?.reasons ?? [], unmapped: head.report.selection.unmapped,
    evidence: [...images.map(name => ({ id: name, file: name, mediaType: 'image/png' })), ...reports.map(name => ({ id: name, file: name, mediaType: 'application/json' }))],
    captures,
  };
}

export async function writeOutcome<T extends Outcome>(outcome: T, options: {
  directory: string;
  renderers: readonly OutcomeRenderer<T>[];
  publisher?: OutcomePublisher;
  namespace?: string;
}): Promise<{ manifest: string; outputs: Record<string, string>; publication: Publication }> {
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const manifest = path.join(directory, 'outcome.json');
  await writeFile(manifest, JSON.stringify(outcome, null, 2) + '\n');
  const publication = options.publisher ? await options.publisher.publish(outcome.evidence, { directory, namespace: options.namespace ?? '' }) : { urls: {} };
  const outputs: Record<string, string> = {};
  for (const renderer of options.renderers) {
    if (!/^[a-zA-Z0-9][\w.-]*$/.test(renderer.filename) || renderer.filename === 'outcome.json') throw new Error('renderer filename must stay inside the outcome directory');
    const target = path.join(directory, renderer.filename);
    await writeFile(target, await renderer.render(outcome, publication));
    outputs[renderer.format] = target;
  }
  return { manifest, outputs, publication };
}

export async function writeCaptureOutcome(directory: string, head: Run, base?: Run, comparison?: Comparison, options: { html?: boolean } = {}): Promise<{ manifest: string; markdown: string; gallery?: string }> {
  const outcome = captureOutcome(directory, head, base, comparison);
  const renderers = [markdownRenderer, ...(options.html ? [htmlRenderer] : [])];
  const result = await writeOutcome(outcome, { directory, renderers });
  return { manifest: result.manifest, markdown: result.outputs.markdown!, ...(result.outputs.html ? { gallery: result.outputs.html } : {}) };
}
