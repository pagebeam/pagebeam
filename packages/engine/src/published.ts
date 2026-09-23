import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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

export async function publishedPaths(dir: string, wanted: Iterable<string>): Promise<Published> {
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
      const text = await readFile(here, 'utf8').catch(unlessGone(null));
      if (text === null) continue;
      // A built page escapes what it shows, so the same address is written
      // several ways. Both the plain form and the escaped one are looked for.
      const flat = text.replace(/&#x2F;|&#47;/gi, '/').replace(/&amp;/gi, '&');
      for (const one of looking) {
        if (!found.has(one) && flat.includes(one)) found.add(one);
      }
    }
  };

  await walk(dir);
  return { found, complete };
}
