import { findingId, findingRevision, type Finding, type Snapshot } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';
import { candidates, normalise } from './strings.js';

const SHOWN = 3;

export interface Movement {
  app: string;
  changed: string[];
}

// Prose that did not change describes code that did. Nothing here is broken,
// which is the point: it is the one signal that arrives before the breakage.
export function checkMoved(
  pages: DocPage[],
  now: Snapshot[],
  movement: Movement[],
  untouched: (page: string) => boolean,
): Finding[] {
  const moved = new Map(movement.map((m) => [m.app, new Set(m.changed)]));

  const declaring = new Map<string, { app: string; file: string; kind: string }>();
  for (const snapshot of now) {
    for (const label of snapshot.labels) {
      const key = normalise(label.text);
      if (key.length >= 3 && !declaring.has(key)) {
        declaring.set(key, { app: snapshot.app, file: label.file, kind: label.kind });
      }
    }
  }

  const byPage = new Map<string, { app: string; labels: string[] }>();
  for (const candidate of candidates(pages, false)) {
    if (!untouched(candidate.page)) continue;
    const source = declaring.get(candidate.normalised);
    if (source === undefined) continue;
    if (!moved.get(source.app)?.has(source.file)) continue;

    const key = `${candidate.page}|${source.app}`;
    const entry = byPage.get(key) ?? { app: source.app, labels: [] };
    if (!entry.labels.includes(candidate.literal)) entry.labels.push(candidate.literal);
    byPage.set(key, entry);
  }

  const findings: Finding[] = [];
  for (const [key, { app, labels }] of byPage) {
    const page = key.split('|')[0] as string;
    const shown = labels.slice(0, SHOWN).map((l) => `"${l}"`).join(', ');
    const more = labels.length - Math.min(labels.length, SHOWN);
    findings.push({
      id: findingId('moved', page, `${app}|${labels.slice().sort().join('|')}`),
      revision: findingRevision(labels.slice().sort().join('|')),
      check: 'moved',
      standing: 'review',
      app,
      severity: 'info',
      confidence: 0.5,
      doc: { path: page },
      title: `${page} describes ${app} code that changed while the page did not`,
      detail:
        `This page names ${shown}${more > 0 ? ` and ${more} more` : ''}. ` +
        `Those controls still exist, so nothing is broken, but the code declaring them ` +
        `changed and this page did not. Worth reading to see whether it still describes ` +
        `what happens.`,
      evidence: [{ kind: 'unchanged-page', detail: page }],
    });
  }
  return findings.sort((a, b) => a.doc.path.localeCompare(b.doc.path));
}
