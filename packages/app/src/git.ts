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

export async function revisionBefore(root: string, days: number): Promise<string | null> {
  return run('git', ['-C', root, 'rev-list', '-1', `--before=${days}.days.ago`, 'HEAD'])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
}
