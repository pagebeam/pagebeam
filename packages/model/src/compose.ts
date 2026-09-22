import { findingRevision, type Finding } from '@pagebeam/core';
import { ask, Unanswered, type Router } from './client.js';

// Writing a page that does not exist yet, rather than correcting one that does.
// The controls were found in the application; what they do was not, so the
// limit on inventing behaviour matters more here than anywhere else.
const WRITING = [
  'You write technical documentation.',
  'You are told about controls a product offers that no page describes, and given an existing page from the same documentation as an example of its format and voice.',
  'Write a page describing those controls.',
  'Match the example page exactly in format: the same file syntax, the same front matter or imports if it has them, the same heading style.',
  'Describe only what the control names tell you. Where a name does not say what it does, say plainly that it opens or sets that thing, and no more.',
  'Never invent a behaviour, a setting, a keyboard shortcut, a default, or a consequence. A reader must not be told anything that was not established.',
  'Do not add commentary about what you were asked or what you could not determine.',
  'Reply with the complete page and nothing else. No code fence around it.',
].join('\n');

const EXTENDING = [
  'You maintain technical documentation.',
  'You are given a page and a list of controls the product offers that no page describes.',
  'Add coverage of those controls to the page, in the place it belongs.',
  'Leave every existing sentence, heading, link and code block exactly as it is. Only add.',
  'Describe only what the control names tell you. Never invent a behaviour, a setting, a default, or a consequence.',
  'Do not add commentary about what you changed.',
  'Reply with the complete page and nothing else. No code fence around it.',
].join('\n');

function unfenced(said: string): string {
  const fenced = said.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  return (fenced?.[1] ?? said).trim();
}

function withSkills(base: string, skills: string[]): string {
  const given = skills.map((s) => s.trim()).filter((s) => s !== '');
  if (given.length === 0) return base;
  return [
    base,
    '',
    'The project keeps its own instructions for writing its documentation.',
    'Follow them wherever they do not contradict anything above.',
    '',
    ...given,
  ].join('\n');
}

export interface Target {
  // Where the page would sit, relative to the documentation root.
  path: string;
  // Its current contents, when a page is already there to be added to.
  existing?: string | undefined;
  // A page from the same documentation, so format and voice are matched
  // rather than guessed at.
  example?: { path: string; text: string } | undefined;
}

// A screen full of controls nobody documented cannot be mended by editing a
// page, because there is no page. What it needs written is the thing missing.
export async function compose(
  router: Router,
  finding: Finding,
  target: Target,
  skills: string[] = [],
): Promise<Finding | null> {
  if (finding.fix !== undefined) return finding;

  // The detail is what a person is shown, and it stops after a few names.
  // The evidence carries all of them.
  const every = finding.evidence.find((e) => e.kind === 'undocumented')?.detail;
  const asked = [
    `Product area: ${finding.doc.path}`,
    every === undefined
      ? `Controls nothing describes: ${finding.detail}`
      : `Controls nothing describes, one per line:\n${every}`,
    '',
    target.existing === undefined
      ? target.example === undefined
        ? ''
        : `Example page from this documentation (${target.example.path}):\n${target.example.text}`
      : `Page to add to (${target.path}):\n${target.existing}`,
  ].join('\n');

  let said: string;
  try {
    said = unfenced(
      await ask(router, withSkills(target.existing === undefined ? WRITING : EXTENDING, skills), asked),
    );
  } catch (error) {
    if (error instanceof Unanswered) return null;
    throw error;
  }

  if (said === '') return null;
  // Adding to a page can only make it longer. A shorter answer means the page
  // was replaced rather than extended, and the rest of it would be lost.
  if (target.existing !== undefined && said.length < target.existing.trim().length) return null;

  return {
    ...finding,
    revision: findingRevision(said),
    fix: {
      kind: 'new-file',
      author: 'model',
      changes: [{ path: target.path, mode: 'write', contents: `${said}\n` }],
    },
  };
}
