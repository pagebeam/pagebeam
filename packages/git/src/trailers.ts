import type { Finding } from '@pagebeam/core';

export const FINDING_ID = 'Pagebeam-Finding-Id';
export const FINDING_REVISION = 'Pagebeam-Finding-Revision';
export const CHECK = 'Pagebeam-Check';
export const STANDING = 'Pagebeam-Standing';

export interface Trailers {
  id: string;
  revision: string;
  check: string;
  standing: string;
}

export function trailersFor(finding: Finding): string {
  return [
    `${FINDING_ID}: ${finding.id}`,
    `${FINDING_REVISION}: ${finding.revision}`,
    `${CHECK}: ${finding.check}`,
    `${STANDING}: ${finding.standing}`,
  ].join('\n');
}

export function messageFor(finding: Finding, subject: string): string {
  return `${subject}\n\n${finding.detail}\n\n${trailersFor(finding)}\n`;
}

// A commit without these was written by a person, and a person's work is not
// something to force out of the way.
export function readTrailers(message: string): Trailers | null {
  const value = (name: string): string | null =>
    message.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;

  const id = value(FINDING_ID);
  if (id === null) return null;
  return {
    id,
    revision: value(FINDING_REVISION) ?? '',
    check: value(CHECK) ?? '',
    standing: value(STANDING) ?? '',
  };
}

export function byPagebeam(messages: string[]): boolean {
  return messages.length > 0 && messages.every((m) => readTrailers(m) !== null);
}
