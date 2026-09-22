import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import picomatch from 'picomatch';
import { bestSource, type Label, type Snapshot, type Source } from '@pagebeam/core';
import { Extractors } from './extractor.js';
import { filesAt, readAt } from './git.js';
import { raw } from './raw.js';
import { html } from './html.js';
import { jsx } from './jsx.js';
import { vue } from './vue.js';

const ENV_ASSIGNMENT = /(?:^|\s)(?:-e\s+|--env\s+|export\s+|ENV\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm;

export function defaultExtractors(): Extractors {
  return new Extractors().add(vue).add(jsx).add(html).add(raw);
}

function matches(file: string, include: string[], exclude: string[]): boolean {
  return picomatch.isMatch(file, include, { dot: false, ignore: exclude });
}

export class Unreadable extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(`${file} could not be read: ${reason}`);
  }
}

async function readOrThrow(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Unreadable(file, code ?? (error as Error).message);
  }
}

export interface SnapshotRequest {
  app: string;
  root: string;
  include: string[];
  exclude: string[];
  envFiles: string[];
  rev?: string | undefined;
  extractors?: Extractors | undefined;
}

export async function snapshot(request: SnapshotRequest): Promise<Snapshot> {
  const extractors = request.extractors ?? defaultExtractors();
  const rev = request.rev;

  const files =
    rev === undefined
      ? await glob(request.include, { cwd: request.root, ignore: request.exclude })
      : (await filesAt(request.root, rev)).filter((f) =>
          matches(f, request.include, request.exclude),
        );

  const labels: Label[] = [];
  const files_: { path: string; text: string }[] = [];
  const sources: Source[] = [];

  for (const file of files) {
    const source =
      rev === undefined
        ? await readFile(path.join(request.root, file), 'utf8').catch(() => null)
        : await readAt(request.root, rev, file);
    if (source === null) continue;

    files_.push({ path: file, text: source });
    const extractor = extractors.for(file);
    if (extractor === null) continue;
    sources.push(extractor.source);
    labels.push(...extractor.extract(source, file));
  }

  const envKeys = new Set<string>();
  const envPaths =
    rev === undefined
      ? await glob(request.envFiles, { cwd: request.root, ignore: ['**/node_modules/**'] })
      : (await filesAt(request.root, rev)).filter((f) => matches(f, request.envFiles, []));
  for (const file of envPaths) {
    const source =
      rev === undefined
        ? await readOrThrow(path.join(request.root, file))
        : await readAt(request.root, rev, file);
    if (source === null) continue;
    ENV_ASSIGNMENT.lastIndex = 0;
    for (const m of source.matchAll(ENV_ASSIGNMENT)) envKeys.add(m[1] as string);
  }

  return {
    app: request.app,
    rev: rev ?? null,
    source: bestSource(sources),
    labels,
    envKeys: [...envKeys],
    files: files_,
  };
}
