import { z } from 'zod';

export const ignoreFileSchema = z.object({
  findings: z
    .array(z.object({ id: z.string(), reason: z.string().optional(), by: z.string().optional() }))
    .default([]),
  features: z.array(z.string()).default([]),
});

export type IgnoreFile = z.infer<typeof ignoreFileSchema>;

export interface InlineIgnore {
  path: string;
  check?: string;
  reason?: string;
  line: number;
}

export class Ignores {
  private readonly ids: Set<string>;
  private readonly inline: InlineIgnore[];

  constructor(file: IgnoreFile, inline: InlineIgnore[] = []) {
    this.ids = new Set(file.findings.map((f) => f.id));
    this.inline = inline;
  }

  silences(finding: { id: string; check: string; doc: { path: string; line?: number } }): boolean {
    if (this.ids.has(finding.id)) return true;
    return this.inline.some(
      (i) =>
        i.path === finding.doc.path &&
        (i.check === undefined || i.check === finding.check) &&
        (finding.doc.line === undefined || Math.abs(i.line - finding.doc.line) <= 2),
    );
  }
}
