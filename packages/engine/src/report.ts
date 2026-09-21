import type { Finding } from '@pagebeam/core';
import type { RunResult } from './run.js';

const MARK = { error: '✗', warn: '!', info: 'i' } as const;

export function pretty(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`${result.pages} pages read` + (result.configFrom ? ` (${result.configFrom})` : ' (no config file)'));
  for (const s of result.skipped) lines.push(`  skipped ${s}`);
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('Nothing has drifted.');
    return lines.join('\n');
  }

  for (const f of result.findings) {
    const where = f.doc.line === undefined ? f.doc.path : `${f.doc.path}:${f.doc.line}`;
    lines.push(`${MARK[f.severity]} ${f.title}`);
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
  return lines.join('\n');
}

export function json(result: RunResult): string {
  return JSON.stringify({ pages: result.pages, findings: result.findings }, null, 2);
}

export function worst(findings: Finding[]): 'error' | 'warn' | 'info' | null {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  if (findings.some((f) => f.severity === 'info')) return 'info';
  return null;
}
