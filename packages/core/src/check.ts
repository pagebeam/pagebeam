export type CheckId =
  | 'links'
  | 'config-keys'
  | 'openapi'
  | 'strings'
  | 'screenshots'
  | 'coverage';

export type Severity = 'error' | 'warn' | 'info';

// What the evidence can carry, which is not the same as how sure we are.
// proven: the source of truth itself says so. A built site has no such route.
// review: something a person should look at. Absence from what could be read
// is not absence from the product.
export type Standing = 'proven' | 'review';

export interface SourceRef {
  path: string;
  line?: number;
  column?: number;
  offset?: [number, number];
}

export interface Evidence {
  kind: string;
  detail: string;
  ref?: SourceRef;
}

export interface FileChange {
  path: string;
  mode: 'write' | 'delete';
  contents?: Buffer | string;
  // `was` is what those bytes held when the offsets were worked out. If the
  // file has moved on, the offsets mean nothing and the change is refused.
  splice?: { start: number; end: number; text: string; was?: string };
}

export interface Fix {
  kind: 'text-splice' | 'binary-replace' | 'new-file';
  author: 'deterministic' | 'model';
  changes: FileChange[];
}

export interface Finding {
  id: string;
  revision: string;
  check: string;
  standing: Standing;
  // null when there is nothing to compare the documentation against.
  introduced?: boolean | null;
  app?: string;
  severity: Severity;
  confidence: number;
  doc: SourceRef;
  title: string;
  detail: string;
  evidence: Evidence[];
  fix?: Fix;
}

export interface RunContext {
  docsRoot: string;
  appRoot?: string;
  config: unknown;
  signal?: AbortSignal;
}

export interface FixContext extends RunContext {
  allowModel: boolean;
}

export interface Check<T = unknown> {
  readonly id: CheckId | string;
  readonly version: string;
  collect(ctx: RunContext): Promise<T[]>;
  run(subjects: T[], ctx: RunContext): Promise<Finding[]>;
  fix?(findings: Finding[], ctx: FixContext): Promise<FileChange[]>;
}
