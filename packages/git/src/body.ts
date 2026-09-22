import { subjectFor } from './subject.js';
import type { Finding } from '@pagebeam/core';
import { renderState, type State } from './state.js';

const ORDER = { error: 0, warn: 1, info: 2 } as const;

function row(finding: Finding): string {
  const where =
    finding.doc.line === undefined ? finding.doc.path : `${finding.doc.path}:${finding.doc.line}`;
  const age =
    finding.introduced === true ? 'new' : finding.introduced === false ? 'pre-existing' : 'unknown';
  return `| ${finding.check} | ${where} | ${finding.title} | ${finding.standing} | ${age} |`;
}

export function bodyFor(findings: Finding[], state: State, comparedWith: string | null): string {
  const sorted = [...findings].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || a.doc.path.localeCompare(b.doc.path),
  );
  const proven = sorted.filter((f) => f.standing === 'proven');
  const review = sorted.filter((f) => f.standing === 'review');

  const lines: string[] = [];
  lines.push(
    `${findings.length} thing${findings.length === 1 ? '' : 's'} in the documentation no longer ` +
      `match the product.`,
  );
  if (comparedWith !== null) {
    lines.push('', `Compared against \`${comparedWith.slice(0, 8)}\`.`);
  }

  for (const [title, group, note] of [
    ['Proven', proven, 'The source of truth says so directly.'],
    ['Worth reading', review, 'Absence from what could be read is not absence from the product.'],
  ] as const) {
    if (group.length === 0) continue;
    lines.push('', `## ${title}`, '', note, '');
    lines.push('| Check | Where | What | Standing | Age |', '| --- | --- | --- | --- | --- |');
    for (const finding of group) lines.push(row(finding));
  }

  lines.push('', renderState(state));
  return lines.join('\n');
}

// What the change is, rather than how many of them a tool counted. One thing
// is named outright; several are summarised by what they touch.
export function titleFor(findings: Finding[], prefix?: string | undefined): string {
  const first = findings[0];
  if (first === undefined) return subjectFor('nothing left to correct', { prefix });
  if (findings.length === 1) return subjectFor(first.title, { prefix });

  const apps = [...new Set(findings.map((f) => f.app).filter((a): a is string => a !== undefined))];
  const where = apps.length === 0 ? '' : ` in ${apps.sort().join(' and ')}`;
  return subjectFor(`correct ${findings.length} things the documentation says${where}`, { prefix });
}
