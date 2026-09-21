import { readFile } from 'node:fs/promises';
import { glob } from 'tinyglobby';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
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

export function candidates(pages: DocPage[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    for (const run of page.emphasised) {
      if (run.marker === 'code') continue;
      const literal = run.value.trim();
      if (literal.length < 3 || literal.length > 60) continue;
      if (/[\r\n]/.test(run.value)) continue;
      if (!VERB_BEFORE.test(run.before) && !NOUN_AFTER.test(run.after)) continue;
      if (DESCRIBES.test(literal)) continue;
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

export interface StringIndex {
  app: string;
  haystack: string[];
  files: number;
}

export async function indexApp(
  name: string,
  root: string,
  include: string[],
  exclude: string[],
): Promise<StringIndex> {
  const files = await glob(include, { cwd: root, ignore: exclude, absolute: true });
  const haystack: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text !== '') haystack.push(normalise(text));
  }
  return { app: name, haystack, files: files.length };
}

function anywhere(needle: string, indexes: StringIndex[]): string | null {
  for (const index of indexes) {
    if (index.haystack.some((h) => h.includes(needle))) return index.app;
  }
  return null;
}

function forms(normalised: string): string[] {
  const out = new Set<string>([normalised]);

  const bare = normalised.replace(LEADING_GLYPH, '').trim();
  if (bare.length >= 3) out.add(bare);

  return [...out];
}

// A label built from interpolation never appears whole in the source, so each
// literal run between the placeholders has to be found in one file instead.
function assembled(normalised: string, indexes: StringIndex[]): string | null {
  const words = normalised
    .split(VAR)
    .join(' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return null;

  for (const index of indexes) {
    if (index.haystack.some((h) => words.every((w) => h.includes(w)))) return index.app;
  }
  return null;
}

function found(candidate: Candidate, indexes: StringIndex[]): string | null {
  const parts = candidate.normalised.split(PATH_SEPARATOR).map((s) => s.trim()).filter((s) => s.length >= 3);
  if (parts.length > 1) {
    const hits = parts.map((p) => anywhere(p, indexes));
    return hits.every((h) => h !== null) ? (hits[0] as string) : null;
  }

  for (const form of forms(candidate.normalised)) {
    const app = anywhere(form, indexes);
    if (app !== null) return app;
  }
  return candidate.normalised.includes(VAR) ? assembled(candidate.normalised, indexes) : null;
}

export function compare(
  found_: Candidate[],
  indexes: StringIndex[],
  minConfidence: number,
): Finding[] {
  const searched = indexes.map((i) => i.app);
  const findings: Finding[] = [];

  for (const candidate of found_) {
    if (found(candidate, indexes) !== null) continue;
    const words = candidate.literal.split(/\s+/).length;
    const confidence = words >= 2 ? 0.75 : 0.45;
    if (confidence < minConfidence) continue;

    findings.push({
      id: findingId('strings', candidate.page, candidate.normalised),
      revision: findingRevision(candidate.normalised),
      check: 'strings',
      severity: 'warn',
      confidence,
      doc: { path: candidate.page, line: candidate.line },
      title: `"${candidate.literal}" appears in no application`,
      detail:
        `This page tells the reader to look for "${candidate.literal}". ` +
        `That text is in none of ${searched.join(', ')}. ` +
        `Either it was renamed, or it is assembled at runtime and cannot be found by reading the source.`,
      evidence: [
        { kind: 'documented-at', detail: `${candidate.page}:${candidate.line}` },
        { kind: 'searched', detail: searched.join(', ') },
      ],
    });
  }
  return findings;
}
