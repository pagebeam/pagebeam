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
}

export function bestSource(sources: Source[]): Source {
  for (const s of SOURCE_ORDER) if (sources.includes(s)) return s;
  return 'raw';
}

export function confidenceOf(grade: Grade, base = 1): number {
  return Math.min(base, SOURCE_CEILING[grade.source] * DEPTH_FACTOR[grade.depth]);
}

export function severityOf(grade: Grade): 'error' | 'warn' | 'info' {
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
}

export interface Snapshot {
  app: string;
  rev: string | null;
  source: Source;
  labels: Label[];
  envKeys: string[];
  text: string[];
}

export interface AppEvidence {
  now: Snapshot[];
  before: Snapshot[] | null;
  grade: Grade;
}
