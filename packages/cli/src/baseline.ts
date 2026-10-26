import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CaptureEnvironment } from '@pagebeam/core';

const exec = promisify(execFile);

export async function prepareBaseline(cwd: string, revision: string, configured: CaptureEnvironment, install?: string): Promise<{
  environment: CaptureEnvironment;
  dispose(): Promise<void>;
}> {
  if (!configured.frontend) throw new Error('--compare-base requires a configured frontend');
  const root = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
  const frontend = path.relative(root, path.resolve(cwd, configured.frontend.path));
  if (frontend === '..' || frontend.startsWith(`..${path.sep}`) || path.isAbsolute(frontend)) {
    throw new Error('the frontend must be inside the repository for --compare-base');
  }
  let commit: string;
  try {
    commit = (await exec('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { cwd })).stdout.trim();
  } catch { throw new Error('baseline revision could not be resolved'); }
  const directory = await mkdtemp(path.join(tmpdir(), 'pagebeam-baseline-'));
  const source = path.join(directory, 'source');
  const dispose = async (): Promise<void> => { await rm(directory, { recursive: true, force: true }); };
  try {
    await mkdir(source);
    const archive = path.join(directory, 'source.tar');
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: root });
    await exec('tar', ['-xf', archive, '-C', source]);
    if (install) {
      try {
        await exec('sh', ['-c', install], {
          cwd: source, env: { ...process.env, ...configured.env }, timeout: configured.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch { throw new Error('baseline installation failed; run the install command against the baseline revision'); }
    }
    return {
      environment: {
        ...configured,
        frontend: { ...configured.frontend, path: path.join(source, frontend) },
        frontendRevision: commit,
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
