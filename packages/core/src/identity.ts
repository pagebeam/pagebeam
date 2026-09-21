import { createHash } from 'node:crypto';

const ID_LENGTH = 12;

function digest(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p);
    h.update('\u0000');
  }
  return h.digest('hex');
}

export function findingId(check: string, docPath: string, target: string): string {
  return digest([check, docPath, target]).slice(0, ID_LENGTH);
}

export function findingRevision(proposed: string | Buffer): string {
  return createHash('sha256').update(proposed).digest('hex').slice(0, ID_LENGTH);
}
