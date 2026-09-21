export type CheckId =
  | 'links'
  | 'config-keys'
  | 'openapi'
  | 'strings'
  | 'screenshots'
  | 'coverage';

export type Severity = 'error' | 'warn' | 'info';

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
  splice?: { start: number; end: number; text: string };
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
