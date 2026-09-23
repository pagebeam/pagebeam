// Two independent axes. Where the labels came from, and whether there is an
// earlier revision to compare them with. An application with no parser can
// still have perfect history; one with a parser may have none.
// rendered is what a build emitted or a running application served. parsed is
// source read with a real parser. raw is text nobody understood.
export type Source = 'rendered' | 'parsed' | 'raw';
export type Depth = 'paired' | 'single';

export const SOURCE_ORDER: Source[] = ['rendered', 'parsed', 'raw'];

const SOURCE_CEILING: Record<Source, number> = {
  rendered: 0.95,
  parsed: 0.85,
  raw: 0.55,
};

// Without an earlier revision a missing label may never have existed, which is
// a different claim from one that was removed.
const DEPTH_FACTOR: Record<Depth, number> = { paired: 1, single: 0.7 };

export interface Grade {
  source: Source;
  depth: Depth;
  // Whether everything the application could show was examined. Reading files
  // covers all of them. Driving a running application covers the pages
  // somebody thought to visit, which is not the same thing.
  whole?: boolean;
}

export function bestSource(sources: Source[]): Source {
  for (const s of SOURCE_ORDER) if (sources.includes(s)) return s;
  return 'raw';
}

// Rendering proves a control exists. It cannot prove one does not, because a
// page nobody opened shows nothing. For an absence, a complete reading of the
// source is the stronger evidence, so a partial view is capped below it.
const PARTIAL_CEILING = 0.5;

export function confidenceOf(grade: Grade, base = 1): number {
  const ceiling =
    grade.whole === false
      ? Math.min(SOURCE_CEILING[grade.source], PARTIAL_CEILING)
      : SOURCE_CEILING[grade.source];
  return Math.min(base, ceiling * DEPTH_FACTOR[grade.depth]);
}

// Only a complete reading compared against a known earlier state can prove a
// thing was removed. Everything else is a reason to look.
export function standingOf(grade: Grade): 'proven' | 'review' {
  if (grade.whole === false) return 'review';
  return grade.depth === 'paired' && grade.source !== 'raw' ? 'proven' : 'review';
}

export function severityOf(grade: Grade): 'error' | 'warn' | 'info' {
  if (grade.whole === false) return 'info';
  if (grade.depth === 'paired' && grade.source !== 'raw') return 'error';
  if (grade.source === 'raw' && grade.depth === 'single') return 'info';
  return 'warn';
}

export function caveatOf(grade: Grade): string | null {
  const parts: string[] = [];
  if (grade.source === 'raw') {
    parts.push('No parser covers this application, so its files were searched as text');
  } else if (grade.source === 'parsed') {
    parts.push('Labels were read from source, so anything assembled at runtime may be missed');
  }
  if (grade.whole === false) {
    parts.push(
      'only the parts of the application that were opened were examined, so this may be somewhere nobody looked',
    );
  }
  if (grade.depth === 'single') {
    parts.push('there is no earlier revision, so this may never have existed rather than having been removed');
  }
  return parts.length === 0 ? null : `${parts.join(', and ')}.`;
}

export interface Label {
  text: string;
  kind: string;
  file: string;
  line?: number;
  // Source says what the product calls things. A running application says
  // what one person saw, which includes their own data wearing the same
  // clothes as a label.
  from?: 'source' | 'rendered';
}

export interface Snapshot {
  app: string;
  rev: string | null;
  source: Source;
  // False when only part of the application was examined, which is the case
  // for anything read from a running application rather than from its files.
  whole: boolean;
  // Why the running application could not be read, when it was asked for.
  refused?: string;
  // Whether a parser claimed this application's files at all, which is a
  // different question from whether it found any controls in them.
  covered: boolean;
  unparsed: { file: string; reason: string }[];
  labels: Label[];
  envKeys: string[];
  files: { path: string; text: string }[];
  // Framework configuration at the application's root, read whatever the
  // include says, because it decides which files are routes.
  routeConfig?: { path: string; text: string }[];
}

export interface AppEvidence {
  now: Snapshot[];
  before: Snapshot[] | null;
  grade: Grade;
}
