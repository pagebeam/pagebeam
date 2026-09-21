import type { Finding } from '@pagebeam/core';
import type { RunResult } from './run.js';

const MARK = { error: '✗', warn: '!', info: 'i' } as const;

export function pretty(result: RunResult): string {
  const lines: string[] = [];
  if (result.problem !== null) return `${result.problem}\nNothing was checked.`;
  const apps = result.apps.length === 0 ? 'no applications' : result.apps.join(', ');
  lines.push(
    `${result.pages} pages, checked against ${apps}` +
      (result.configFrom ? ` (${result.configFrom})` : ' (no config file)'),
  );
  lines.push(`ran: ${result.ran.length === 0 ? 'nothing' : result.ran.join(', ')}`);
  if (result.comparedWith !== null) {
    lines.push(`documentation compared with ${result.comparedWith.slice(0, 8)}`);
  }
  if (result.grade !== null) {
    lines.push(
      `evidence: ${result.grade.source} source, ` +
        (result.grade.depth === 'paired' ? 'compared against an earlier revision' : 'no earlier revision'),
    );
  }
  for (const s of result.skipped) {
    const name = s.split(':')[0] as string;
    lines.push(`${result.degraded.includes(name) ? 'ASKED FOR, DID NOT RUN' : 'NOT RUN'}  ${s}`);
  }
  lines.push('');

  if (result.findings.length === 0) {
    lines.push(
      result.ran.length === 0
        ? 'No check ran, so nothing was verified.'
        : `No drift found by ${result.ran.join(', ')}.`,
    );
    if (result.skipped.length > 0) {
      lines.push(`${result.skipped.length} check(s) did not run. This is not a clean bill of health.`);
    }
    return lines.join('\n');
  }

  for (const f of result.findings) {
    const where = f.doc.line === undefined ? f.doc.path : `${f.doc.path}:${f.doc.line}`;
    const age = f.introduced === null ? '' : f.introduced ? ' new' : ' pre-existing';
    lines.push(`${MARK[f.severity]} [${f.standing}${age}] ${f.title}`);
    lines.push(`  ${where}  [${f.id}]`);
    for (const line of f.detail.split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }

  const counts = result.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.check] = (acc[f.check] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    Object.entries(counts)
      .map(([check, n]) => `${n} ${check}`)
      .join(', '),
  );
  if (result.skipped.length > 0) {
    lines.push(`${result.skipped.length} check(s) did not run, so this is not the whole picture.`);
  }
  return lines.join('\n');
}

export function json(result: RunResult): string {
  return JSON.stringify(
    { problem: result.problem, degraded: result.degraded, comparedWith: result.comparedWith, grade: result.grade, pages: result.pages, apps: result.apps, ran: result.ran, skipped: result.skipped, findings: result.findings },
    null,
    2,
  );
}

export function worst(findings: Finding[]): 'error' | 'warn' | 'info' | null {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  if (findings.some((f) => f.severity === 'info')) return 'info';
  return null;
}
