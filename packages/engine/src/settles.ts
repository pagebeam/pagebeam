import { parseAll, type DocPage } from '@pagebeam/docs';
import type { Finding } from '@pagebeam/core';

// A page a model wrote is a claim that the problem is gone. Nothing was
// checking that claim: a page half the length of the one it replaced, or one
// that did not parse, or one that left the dead link exactly where it was,
// became a commit and a pull request like any other.
//
// What can be established here is narrow and worth having: that the page still
// reads as a page, that what the finding named is no longer in it, and that
// the parts of the old page nobody was asked to touch are still there.
export interface Refused {
  because: string;
}

async function parsed(path: string, text: string): Promise<DocPage | null> {
  const pages = await parseAll('', [path], async () => text);
  return pages[0] ?? null;
}

// What a finding says has to stop being true of the page, stated as the text
// that must no longer appear. Where a check names nothing quotable, there is
// nothing to insist on and the page is judged on the rest.
function goneFor(finding: Finding): string | null {
  if (finding.check === 'strings') {
    return finding.title.match(/^"([^"]+)"/)?.[1] ?? null;
  }
  if (finding.check === 'links') {
    return finding.title.match(/^(\S+) does not resolve$/)?.[1] ?? null;
  }
  if (finding.check === 'config-keys' || finding.check === 'openapi') {
    return null;
  }
  return null;
}

export async function settles(
  finding: Finding,
  was: string | null,
  now: string,
): Promise<Refused | null> {
  const path = finding.fix?.changes[0]?.path ?? finding.doc.path;

  const after = await parsed(path, now);
  if (after === null) return { because: 'the page it wrote could not be read as a page' };

  const gone = goneFor(finding);
  if (gone !== null && `${after.prose}\n${after.raw}`.includes(gone)) {
    return { because: `it left "${gone}" exactly where it was` };
  }

  if (was === null) return null;

  const before = await parsed(path, was);
  if (before === null) return null;

  // Everything the old page pointed at and everything it showed as code was
  // there before anybody complained, and no finding asked for it to go.
  const kept = (of: string[], have: string[]): string[] => of.filter((one) => !have.includes(one));

  const lostLinks = kept(
    before.links.map((l) => l.href),
    after.links.map((l) => l.href),
  ).filter((href) => href !== gone);
  if (lostLinks.length > 0) {
    return { because: `it dropped ${lostLinks.length} link(s) nobody asked it to: ${lostLinks.slice(0, 3).join(', ')}` };
  }

  const lostCode = kept(
    before.codeBlocks.map((b) => b.value.trim()),
    after.codeBlocks.map((b) => b.value.trim()),
  );
  if (lostCode.length > 0) {
    return { because: `it dropped ${lostCode.length} code block(s) nobody asked it to` };
  }

  return null;
}
