import {
  bestSource,
  caveatOf,
  confidenceOf,
  findingId,
  findingRevision,
  severityOf,
  standingOf,
  type Finding,
  type Grade,
  type Snapshot,
  type Source,
} from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

const PLACEHOLDER = /\{\{?\s*[\w.]+\s*\}?\}|%[sd]|%\d+\$[sd]|\$\{[^}]*\}/g;
const VAR = '⟨var⟩';
const ENV_LIKE = /^[A-Z][A-Z0-9_]*$/;
const CODE_LIKE = /[(){}[\]<>|\\]|\w\.\w|^[/~.]|^-{1,2}\w|::|_/;

// A control is named after a verb that acts on it, or before the noun that
// says what it is. Emphasis with neither is ordinary prose emphasis.
const VERB_BEFORE = /\b(click|select|choose|press|open|tap|toggle|hit|use|pick|expand|enable|disable|tick|navigate to|go to|headed|titled|tooltipped|labelled|labeled|named)\b[^.]{0,40}$/i;
const NOUN_AFTER = /^[^.]{0,30}\b(button|tab|menu|link|toggle|field|option|dialog|drawer|panel|checkbox|icon|section|page|screen)\b/i;

// "the share-shaped icon" describes a control; it does not quote its label.
const DESCRIBES = /\b(button|icon|tab|menu|field|dialog|drawer|panel|checkbox|section|page|screen|toggle|link)$/i;
const PATH_SEPARATOR = /\s*(?:\u2192|\u00bb|->|>)\s*/;
const LEADING_GLYPH = /^[^\p{L}\p{N}]+/u;
const MIN_TAIL = 12;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '\u2192', mdash: '\u2014',
};

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function normalise(value: string): string {
  return decode(value)
    .normalize('NFKC')
    .replace(PLACEHOLDER, VAR)
    .replace(/\b[A-Z]\b(?=\s|$)/g, VAR)
    .replace(/\b\d+\b/g, VAR)
    .replace(/\s+/g, ' ')
    .replace(/[…:]+$/, '')
    .trim()
    .toLowerCase();
}

export interface Candidate {
  literal: string;
  normalised: string;
  page: string;
  line: number;
}

export function candidates(pages: DocPage[], strict = true): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    for (const run of page.emphasised) {
      if (run.marker === 'code') continue;
      const literal = run.value.trim();
      if (literal.length < 3 || literal.length > 60) continue;
      if (/[\r\n]/.test(run.value)) continue;
      // Without an earlier revision, nothing can tell a control from a phrase,
      // so only text a sentence treats as a control is considered. With one,
      // the comparison does that work and the guessing is dropped.
      if (strict && !VERB_BEFORE.test(run.before) && !NOUN_AFTER.test(run.after)) continue;
      if (strict && DESCRIBES.test(literal)) continue;
      if (/[.!?]$/.test(literal)) continue;
      if (literal.endsWith(':')) continue;
      if (ENV_LIKE.test(literal)) continue;
      if (CODE_LIKE.test(literal)) continue;
      if (!/[a-z]/i.test(literal)) continue;

      const normalised = normalise(literal);
      if (normalised === '') continue;
      const key = `${page.path}|${normalised}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ literal, normalised, page: page.path, line: run.line });
    }
  }
  return out;
}

export interface Dictionary {
  app: string;
  labels: Map<string, string>;
  text: string[];
  parsed: boolean;
  source: Source;
}

export function dictionaryOf(snapshot: Snapshot): Dictionary {
  const labels = new Map<string, string>();
  for (const label of snapshot.labels) {
    const key = normalise(label.text);
    if (key.length >= 3 && !labels.has(key)) labels.set(key, label.kind);
  }
  return {
    app: snapshot.app,
    labels,
    text: snapshot.files.map((f) => normalise(f.text)),
    parsed: snapshot.labels.length > 0,
    source: snapshot.source,
  };
}

function forms(normalised: string): string[] {
  const out = new Set<string>([normalised]);
  const bare = normalised.replace(LEADING_GLYPH, '').trim();
  if (bare.length >= 3) out.add(bare);
  return [...out];
}

function assembled(normalised: string, dictionaries: Dictionary[]): boolean {
  const words = normalised
    .split(VAR)
    .join(' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  // Same rule as a whole match: where labels were read, only labels answer.
  return dictionaries.some((d) =>
    d.parsed
      ? [...d.labels.keys()].some((l) => words.every((w) => l.includes(w)))
      : d.text.some((h) => words.every((w) => h.includes(w))),
  );
}

// A label is the strongest answer. Text is only consulted for an application
// no parser covers, and a comment mentioning a control is not the control.
export function locate(
  normalised: string,
  dictionaries: Dictionary[],
): { app: string; kind: string; source: Source } | null {
  const parts = normalised.split(PATH_SEPARATOR).map((s) => s.trim()).filter((s) => s.length >= 3);
  const each = parts.length > 1 ? parts : forms(normalised);

  for (const dictionary of dictionaries) {
    for (const form of each) {
      const kind = dictionary.labels.get(form);
      if (kind !== undefined) return { app: dictionary.app, kind, source: dictionary.source };
    }
  }
  if (parts.length > 1) {
    const found = parts.every((part) => dictionaries.some((d) => d.labels.has(part)));
    if (found) {
      return {
        app: dictionaries[0]?.app ?? '',
        kind: 'path',
        source: dictionaries[0]?.source ?? 'raw',
      };
    }
  }
  for (const dictionary of dictionaries) {
    if (dictionary.parsed) continue;
    for (const form of each) {
      if (dictionary.text.some((h) => h.includes(form))) {
        return { app: dictionary.app, kind: 'text', source: dictionary.source };
      }
    }
  }
  // Only a label with a placeholder can be scattered across an expression.
  // Applying this to a plain phrase matches any label sharing its words.
  if (!normalised.includes(VAR)) return null;
  if (!assembled(normalised, dictionaries)) return null;
  return { app: '', kind: 'assembled', source: bestSource(dictionaries.map((d) => d.source)) };
}

export function compare(
  found_: Candidate[],
  now: Dictionary[],
  before: Dictionary[] | null,
  grade: Grade,
): Finding[] {
  const searched = now.map((d) => d.app).join(', ');
  const runCaveat = caveatOf(grade);
  const findings: Finding[] = [];

  for (const candidate of found_) {
    if (locate(candidate.normalised, now) !== null) continue;

    // With history, a control has to have existed to count as removed.
    let was: { app: string; kind: string; source: Source } | null = null;
    if (before !== null) {
      was = locate(candidate.normalised, before);
      if (was === null) continue;
    }

    // A claim about one application cannot borrow another's parser.
    const mine: Grade = { source: was?.source ?? grade.source, depth: grade.depth };
    const words = candidate.literal.split(/\s+/).length;
    const confidence = confidenceOf(mine, words >= 2 ? 0.9 : 0.6);

    findings.push({
      id: findingId('strings', candidate.page, candidate.normalised),
      revision: findingRevision(candidate.normalised),
      check: 'strings',
      standing: was === null ? 'review' : standingOf(mine),
      ...(was?.app ? { app: was.app } : {}),
      severity: severityOf(mine),
      confidence,
      doc: { path: candidate.page, line: candidate.line },
      title:
        was === null
          ? `"${candidate.literal}" is in no application`
          : `"${candidate.literal}" was removed from ${was.app}`,
      detail:
        (was === null
          ? `This page tells the reader to look for "${candidate.literal}". Nothing in ${searched} has it.`
          : `This page tells the reader to look for "${candidate.literal}". It was a ${was.kind} in ${was.app} and is gone.`) +
        (() => {
          const caveat = caveatOf(mine) ?? runCaveat;
          return caveat === null ? '' : ` ${caveat}`;
        })(),
      evidence: [
        { kind: 'documented-at', detail: `${candidate.page}:${candidate.line}` },
        { kind: 'searched', detail: searched },
      ],
    });
  }
  return findings;
}
