import { findingRevision, type Finding } from '@pagebeam/core';
import { ask, Unanswered, type Router } from './client.js';

// What the model is allowed to do, stated as narrowly as it can be. It is
// rewriting one page that is already known to be wrong, and the evidence for
// why it is wrong was worked out before the model was asked.
const SYSTEM = [
  'You correct technical documentation.',
  'You are given one page and one problem with it that has already been proven by inspecting the product.',
  'Rewrite the page so the problem is gone.',
  'Change as little as possible. Leave every other sentence, heading, link, code block and blank line exactly as it is.',
  'Do not add commentary, apologies, or notes about what you changed.',
  'Do not invent behaviour. If the problem says a control is gone, remove or correct the reference to it; do not describe a replacement you were not told about.',
  'Reply with the complete corrected page and nothing else. No code fence around it.',
].join('\n');

function askingFor(finding: Finding, page: string): string {
  const evidence = finding.evidence.length === 0 ? '' : `\nEvidence:\n${finding.evidence.join('\n')}`;
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
): Promise<Finding | null> {
  if (finding.fix !== undefined) return finding;

  let said: string;
  try {
    said = unfenced(await ask(router, SYSTEM, askingFor(finding, page)));
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
    // Identity follows the text the model produced. The same page next run is
    // the same revision and nothing is rewritten; a different draft is a
    // different revision and replaces the commit rather than adding to it.
    revision: findingRevision(said),
    fix: {
      kind: 'new-file',
      author: 'model',
      changes: [{ path: finding.doc.path, mode: 'write', contents: `${said}\n` }],
    },
  };
}
