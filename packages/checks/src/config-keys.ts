import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

const ENV_LANGS = new Set(['ini', 'env', 'dotenv', 'sh', 'bash', 'shell', 'properties', '']);
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm;

export interface DocumentedKey {
  key: string;
  page: string;
  line: number;
}

export function documentedKeys(pages: DocPage[]): DocumentedKey[] {
  const found: DocumentedKey[] = [];
  for (const page of pages) {
    for (const block of page.codeBlocks) {
      if (!ENV_LANGS.has(block.lang ?? '')) continue;
      ASSIGNMENT.lastIndex = 0;
      for (const m of block.value.matchAll(ASSIGNMENT)) {
        const before = block.value.slice(0, m.index ?? 0);
        const line = block.line + before.split('\n').length;
        found.push({ key: m[1] as string, page: page.path, line });
      }
    }
  }
  return found;
}

export async function definedKeys(appRoot: string, patterns: string[]): Promise<Set<string>> {
  const files = await glob(patterns, { cwd: appRoot, ignore: ['**/node_modules/**'], absolute: true });
  const keys = new Set<string>();
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    ASSIGNMENT.lastIndex = 0;
    for (const m of text.matchAll(ASSIGNMENT)) keys.add(m[1] as string);
  }
  return keys;
}

export function compare(documented: DocumentedKey[], defined: Set<string>): Finding[] {
  const seen = new Map<string, DocumentedKey>();
  for (const d of documented) if (!seen.has(d.key)) seen.set(d.key, d);

  const findings: Finding[] = [];
  for (const [key, where] of seen) {
    if (defined.has(key)) continue;
    findings.push({
      id: findingId('config-keys', where.page, key),
      revision: findingRevision(key),
      check: 'config-keys',
      severity: 'warn',
      confidence: 0.9,
      doc: { path: where.page, line: where.line },
      title: `${key} is documented but defined nowhere in the app`,
      detail:
        `The docs describe ${key} as a configuration key. ` +
        `It does not appear in any of the app's example environment files. ` +
        `Either it was renamed or removed, or the example files are missing it.`,
      evidence: [
        { kind: 'documented-at', detail: `${where.page}:${where.line}` },
        { kind: 'searched', detail: 'example environment files in the app' },
      ],
    });
  }
  return findings.sort((a, b) => a.title.localeCompare(b.title));
}
