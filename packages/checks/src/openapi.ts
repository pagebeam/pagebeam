import { readFile } from 'node:fs/promises';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const CITATION = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[A-Za-z0-9/_{}.-]*)/g;
const UNDOCUMENTED_SHOWN = 10;

export interface Operation {
  method: string;
  path: string;
  operationId?: string;
}

export async function readSpec(file: string): Promise<Operation[]> {
  const spec = JSON.parse(await readFile(file, 'utf8')) as {
    paths?: Record<string, Record<string, { operationId?: string }>>;
  };
  const ops: Operation[] = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      ops.push({
        method: method.toUpperCase(),
        path: p,
        ...(op?.operationId ? { operationId: op.operationId } : {}),
      });
    }
  }
  return ops;
}

export function citations(pages: DocPage[]): { method: string; path: string; page: string; line: number }[] {
  const out: { method: string; path: string; page: string; line: number }[] = [];
  for (const page of pages) {
    const bodies = [page.prose, ...page.codeBlocks.map((b) => b.value), ...page.codeSpans.map((s) => s.value)];
    for (const body of bodies) {
      CITATION.lastIndex = 0;
      for (const m of body.matchAll(CITATION)) {
        out.push({ method: m[1] as string, path: m[2] as string, page: page.path, line: 1 });
      }
    }
  }
  return out;
}

export function checkCitations(
  cited: ReturnType<typeof citations>,
  ops: Operation[],
  app: string,
): Finding[] {
  const known = new Set(ops.map((o) => `${o.method} ${o.path}`));
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const c of cited) {
    const key = `${c.method} ${c.path}`;
    if (known.has(key) || seen.has(`${c.page}|${key}`)) continue;
    seen.add(`${c.page}|${key}`);
    findings.push({
      id: findingId('openapi', c.page, `${app}|${key}`),
      revision: findingRevision(key),
      check: 'openapi',
      app,
      severity: 'error',
      confidence: 0.95,
      doc: { path: c.page, line: c.line },
      title: `${key} is documented but not in the ${app} specification`,
      detail: `This page describes ${key}. The ${app} specification has no such operation.`,
      evidence: [{ kind: 'cited-in', detail: `${c.page}:${c.line}` }],
    });
  }
  return findings;
}

export function checkCoverage(
  pages: DocPage[],
  ops: Operation[],
  specFile: string,
  app: string,
): Finding[] {
  const corpus = pages.map((p) => `${p.prose}\n${p.codeBlocks.map((b) => b.value).join('\n')}`).join('\n');
  const undocumented = ops.filter((o) => !corpus.includes(o.path));
  if (undocumented.length === 0) return [];

  const shown = undocumented.slice(0, UNDOCUMENTED_SHOWN).map((o) => `${o.method} ${o.path}`);
  const more = undocumented.length - shown.length;
  return [
    {
      id: findingId('openapi', specFile, `${app}|coverage`),
      revision: findingRevision(String(undocumented.length)),
      check: 'openapi',
      app,
      severity: 'info',
      confidence: 1,
      doc: { path: specFile },
      title: `${undocumented.length} of ${ops.length} ${app} API operations appear in no documentation page`,
      detail:
        `No page mentions the path for these operations:\n` +
        shown.map((s) => `  ${s}`).join('\n') +
        (more > 0 ? `\n  and ${more} more` : ''),
      evidence: [{ kind: 'specification', detail: specFile }],
    },
  ];
}
