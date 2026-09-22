import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BUFFER = 1 << 28;

export async function isRepository(root: string): Promise<boolean> {
  return run('git', ['-C', root, 'rev-parse', '--git-dir'])
    .then(() => true)
    .catch(() => false);
}

export async function repositoryRoot(root: string): Promise<string | null> {
  return run('git', ['-C', root, 'rev-parse', '--show-toplevel'])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
}

export async function head(root: string): Promise<string | null> {
  return run('git', ['-C', root, 'rev-parse', 'HEAD'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
}

export async function filesAt(root: string, rev: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', root, 'ls-tree', '-r', '--name-only', rev], {
    maxBuffer: BUFFER,
  });
  return stdout.split('\n').filter((f) => f !== '');
}

// ls-tree names files from the directory it runs in, but `show rev:path`
// resolves from the repository root unless the path is explicitly relative.
// Without the prefix every read from a nested directory returns nothing.
export class CannotRead extends Error {
  constructor(readonly file: string, readonly rev: string, readonly reason: string) {
    super(`${file} at ${rev} could not be read: ${reason}`);
  }
}

// A file that was not there at that revision is an answer. Anything else went
// wrong, and a reading with a hole in it is not the same as a smaller reading.
const ABSENT = /does not exist in|exists on disk, but not in|no such path/i;

export async function readAt(root: string, rev: string, file: string): Promise<string | null> {
  const relative = file.startsWith('./') || file.startsWith('../') ? file : `./${file}`;
  return run('git', ['-C', root, 'show', `${rev}:${relative}`], { maxBuffer: BUFFER })
    .then(({ stdout }) => stdout)
    .catch((error: unknown) => {
      const said = String((error as { stderr?: string }).stderr ?? (error as Error).message);
      if (ABSENT.test(said)) return null;
      throw new CannotRead(file, rev, said.split('\n')[0] ?? 'the read failed');
    });
}

// A repository younger than the window still has a past. Falling back to its
// first commit is the difference between comparing and not comparing at all.
export async function changedBetween(
  root: string,
  from: string,
  to = 'HEAD',
): Promise<string[]> {
  return run('git', ['-C', root, 'diff', '--name-only', from, to], { maxBuffer: BUFFER })
    .then(({ stdout }) => stdout.split('\n').filter((f) => f !== ''))
    .catch(() => []);
}

export async function revisionBefore(root: string, days: number): Promise<string | null> {
  const dated = await run('git', ['-C', root, 'rev-list', '-1', `--before=${days}.days.ago`, 'HEAD'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  if (dated !== '') return dated;

  const first = await run('git', ['-C', root, 'rev-list', '--max-parents=0', 'HEAD'])
    .then(({ stdout }) => stdout.trim().split('\n').at(-1) ?? '')
    .catch(() => '');
  if (first === '') return null;

  const head = await run('git', ['-C', root, 'rev-parse', 'HEAD'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  return first === head ? null : first;
}
