import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BUFFER = 1 << 28;

export async function isRepository(root: string): Promise<boolean> {
  return run('git', ['-C', root, 'rev-parse', '--git-dir'])
    .then(() => true)
    .catch(() => false);
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

export async function readAt(root: string, rev: string, file: string): Promise<string | null> {
  return run('git', ['-C', root, 'show', `${rev}:${file}`], { maxBuffer: BUFFER })
    .then(({ stdout }) => stdout)
    .catch(() => null);
}

// A repository younger than the window still has a past. Falling back to its
// first commit is the difference between comparing and not comparing at all.
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
