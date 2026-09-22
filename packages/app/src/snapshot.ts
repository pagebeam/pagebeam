import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import picomatch from 'picomatch';
import { bestSource, type Label, type Snapshot, type Source } from '@pagebeam/core';
import { CannotParse, Extractors } from './extractor.js';
import { filesAt, readAt } from './git.js';
import { raw } from './raw.js';
import { render, unavailable, type Auth, type Route } from './render.js';
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

export interface Viewing {
  baseUrl: string;
  routes: (string | Route)[];
  auth?: Auth | undefined;
  timeoutMs?: number | undefined;
}

export interface SnapshotRequest {
  app: string;
  root: string;
  include: string[];
  exclude: string[];
  envFiles: string[];
  rev?: string | undefined;
  extractors?: Extractors | undefined;
  viewing?: Viewing | undefined;
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
  const unparsed: { file: string; reason: string }[] = [];

  for (const file of files) {
    const source =
      rev === undefined
        ? await readOrThrow(path.join(request.root, file))
        : await readAt(request.root, rev, file);
    if (source === null) continue;

    files_.push({ path: file, text: source });
    const extractor = extractors.for(file);
    if (extractor === null) continue;
    sources.push(extractor.source);
    try {
      labels.push(...extractor.extract(source, file));
    } catch (error) {
      if (!(error instanceof CannotParse)) throw error;
      unparsed.push({ file, reason: error.reason });
    }
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

  // Opening the running application adds what its files cannot show: a label
  // a catalogue resolves, or one a framework with no parser renders. It never
  // subtracts, because it only ever visited some of the pages.
  let whole = true;
  let source = bestSource(sources);
  let refused: string | null = null;
  if (request.viewing !== undefined && rev === undefined) {
    const seen = await render({
      app: request.app,
      baseUrl: request.viewing.baseUrl,
      routes: request.viewing.routes,
      auth: request.viewing.auth,
      timeoutMs: request.viewing.timeoutMs,
    });
    if (unavailable(seen)) {
      refused = seen.reason;
    } else {
      labels.push(...seen.labels);
      if (sources.every((s) => s === 'raw')) {
        source = 'rendered';
        whole = false;
      }
    }
  }

  return {
    app: request.app,
    rev: rev ?? null,
    source,
    whole,
    covered: sources.some((s) => s !== 'raw'),
    unparsed,
    ...(refused === null ? {} : { refused }),
    labels,
    envKeys: [...envKeys],
    files: files_,
  };
}
