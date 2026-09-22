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
  } else {
    await git(repo, 'worktree', 'add', at, branch);
  }

  return {
    dir: at,
    end: async () => {
      await git(repo, 'worktree', 'remove', '--force', at).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function apply(dir: string, changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    const file = path.join(dir, change.path);
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

export async function headOf(dir: string): Promise<string> {
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}
