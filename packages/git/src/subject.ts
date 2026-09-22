// Commits and pull request titles land in somebody else's repository, where a
// rule about how they are written is usually already enforced. Conventional
// Commits is what that rule almost always is, so it is what these follow.
//
// The type is settable because a repository that keeps its documentation
// beside its code may want a scope, and one that does not use the convention
// at all may want none.
const HEADER_MOST = 100;

export interface Naming {
  // The type and optional scope, written as they appear: `docs`,
  // `docs(guide)`, `chore`. Empty writes no prefix at all.
  prefix?: string | undefined;
}

// A description under the convention begins in lower case and carries no full
// stop. A control's own name keeps the case it has, because "Add transaction"
// is what somebody will look for on the screen.
function described(title: string): string {
  const withoutStop = title.replace(/\.+$/, '');
  const first = withoutStop[0];
  if (first === undefined) return withoutStop;
  const second = withoutStop[1] ?? '';
  // Left alone when it opens with a quoted label, or reads as a name rather
  // than a sentence: `"Add transaction" is now called`, `GITHUB_TOKEN is`.
  if (!/[a-zA-Z]/.test(first) || withoutStop.slice(0, 2) === first + second.toUpperCase()) {
    return withoutStop;
  }
  return first.toLowerCase() + withoutStop.slice(1);
}

export function subjectFor(title: string, naming: Naming = {}): string {
  const prefix = (naming.prefix ?? 'docs').trim();
  const head = prefix === '' ? described(title) : `${prefix}: ${described(title)}`;
  if (head.length <= HEADER_MOST) return head;
  // Cut at a word so the description still reads, and mark that it was cut.
  const room = HEADER_MOST - 1;
  const cut = head.slice(0, room);
  const at = cut.lastIndexOf(' ');
  return `${(at > prefix.length + 8 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}…`;
}
