import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { visibleText } from '@pagebeam/core';

// What a reader is actually served, rather than what happens to be written in
// a source file. A documentation site may publish its API reference from the
// specification instead of from prose somebody wrote, and then the operations
// are documented without a single source page mentioning one.
//
// Reading the built site answers that for any site, whatever built it. Asking
// which tool it used would need a list of every tool there has ever been.
const PAGES = /\.html?$/i;
export const PAGE_LIMIT = 4000;

export interface Published {
  // `METHOD /path` for every operation a reader is shown with its method.
  found: Set<string>;
  complete: boolean;
}

// Only a file that vanished mid-scan is skipped; any other read error is thrown.
function unlessGone<T>(fallback: T): (error: unknown) => T {
  return (error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return fallback;
    throw error;
  };
}

// An operation is a method followed by a whole path, so `GET /health DELETE
// /users` shows GET /health and DELETE /users and nothing else, and `/v1/users`
// is its own path.
const OPERATION = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/[A-Za-z0-9_/{}.:~-]*)/gi;

function operationsIn(text: string): Set<string> {
  const shown = new Set<string>();
  for (const m of text.matchAll(OPERATION)) {
    shown.add(`${(m[1] as string).toUpperCase()} ${(m[2] as string).replace(/[.:]+$/, '')}`);
  }
  return shown;
}

export async function publishedPaths(
  dir: string,
  wanted: Iterable<{ method: string; path: string }>,
): Promise<Published> {
  const looking = [...wanted];
  const found = new Set<string>();
  let read = 0;
  let complete = true;

  const walk = async (at: string): Promise<void> => {
    if (found.size === looking.length) return;
    const entries = await readdir(at, { withFileTypes: true }).catch(unlessGone([]));
    for (const entry of entries) {
      if (found.size === looking.length) return;
      const here = path.join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(here);
        continue;
      }
      if (!PAGES.test(entry.name)) continue;
      if (read >= PAGE_LIMIT) {
        complete = false;
        return;
      }
      read += 1;
      const html = await readFile(here, 'utf8').catch(unlessGone(null));
      if (html === null) continue;
      const shown = operationsIn(visibleText(html));
      for (const op of looking) {
        const key = `${op.method.toUpperCase()} ${op.path}`;
        if (shown.has(key)) found.add(key);
      }
    }
  };

  await walk(dir);
  return { found, complete };
}
