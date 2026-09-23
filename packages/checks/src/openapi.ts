import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const CITATION = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/[A-Za-z0-9/_{}.-]*)/g;
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

export interface Citation {
  method: string;
  path: string;
  page: string;
  line?: number;
}

// Only what the parser kept as the page's text and code: not frontmatter,
// comments or imports, which nobody reading the page sees.
export function citations(pages: DocPage[]): Citation[] {
  const out: Citation[] = [];
  const read = (page: DocPage, body: string, line: number | undefined): void => {
    CITATION.lastIndex = 0;
    for (const m of body.matchAll(CITATION)) {
      const at = line === undefined ? undefined : line + body.slice(0, m.index).split('\n').length - 1;
      out.push({ method: m[1] as string, path: m[2] as string, page: page.path, ...(at === undefined ? {} : { line: at }) });
    }
  };
  for (const page of pages) {
    if (page.texts === undefined) read(page, page.prose, undefined);
    else for (const t of page.texts) read(page, t.value, t.line);
    for (const b of page.codeBlocks) read(page, b.value, b.line + 1);
    for (const c of page.codeSpans) read(page, c.value, c.line);
  }
  return out;
}

// An operation named on a page belongs to no one application when several
// declare a specification: it is absent from all of them together. The
// applications are named for a reader, and the finding is left without an
// owner, because a name that is really a list belongs to nothing and would be
// read by anything counting ownership as work somebody else did.
export function checkCitations(
  cited: ReturnType<typeof citations>,
  ops: Operation[],
  apps: string[],
): Finding[] {
  const app = apps.length === 1 ? apps[0]! : apps.join(', ');
  const owner = apps.length === 1 ? { app } : {};
  const known = new Set(ops.map((o) => `${o.method} ${o.path}`));
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const c of cited) {
    const key = `${c.method} ${templatise(c.path, ops, c.method)}`;
    if (known.has(key) || seen.has(`${c.page}|${key}`)) continue;
    seen.add(`${c.page}|${key}`);
    findings.push({
      id: findingId('openapi', c.page, `${app}|${key}`),
      revision: findingRevision(key),
      check: 'openapi',
      standing: 'review',
      ...owner,
      severity: 'error',
      confidence: 0.95,
      doc: { path: c.page, ...(c.line === undefined ? {} : { line: c.line }) },
      title: `${key} is documented but not in the ${app} specification`,
      detail: `This page describes ${key}. The ${app} specification has no such operation.`,
      evidence: [{ kind: 'cited-in', detail: c.line === undefined ? c.page : `${c.page}:${c.line}` }],
    });
  }
  return findings;
}

// /users/123 in a worked example is the same operation as /users/{id}.
export function templatise(p: string, against: Operation[], method?: string): string {
  const candidates = method === undefined ? against : against.filter((o) => o.method === method);
  const pool = candidates.length > 0 ? candidates : against;
  if (pool.some((o) => o.path === p)) return p;

  const segments = p.split('/');
  for (const op of pool) {
    const parts = op.path.split('/');
    if (parts.length !== segments.length) continue;
    if (parts.every((part, i) => part.startsWith('{') || part === segments[i])) return op.path;
  }
  return p;
}

export function checkCoverage(
  pages: DocPage[],
  ops: Operation[],
  specFile: string,
  app: string,
  // `METHOD /path` for each operation the built site shows. Null without a build.
  served: Set<string> | null = null,
): Finding[] {
  const documented = new Set(
    citations(pages).map((c) => `${c.method} ${templatise(c.path, ops, c.method)}`),
  );
  const undocumented = ops.filter(
    (o) => !documented.has(`${o.method} ${o.path}`) && !(served?.has(`${o.method} ${o.path}`) ?? false),
  );
  if (undocumented.length === 0) return [];

  // A path named in prose is not an operation described with its method.
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
      standing: 'review',
      app,
      severity: 'info',
      confidence: served === null ? 1 : 0.8,
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
