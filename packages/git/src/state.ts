import type { Finding } from '@pagebeam/core';

const MARKER = 'pagebeam:state';
const BLOCK = /<!--\s*pagebeam:state\s*(\{[\s\S]*?\})\s*-->/;

export interface State {
  version: 1;
  findings: { id: string; revision: string }[];
}

export function stateOf(findings: Finding[]): State {
  return {
    version: 1,
    findings: findings
      .map((f) => ({ id: f.id, revision: f.revision }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function renderState(state: State): string {
  return `<!-- ${MARKER} ${JSON.stringify(state)} -->`;
}

export function readState(body: string): State | null {
  const found = body.match(BLOCK)?.[1];
  if (found === undefined) return null;
  try {
    const parsed = JSON.parse(found) as State;
    return Array.isArray(parsed.findings) ? parsed : null;
  } catch {
    return null;
  }
}

// What is being asserted, and what is currently proposed about it, are
// different questions. A finding whose proposal changed still concerns the
// same thing, so it updates rather than arriving as something new.
export function same(a: State, b: State): boolean {
  if (a.findings.length !== b.findings.length) return false;
  return a.findings.every(
    (f, i) => f.id === b.findings[i]?.id && f.revision === b.findings[i]?.revision,
  );
}
