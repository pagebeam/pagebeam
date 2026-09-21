import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
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

type Document = Record<string, unknown>;

function at(document: Document, pointer: string): unknown {
  return pointer
    .replace(/^#\//, '')
    .split('/')
    .filter((s) => s !== '')
    .reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')]
          : undefined,
      document,
    );
}

export interface SpecResult {
  operations: Operation[];
  unresolved: string[];
}

export async function readSpec(file: string): Promise<SpecResult> {
  const text = await readFile(file, 'utf8');
  const json = path.extname(file).toLowerCase() === '.json';
  const document = (json ? JSON.parse(text) : parseYaml(text)) as Document;

  const operations: Operation[] = [];
  const unresolved: string[] = [];
  const paths = (document['paths'] ?? {}) as Record<string, unknown>;

  for (const [p, rawItem] of Object.entries(paths)) {
    let item = rawItem as Record<string, unknown> | undefined;
    const ref = item?.['$ref'];

    if (typeof ref === 'string') {
      if (!ref.startsWith('#/')) {
        unresolved.push(`${p} -> ${ref}`);
        continue;
      }
      const resolved = at(document, ref);
      if (typeof resolved !== 'object' || resolved === null) {
        unresolved.push(`${p} -> ${ref}`);
        continue;
      }
      item = resolved as Record<string, unknown>;
    }

    for (const [method, op] of Object.entries(item ?? {})) {
      if (!METHODS.has(method)) continue;
      const id = (op as { operationId?: string } | undefined)?.operationId;
      operations.push({
        method: method.toUpperCase(),
        path: p,
        ...(id ? { operationId: id } : {}),
      });
    }
  }
  return { operations, unresolved };
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
    const key = `${c.method} ${templatise(c.path, ops)}`;
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

// /users/123 in a worked example is the same operation as /users/{id}.
export function templatise(p: string, against: Operation[]): string {
  if (against.some((o) => o.path === p)) return p;
  const segments = p.split('/');
  for (const op of against) {
    const parts = op.path.split('/');
    if (parts.length !== segments.length) continue;
    const fits = parts.every((part, i) => part.startsWith('{') || part === segments[i]);
    if (fits) return op.path;
  }
  return p;
}

export function checkCoverage(
  pages: DocPage[],
  ops: Operation[],
  specFile: string,
  app: string,
): Finding[] {
  const documented = new Set(
    citations(pages).map((c) => `${c.method} ${templatise(c.path, ops)}`),
  );
  const undocumented = ops.filter((o) => !documented.has(`${o.method} ${o.path}`));
  if (undocumented.length === 0) return [];

  // A path named in prose is not the same as an operation described with its
  // method, and neither is the same as a reference page. Saying so is the
  // difference between a useful number and a discouraging one.
  const corpus = pages
    .map((p) => `${p.prose}\n${p.codeBlocks.map((b) => b.value).join('\n')}`)
    .join('\n');
  const named = undocumented.filter((o) => corpus.includes(o.path));

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
      title: `${undocumented.length} of ${ops.length} ${app} API operations are not documented with their method`,
      detail:
        (named.length > 0
          ? `${named.length} of them have their path named somewhere in the docs but never with a method, so a reader cannot tell which operations exist.\n`
          : 'None of their paths appear anywhere in the docs.\n') +
        `Not documented:\n` +
        shown.map((s) => `  ${s}`).join('\n') +
        (more > 0 ? `\n  and ${more} more` : ''),
      evidence: [{ kind: 'specification', detail: specFile }],
    },
  ];
}
