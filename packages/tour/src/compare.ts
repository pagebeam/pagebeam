import type { CaptureReport } from './capture.js';

export interface Comparison {
  schemaVersion: 1;
  head: { id: string; revision: string | null };
  base: { id: string; revision: string | null };
  compatible: boolean;
  reasons: string[];
  captures: { journey: string; viewport: string; step: number; head: string | null; base: string | null }[];
}

export function compareCaptures(head: CaptureReport, base: CaptureReport): Comparison {
  const reasons: string[] = [];
  if (head.mode !== 'saved' || base.mode !== 'saved') reasons.push('exploratory runs do not guarantee equivalent actions');
  if (!head.revision || !base.revision) reasons.push('frontend revision is unknown');
  if (!head.backend?.fixtureVersion || head.backend.fixtureVersion !== base.backend?.fixtureVersion) reasons.push('fixture versions are unknown or differ');
  if (head.backend?.mocked !== base.backend?.mocked) reasons.push('backend kinds differ');
  if (head.status !== 'passed' || base.status !== 'passed') reasons.push('one or both runs did not complete successfully');
  const keys = (report: CaptureReport): string[] => report.results.flatMap(result => result.steps.map(step => `${result.journey}/${result.viewport}/${step.step}/${step.action}`));
  if (JSON.stringify(keys(head)) !== JSON.stringify(keys(base))) reasons.push('journeys or actions differ');
  if (JSON.stringify(head.results.map(result => result.size)) !== JSON.stringify(base.results.map(result => result.size))) reasons.push('viewport dimensions differ');
  const shots = (report: CaptureReport): Map<string, { journey: string; viewport: string; step: number; file: string }> => new Map(report.results.flatMap(result => result.steps.filter(step => step.file && step.status === 'passed' && step.action === 'shot').map(step => [
    `${result.journey}/${result.viewport}/${step.step}`,
    { journey: result.journey, viewport: result.viewport, step: step.step, file: `${result.journey}/${result.viewport}/${step.file!}` },
  ])));
  const heads = shots(head);
  const bases = shots(base);
  const captures = [...new Set([...heads.keys(), ...bases.keys()])].map(key => {
    const shot = heads.get(key) ?? bases.get(key)!;
    return { journey: shot.journey, viewport: shot.viewport, step: shot.step, head: heads.get(key)?.file ?? null, base: bases.get(key)?.file ?? null };
  });
  if (captures.some(shot => shot.head === null || shot.base === null)) reasons.push('capture checkpoints differ');
  return { schemaVersion: 1, head: { id: head.id, revision: head.revision }, base: { id: base.id, revision: base.revision }, compatible: !reasons.length, reasons, captures };
}
