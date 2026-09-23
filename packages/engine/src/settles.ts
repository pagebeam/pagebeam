import { parseAll, type DocPage } from '@pagebeam/docs';
import type { Finding } from '@pagebeam/core';

export interface Refused {
  because: string;
}

async function parsed(path: string, text: string): Promise<DocPage | null> {
  const pages = await parseAll('', [path], async () => text);
  return pages[0] ?? null;
}

function mayDrop(finding: Finding): string | null {
  if (finding.check !== 'links') return null;
  return finding.title.match(/^(\S+) does not resolve$/)?.[1] ?? null;
}

export async function settles(finding: Finding, was: string | null, now: string): Promise<Refused | null> {
  const path = finding.fix?.changes[0]?.path ?? finding.doc.path;

  const after = await parsed(path, now);
  if (after === null) return { because: 'the page it wrote could not be read as a page' };

  // A kept broken link needs no check to see it, whether it is external or not.
  const dropped = mayDrop(finding);
  if (dropped !== null && after.links.some((l) => l.href === dropped)) {
    return { because: `it kept the broken link ${dropped}` };
  }

  if (was === null) return null;
  const before = await parsed(path, was);
  if (before === null) return null;

  const missing = (of: string[], have: string[]): string[] => of.filter((one) => !have.includes(one));

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
