import { parseAll, type DocPage } from '@pagebeam/docs';
import type { Finding } from '@pagebeam/core';

// A page a model wrote is a claim that the problem is gone. Whether it is gone
// is decided by running the checks again on the page (see `accepted` in
// run.ts), so every check judges its own findings by its own rules.
//
// What is left here is what no check looks at: the page still reads as a page,
// and it kept the links and code nobody asked it to remove.
export interface Refused {
  because: string;
}

async function parsed(path: string, text: string): Promise<DocPage | null> {
  const pages = await parseAll('', [path], async () => text);
  return pages[0] ?? null;
}

// The one link a draft may drop without being asked: the broken one the
// finding is about.
function mayDrop(finding: Finding): string | null {
  if (finding.check !== 'links') return null;
  return finding.title.match(/^(\S+) does not resolve$/)?.[1] ?? null;
}

export async function settles(finding: Finding, was: string | null, now: string): Promise<Refused | null> {
  const path = finding.fix?.changes[0]?.path ?? finding.doc.path;

  const after = await parsed(path, now);
  if (after === null) return { because: 'the page it wrote could not be read as a page' };

  if (was === null) return null;
  const before = await parsed(path, was);
  if (before === null) return null;

  const missing = (of: string[], have: string[]): string[] => of.filter((one) => !have.includes(one));

  const dropped = mayDrop(finding);
  const lostLinks = missing(
    before.links.map((l) => l.href),
    after.links.map((l) => l.href),
  ).filter((href) => href !== dropped);
  if (lostLinks.length > 0) {
    return { because: `it dropped ${lostLinks.length} link(s) nobody asked it to: ${lostLinks.slice(0, 3).join(', ')}` };
  }

  const lostCode = missing(
    before.codeBlocks.map((b) => b.value.trim()),
    after.codeBlocks.map((b) => b.value.trim()),
  );
  if (lostCode.length > 0) {
    return { because: `it dropped ${lostCode.length} code block(s) nobody asked it to` };
  }

  return null;
}
