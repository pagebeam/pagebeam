import { findingId, findingRevision, type Finding, type Snapshot } from '@pagebeam/core';
import { screensOf } from '@pagebeam/app';
import type { DocPage } from '@pagebeam/docs';
import { normalise } from './strings.js';

const SHOWN = 6;
const WORTH_MENTIONING = 3;

// A fragment of a sentence, an identifier, or a value out of a form is not a
// control somebody goes looking for in the documentation.
const NOT_A_CONTROL = /^[^\p{L}]|_|\w\.\w|^[a-z]+$/u;

function asksAbout(label: string): boolean {
  const text = label.trim();
  if (text.length < 3 || text.length > 60) return false;
  if (NOT_A_CONTROL.test(text)) return false;
  return /[\p{Lu}]/u.test(text) || text.split(/\s+/).length >= 2;
}

export interface Area {
  app: string;
  where: string;
  controls: string[];
  documented: string[];
  // Where the controls were found. A name on its own says nothing about what
  // a control does, so anything meant to describe one needs to read around it.
  files: string[];
}

// The directory a file sits in, because that is the nearest thing in a source
// tree to a part of the product somebody would meet. Taking the file itself
// would make one screen of every component and report them one at a time,
// which is what this check exists not to do.
// Everything that is not a letter or a number becomes a single space, so a
// label and the prose describing it are compared as the words they are and a
// phrase has to appear whole.
function wordsOf(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Where a file sits, used only where a route can be found for nothing: a
// library has no screens, and grouping its controls somehow beats reporting
// none of them.
function whereverItSits(file: string): string {
  const parts = file.split('/');
  return parts.length <= 1 ? '.' : parts.slice(0, -1).join('/');
}

// Every screen a file is part of. A component used by three routes is on
// three screens, and a reader meeting it on any of them finds the same
// nothing written about it. One that no route reaches is on no screen, and
// nothing is owed for something nobody can arrive at.
function screensFor(snapshot: Snapshot): (file: string) => string[] {
  const { reaches, unreached } = screensOf(snapshot.files);
  if (reaches.size === 0) return (file) => [whereverItSits(file)];

  const on = new Map<string, string[]>();
  for (const [address, files] of reaches) {
    for (const file of files) on.set(file, [...(on.get(file) ?? []), address]);
  }
  return (file) => (unreached.has(file) ? [] : (on.get(file) ?? []));
}

// What the application offers, gathered the way somebody would meet it: a
// screen at a time, not a control at a time.
export function areasOf(snapshots: Snapshot[], pages: DocPage[]): Area[] {
  // Matched between boundaries, never as a run of characters. "Save" occurs
  // inside "autosave" and inside "saved", and a page that says either has not
  // described the button.
  const corpus = ` ${wordsOf(
    normalise(pages.map((p) => `${p.prose} ${p.emphasised.map((e) => e.value).join(' ')}`).join(' ')),
  )} `;

  const grouped = new Map<string, Area>();
  for (const snapshot of snapshots) {
    const screens = screensFor(snapshot);
    for (const label of snapshot.labels) {
      // A rendered name may be somebody's own data rather than a label.
      if (label.from === 'rendered') continue;
      for (const where of screens(label.file)) {
        const key = `${snapshot.app}|${where}`;
        const area =
          grouped.get(key) ??
          ({ app: snapshot.app, where, controls: [], documented: [], files: [] } as Area);
        const text = normalise(label.text);
        if (!asksAbout(label.text) || area.controls.includes(label.text)) {
          grouped.set(key, area);
          continue;
        }
        area.controls.push(label.text);
        if (!area.files.includes(label.file)) area.files.push(label.file);
        if (corpus.includes(` ${wordsOf(text)} `)) area.documented.push(label.text);
        grouped.set(key, area);
      }
    }
  }
  return [...grouped.values()];
}

export function checkUndocumented(
  pages: DocPage[],
  now: Snapshot[],
  before: Snapshot[] | null,
): Finding[] {
  const areas = areasOf(now, pages);
  const known =
    before === null
      ? null
      : new Set(before.flatMap((s) => s.labels.map((l) => `${s.app}|${normalise(l.text)}`)));

  const findings: Finding[] = [];
  for (const area of areas) {
    const missing = area.controls.filter((c) => !area.documented.includes(c));
    if (missing.length < WORTH_MENTIONING) continue;

    // With a past to compare against, what arrived recently and went
    // undescribed is the part somebody can still do something about.
    const arrived =
      known === null ? null : missing.filter((c) => !known.has(`${area.app}|${normalise(c)}`));
    const subject = arrived === null ? missing : arrived;
    if (subject.length < WORTH_MENTIONING) continue;

    const shown = subject.slice(0, SHOWN).map((c) => `"${c}"`).join(', ');
    const more = subject.length - Math.min(subject.length, SHOWN);

    findings.push({
      id: findingId('undocumented', `${area.app}/${area.where}`, 'coverage'),
      revision: findingRevision(subject.slice().sort().join('|')),
      check: 'undocumented',
      standing: 'review',
      app: area.app,
      severity: 'info',
      confidence: 0.6,
      doc: { path: area.where },
      title:
        arrived === null
          ? `${area.where} has ${missing.length} control(s) the documentation never mentions`
          : `${area.where} gained ${subject.length} control(s) that nothing documents`,
      detail:
        `${shown}${more > 0 ? ` and ${more} more` : ''}. ` +
        `${area.documented.length} of ${area.controls.length} controls here are described somewhere. ` +
        `Nothing is broken; this is what a reader will meet and find no answer for.`,
      evidence: [
        { kind: 'in', detail: `${area.app}/${area.where}` },
        { kind: 'described', detail: `${area.documented.length} of ${area.controls.length}` },
        // Every one of them, not the handful a person is shown. Anything
        // proposing to cover this area needs the whole list or it will cover
        // the first few and leave the rest exactly as undocumented as before.
        { kind: 'undocumented', detail: subject.join('\n') },
        { kind: 'files', detail: area.files.join('\n') },
      ],
    });
  }
  return findings.sort((a, b) => a.doc.path.localeCompare(b.doc.path));
}
