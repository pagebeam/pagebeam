import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CaptureEnvironment } from '@pagebeam/core';
import { history } from '@pagebeam/app';
import { parse as parseYaml } from 'yaml';

export class StageFailure extends Error {
  constructor(readonly stage: string, message: string) { super(message); }
}

export interface ManagedEnvironment {
  env: NodeJS.ProcessEnv;
  metadata: { kind: string; revision: string | null; fixtureVersion: string | null; mocked: boolean };
  start(): Promise<void>;
  close(): Promise<void>;
}

export function environment(
  config: CaptureEnvironment, cwd: string, runId: string, out: string, signal: AbortSignal,
): ManagedEnvironment {
  const children: ChildProcess[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env, PAGEBEAM_RUN_ID: runId, PAGEBEAM_RUN_DIR: out };
  if (config.fixtures?.path) env.PAGEBEAM_FIXTURES = path.resolve(cwd, config.fixtures.path);
  const backend = config.backend;
  const root = 'path' in backend ? path.resolve(cwd, backend.path) : cwd;
  let compose: string[] | undefined;
  let prepared = false;
  let ownedCompose = false;
  const metadata = {
    kind: backend.kind,
    revision: backend.kind === 'url' ? backend.revision : backend.kind === 'image' ? backend.image : null as string | null,
    fixtureVersion: config.fixtures?.version ?? (backend.kind === 'mock' ? backend.version : null),
    mocked: backend.kind === 'mock',
  };

  async function command(executable: string, args: string[], at: string, stage: string, cleanup = false): Promise<void> {
    if (!cleanup) signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: at, env, stdio: 'ignore', detached: process.platform !== 'win32' });
      let hard: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => { terminate(child); hard ??= setTimeout(() => terminate(child, 'SIGKILL'), 2000); };
      const timer = setTimeout(stop, config.timeoutMs);
      if (!cleanup) signal.addEventListener('abort', stop, { once: true });
      if (!cleanup && signal.aborted) stop();
      child.once('error', () => { clearTimeout(timer); clearTimeout(hard); signal.removeEventListener('abort', stop); reject(new StageFailure(stage, `${stage} command could not start`)); });
      child.once('exit', code => {
        clearTimeout(timer);
        clearTimeout(hard);
        signal.removeEventListener('abort', stop);
        if (code === 0) resolve();
        else reject(new StageFailure(stage, `${stage} command failed (${code ?? 'terminated'})`));
      });
    });
  }

  function terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {}
  }

  function serve(start: string, at: string): ChildProcess {
    const child = spawn('sh', ['-c', start], { cwd: at, env, stdio: 'ignore', detached: process.platform !== 'win32' });
    child.on('error', () => undefined);
    children.push(child);
    return child;
  }

  async function ready(url: string, child?: ChildProcess): Promise<void> {
    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (child && (child.exitCode !== null || child.pid === undefined)) throw new StageFailure('readiness', 'service exited before readiness');
      const ok = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })
        .then(async response => { await response.body?.cancel(); return response.ok; }).catch(() => false);
      if (ok) return;
      await delay(250, undefined, { signal });
    }
    throw new StageFailure('readiness', 'service did not become ready before its timeout');
  }

  async function startService(start: string, at: string, url: string): Promise<void> {
    const occupied = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })
      .then(async response => { await response.body?.cancel(); return true; }).catch(() => false);
    signal.throwIfAborted();
    if (occupied) throw new StageFailure('startup', 'service address is already in use; configure an existing URL or choose a separate address');
    await ready(url, serve(start, at));
  }

  return {
    env,
    metadata,
    async start() {
      for (const name of config.requiredEnv) if (!env[name as keyof typeof env]) throw new StageFailure('environment', `required variable ${name} is not set`);
      if (backend.kind === 'url') await ready(backend.url);
      else if (backend.kind === 'image') {
        const project = `pagebeam-${runId}`.toLowerCase();
        const override = path.join(out, 'compose.override.json');
        const source = path.resolve(root, backend.compose);
        const raw = await readFile(source, 'utf8');
        const definition: unknown = parseYaml(raw);
        const check = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (['include', 'extends', 'container_name', 'volumes_from', 'devices', 'driver_opts'].includes(key) || (key === 'external' && item !== false) || (key === 'name' && item !== undefined) || (key === 'network_mode' && item === 'host')) {
              throw new StageFailure('environment', 'capture Compose must use job-owned resources without fixed names or external references');
            }
            if (key === 'type' && item === 'bind') throw new StageFailure('environment', 'capture Compose must not mount host directories');
            if (key === 'volumes' && Array.isArray(item) && item.some(entry => typeof entry === 'string' && /^([.$/~]|[A-Za-z]:)/.test(entry))) {
              throw new StageFailure('environment', 'capture Compose must not mount host directories');
            }
            check(item);
          }
        };
        check(definition);
        await writeFile(override, JSON.stringify({ services: { [backend.service]: { image: backend.image } } }));
        compose = ['compose', '--project-name', project, '--project-directory', root, '-f', source, '-f', override];
        ownedCompose = true;
        await command('docker', [...compose, 'up', '-d', '--no-build'], root, 'startup');
        await ready(backend.ready);
      } else {
        if (backend.kind === 'mock') {
          await stat(path.resolve(cwd, backend.fixtures));
          env.PAGEBEAM_FIXTURES = path.resolve(cwd, backend.fixtures);
          await command('sh', ['-c', backend.validate], root, 'fixtures');
        }
        else metadata.revision = backend.revision ?? (await history.head(root) || null);
        await startService(backend.start, root, backend.ready);
      }
      if (config.frontend) await startService(config.frontend.start, path.resolve(cwd, config.frontend.path), config.frontend.ready);
      prepared = true;
      if (config.fixtures?.path) env.PAGEBEAM_FIXTURES = path.resolve(cwd, config.fixtures.path);
      if (config.fixtures?.restore) await command('sh', ['-c', config.fixtures.restore], cwd, 'fixtures');
      for (const script of config.prepare) await command('sh', ['-c', script], cwd, 'preparation');
    },
    async close() {
      const failures: unknown[] = [];
      if (prepared) for (const script of config.cleanup) {
        try { await command('sh', ['-c', script], cwd, 'cleanup', true); } catch (error) { failures.push(error); }
      }
      for (const child of children.reverse()) {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { terminate(child, 'SIGKILL'); }, 2000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          terminate(child);
        });
      }
      if (ownedCompose && compose) {
        try { await command('docker', [...compose, 'down', '--volumes', '--remove-orphans'], root, 'cleanup', true); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new StageFailure('cleanup', 'one or more cleanup operations failed');
    },
  };
}
