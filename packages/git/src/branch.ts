import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileChange, Finding } from '@pagebeam/core';
import { messageFor } from './trailers.js';

const run = promisify(execFile);
const BUFFER = 1 << 28;

// An error that does not say what went wrong costs more than it saves.
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: BUFFER });
    return stdout;
  } catch (error) {
    const said = String((error as { stderr?: string }).stderr ?? '').trim();
    throw Object.assign(
      new Error(`git ${args.join(' ')} failed${said === '' ? '' : `: ${said}`}`),
      // Callers distinguish "no such ref" from "the remote refused", and that
      // distinction is the exit code.
      { code: (error as { code?: number }).code ?? null },
    );
  }
}

export async function exists(repo: string, branch: string): Promise<boolean> {
  return git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`).then(
    () => true,
    () => false,
  );
}

export async function commitsOn(repo: string, branch: string, base: string): Promise<string[]> {
  return git(repo, 'log', '--format=%B%x00', `${base}..${branch}`)
    .then((out) => out.split('\u0000').map((m) => m.trim()).filter((m) => m !== ''))
    .catch(() => []);
}

export interface Session {
  dir: string;
  end: () => Promise<void>;
}

// The tool works in a checkout of its own. Somebody's branch, their staged
// work and their open editor are none of its business.
// What is proposed is proposed against what everybody else can see. Building
// on a local base would sweep up commits sitting here unpushed and offer them
// as part of the change, and they would then read as somebody else's work.
export class NoBase extends Error {
  constructor(readonly base: string, readonly reason: string) {
    super(`${base} could not be read from the remote, so there is nothing to propose against: ${reason}`);
  }
}

export async function baseRef(repo: string, base: string): Promise<string> {
  const known = await git(repo, 'ls-remote', '--exit-code', '--heads', 'origin', base).then(
    () => true,
    (error: unknown) => {
      if ((error as { code?: number }).code === 2) return false;
      throw new NoBase(base, (error as Error).message.split(':').slice(-1)[0]?.trim() ?? 'the remote refused');
    },
  );
  // A base the remote has never heard of is a local-only base, which is a
  // coherent thing to work against. A base it refuses to talk about is not.
  if (!known) return base;

  return git(repo, 'fetch', '--quiet', 'origin', `${base}:refs/pagebeam/base`)
    .then(() => 'refs/pagebeam/base')
    .catch((error: unknown) => {
      throw new NoBase(base, (error as Error).message.split('\n')[0] ?? 'the fetch failed');
    });
}

export async function open(repo: string, branch: string, base: string, fresh: boolean): Promise<Session> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-branch-'));
  const at = path.join(dir, 'tree');
  const from = await baseRef(repo, base);

  if (fresh || !(await exists(repo, branch))) {
    await git(repo, 'worktree', 'add', '--detach', at, from);
    await git(at, 'switch', '-C', branch);
    return session(repo, dir, at);
  }

  // Adding to a branch means adding to everything on it: what this clone has
  // and what the remote has. Where those have genuinely diverged, somebody has
  // to look, and it is not going to be resolved by force.
  await git(repo, 'worktree', 'add', at, branch);
  const fetched = await git(repo, 'fetch', '--quiet', 'origin', `${branch}:refs/pagebeam/onto`)
    .then(() => true)
    .catch(() => false);

  if (fetched) {
    const merged = await git(at, 'merge', '--ff-only', 'refs/pagebeam/onto')
      .then(() => true)
      .catch(() => false);

    let diverged = false;
    if (!merged) {
      // Counted while the ref still exists. A count that cannot be taken is
      // not a count of zero, and treating it as one accepts a branch that has
      // gone its own way.
      const ahead = await git(at, 'rev-list', '--count', `${branch}..refs/pagebeam/onto`)
        .then((n) => Number(n.trim()))
        .catch(() => Number.NaN);
      diverged = !Number.isFinite(ahead) || ahead > 0;
    }
    await git(repo, 'update-ref', '-d', 'refs/pagebeam/onto').catch(() => undefined);

    if (diverged) {
      await git(repo, 'worktree', 'remove', '--force', at).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new Diverged(branch);
    }
  }
  return session(repo, dir, at);
}

function session(repo: string, dir: string, at: string): Session {

  return {
    dir: at,
    end: async () => {
      await git(repo, 'worktree', 'remove', '--force', at).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export class Diverged extends Error {
  constructor(readonly branch: string) {
    super(`${branch} here and on the remote have gone different ways; somebody has to look`);
  }
}

export class Escapes extends Error {
  constructor(readonly attempted: string) {
    super(`${attempted} is outside the checkout and will not be written`);
  }
}

// A proposal says where it wants to write. It does not get to say "somewhere
// else entirely", so the resolved path has to still be inside the checkout.
export function within(dir: string, proposed: string): string {
  const root = path.resolve(dir);
  const file = path.resolve(root, proposed);
  const inside = file === root || file.startsWith(`${root}${path.sep}`);
  if (!inside || path.isAbsolute(proposed)) throw new Escapes(proposed);
  return file;
}

// Reading the text of a path is not enough: a link inside the checkout points
// wherever it likes. Every directory on the way has to really be inside it.
export async function reallyWithin(dir: string, proposed: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  const file = within(dir, proposed);
  const root = await realpath(path.resolve(dir));

  let at = path.dirname(file);
  const seen: string[] = [];
  while (at.startsWith(root) || at === root || seen.length === 0) {
    const real = await realpath(at).catch(() => null);
    if (real !== null) {
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Escapes(proposed);
      break;
    }
    seen.push(at);
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }

  const existing = await realpath(file).catch(() => null);
  if (existing !== null && !existing.startsWith(`${root}${path.sep}`) && existing !== root) {
    throw new Escapes(proposed);
  }
  return file;
}

export class Moved extends Error {
  constructor(readonly file: string, readonly expected: string) {
    super(`${file} no longer holds "${expected}" where the change expected it`);
  }
}

// Offsets are worked out against a file as it was read. Applying several of
// them one at a time makes every later one wrong, so a page's changes go in
// together, from the end backwards, and each says what it expects to find.
export async function apply(dir: string, changes: FileChange[]): Promise<void> {
  const byFile = new Map<string, FileChange[]>();
  for (const change of changes) {
    byFile.set(change.path, [...(byFile.get(change.path) ?? []), change]);
  }

  for (const [where, forFile] of byFile) {
    const file = await reallyWithin(dir, where);

    if (forFile.some((c) => c.mode === 'delete')) {
      await rm(file, { force: true });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });

    const whole = forFile.filter((c) => c.splice === undefined && c.contents !== undefined);
    const spliced = forFile
      .filter((c) => c.splice !== undefined)
      .sort((a, b) => (b.splice?.start ?? 0) - (a.splice?.start ?? 0));

    if (spliced.length > 0) {
      let text = await readFile(file, 'utf8');
      for (const change of spliced) {
        const { start, end, text: replacement, was } = change.splice!;
        if (was !== undefined && text.slice(start, end) !== was) throw new Moved(where, was);
        text = text.slice(0, start) + replacement + text.slice(end);
      }
      await writeFile(file, text);
      continue;
    }

    const last = whole[whole.length - 1];
    if (last?.contents !== undefined) await writeFile(file, last.contents);
  }
}

export async function commit(dir: string, finding: Finding, subject: string): Promise<boolean> {
  await git(dir, 'add', '-A');
  const staged = await git(dir, 'diff', '--cached', '--name-only');
  if (staged.trim() === '') return false;
  await git(dir, '-c', 'user.name=pagebeam', '-c', 'user.email=pagebeam@users.noreply.github.com',
    'commit', '-q', '-m', messageFor(finding, subject));
  return true;
}

// A lease with nothing named is a lease against a remote-tracking ref, and a
// worktree made from the base has none, so the expectation is stated outright:
// replace the branch only if it is still exactly what was read a moment ago.
export async function push(dir: string, branch: string, force: boolean): Promise<void> {
  if (!force) {
    await git(dir, 'push', 'origin', `HEAD:${branch}`);
    return;
  }

  // Replacing a branch without knowing what is being replaced is the thing
  // a lease exists to prevent, so a lookup that failed stops the push.
  const expected = await git(dir, 'ls-remote', 'origin', `refs/heads/${branch}`).catch(
    (error: unknown) => {
      throw new Error(
        `what is on ${branch} could not be read, so it will not be replaced: ${(error as Error).message}`,
      );
    },
  );

  const sha = expected.split(/\s+/)[0] ?? '';
  await git(
    dir,
    'push',
    sha === '' ? '--force-with-lease' : `--force-with-lease=${branch}:${sha}`,
    'origin',
    `HEAD:${branch}`,
  );
}

// Ownership decided from a local ref is decided from whatever this clone last
// heard. Before anything is replaced, the remote is asked directly.
export class CannotAsk extends Error {
  constructor(readonly branch: string, readonly reason: string) {
    super(`whether ${branch} on the remote is ours could not be established: ${reason}`);
  }
}

// Absent means the branch is not on the remote, which is knowledge. An error
// is not knowledge, and is not treated as permission.
export async function remoteCommits(
  repo: string,
  branch: string,
  base: string,
): Promise<string[] | null> {
  const known = await git(repo, 'ls-remote', '--exit-code', '--heads', 'origin', branch).then(
    () => true,
    (error: unknown) => {
      const code = (error as { code?: number }).code;
      if (code === 2) return false;
      throw new CannotAsk(branch, (error as Error).message.split('\n')[0] ?? 'the remote refused');
    },
  );
  if (!known) return null;

  const fetched = await git(repo, 'fetch', '--quiet', 'origin', `${branch}:refs/pagebeam/remote`)
    .then(() => true)
    .catch((error: unknown) => {
      throw new CannotAsk(branch, (error as Error).message.split('\n')[0] ?? 'the fetch failed');
    });
  if (!fetched) return null;

  try {
    return (await git(repo, 'log', '--format=%B%x00', `${base}..refs/pagebeam/remote`))
      .split('\u0000')
      .map((m) => m.trim())
      .filter((m) => m !== '');
  } finally {
    await git(repo, 'update-ref', '-d', 'refs/pagebeam/remote').catch(() => undefined);
  }
}

export async function headOf(dir: string): Promise<string> {
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}
