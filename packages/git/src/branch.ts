import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileChange, Finding } from '@pagebeam/core';
import { messageFor } from './trailers.js';

const run = promisify(execFile);
const BUFFER = 1 << 28;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: BUFFER });
  return stdout;
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
export async function open(repo: string, branch: string, base: string, fresh: boolean): Promise<Session> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-branch-'));
  const at = path.join(dir, 'tree');

  if (fresh || !(await exists(repo, branch))) {
    await git(repo, 'worktree', 'add', '--detach', at, base);
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

export async function apply(dir: string, changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    const file = await reallyWithin(dir, change.path);
    if (change.mode === 'delete') {
      await rm(file, { force: true });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });

    if (change.splice !== undefined) {
      const before = await readFile(file, 'utf8');
      const { start, end, text } = change.splice;
      await writeFile(file, before.slice(0, start) + text + before.slice(end));
      continue;
    }
    if (change.contents !== undefined) await writeFile(file, change.contents);
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

export async function push(dir: string, branch: string, force: boolean): Promise<void> {
  await git(dir, 'push', ...(force ? ['--force-with-lease'] : []), 'origin', `HEAD:${branch}`);
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
