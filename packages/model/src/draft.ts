import type { Finding } from '@pagebeam/core';
import { ask, Unanswered, type Router } from './client.js';

// What the model is allowed to do, stated as narrowly as it can be. It is
// rewriting one page that is already known to be wrong, and the evidence for
// why it is wrong was worked out before the model was asked.
//
// A project's own instructions are added after this and cannot displace it.
// Everything here is the shape of the answer and the refusal to invent, which
// a house style has no business changing.
const CONTRACT = [
  'You correct technical documentation.',
  'You are given one page and one problem with it that has already been proven by inspecting the product.',
  'Rewrite the page so the problem is gone.',
  'Change as little as possible. Leave every other sentence, heading, link, code block and blank line exactly as it is.',
  'Do not add commentary, apologies, or notes about what you changed.',
  'Do not invent behaviour. If the problem says a control is gone, remove or correct the reference to it; do not describe a replacement you were not told about.',
  'Reply with the complete corrected page and nothing else. No code fence around it.',
].join('\n');

// Whatever the project keeps for people who write its documentation. pagebeam
// does not know or care what is in them: they may be voice, terminology,
// structure, or things nobody outside the team would guess.
export function systemFor(skills: string[] = []): string {
  const given = skills.map((s) => s.trim()).filter((s) => s !== '');
  if (given.length === 0) return CONTRACT;
  return [
    CONTRACT,
    '',
    'The project keeps its own instructions for writing its documentation.',
    'Follow them wherever they do not contradict anything above.',
    '',
    ...given,
  ].join('\n');
}

function askingFor(finding: Finding, page: string): string {
  // Each one is a kind, what it says, and where it was seen. Run together as
  // text they say nothing at all.
  const evidence =
    finding.evidence.length === 0
      ? ''
      : `\nEvidence:\n${finding.evidence
          .map((e) => {
            const at = e.ref === undefined ? '' : ` (${e.ref.path}${e.ref.line === undefined ? '' : `:${e.ref.line}`})`;
            return `- ${e.kind}: ${e.detail}${at}`;
          })
          .join('\n')}`;
  return [
    `Problem: ${finding.title}`,
    `Detail: ${finding.detail}`,
    evidence,
    '',
    `Page (${finding.doc.path}):`,
    page,
  ].join('\n');
}

// A fence is the most common way a model ignores being told not to add one.
function unfenced(said: string): string {
  const fenced = said.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  return (fenced?.[1] ?? said).trim();
}

export interface Drafted {
  finding: Finding;
  page: string;
}

// The model is asked only where the deterministic checks could not propose
// anything. Where they could, their answer is exact and this one would not be.
export async function draft(
  router: Router,
  finding: Finding,
  page: string,
  skills: string[] = [],
): Promise<Finding | null> {
  if (finding.fix !== undefined) return finding;

  let said: string;
  try {
    said = unfenced(await ask(router, systemFor(skills), askingFor(finding, page)));
  } catch (error) {
    if (error instanceof Unanswered) return null;
    throw error;
  }

  // A page that came back the same is not a correction, and one that came back
  // nearly empty is a model that lost the file rather than edited it.
  if (said === page.trim()) return null;
  if (said.length < page.trim().length / 2) return null;

  return {
    ...finding,
    // What is being asserted is what the finding found, and a model asked the
    // same question twice does not answer it the same way. Hashing what it
    // wrote would rebuild the branch on every run over wording nobody
    // changed, so the finding keeps the revision its own facts gave it.
    fix: {
      kind: 'new-file',
      author: 'model',
      changes: [{ path: finding.doc.path, mode: 'write', contents: `${said}\n` }],
    },
  };
}
