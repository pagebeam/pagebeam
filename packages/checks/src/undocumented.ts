import { findingId, findingRevision, type Finding, type Snapshot } from '@pagebeam/core';
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
}

function areaOf(file: string): string {
  const parts = file.split('/');
  return parts.length <= 2 ? file : parts.slice(0, 2).join('/');
}

// What the application offers, gathered the way somebody would meet it: a
// screen at a time, not a control at a time.
export function areasOf(snapshots: Snapshot[], pages: DocPage[]): Area[] {
  const corpus = normalise(
    pages.map((p) => `${p.prose} ${p.emphasised.map((e) => e.value).join(' ')}`).join(' '),
  );

  const grouped = new Map<string, Area>();
  for (const snapshot of snapshots) {
    for (const label of snapshot.labels) {
      const key = `${snapshot.app}|${areaOf(label.file)}`;
      const area =
        grouped.get(key) ??
        ({ app: snapshot.app, where: areaOf(label.file), controls: [], documented: [] } as Area);
      const text = normalise(label.text);
      if (!asksAbout(label.text) || area.controls.includes(label.text)) {
        grouped.set(key, area);
        continue;
      }
      area.controls.push(label.text);
      if (corpus.includes(text)) area.documented.push(label.text);
      grouped.set(key, area);
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
      ],
    });
  }
  return findings.sort((a, b) => a.doc.path.localeCompare(b.doc.path));
}
