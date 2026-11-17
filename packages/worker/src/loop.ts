import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureWorker } from './capture.js';
import { ForwardProxy } from './proxy.js';
import { CaptureFailure, type Job } from './types.js';

export interface WorkerOptions { apiUrl: string; token: string; capacity?: number; signal?: AbortSignal }

export async function runWorker(options: WorkerOptions): Promise<void> {
  const proxy = await ForwardProxy.start();
  try { await workerLoop(options, new CaptureWorker(proxy)); } finally { await proxy.close(); }
}

export async function workerLoop(options: WorkerOptions, worker: CaptureWorker): Promise<void> {
  const capacity = options.capacity ?? 2;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) throw new Error('Capacity must be 1..16');
  const api = new URL(options.apiUrl);
  const running = new Set<Promise<void>>();
  const post = async (path: string, body: unknown, timeout = 20_000): Promise<Response> => {
    const response = await fetch(new URL(path, api), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('Worker API request failed');
    return response;
  };
  const execute = async (job: Job): Promise<void> => {
    const deadline = Date.now() + 45_000;
    try {
      const result = await worker.capture(job);
      const images = [];
      for (const image of result.images) {
        if (image.bytes.length > 25 * 1024 * 1024) throw new CaptureFailure('navigation_failed');
        const upload = job.uploads[image.viewport];
        if (!upload) throw new CaptureFailure('navigation_failed');
        const headers = new Headers(upload.headers);
        if (new URL(upload.url).origin !== api.origin) headers.delete('authorization');
        if (Date.now() >= deadline) throw new CaptureFailure('timeout');
        const response = await fetch(upload.url, { method: 'PUT', headers, body: new Uint8Array(image.bytes), redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))) });
        if (!response.ok) throw new CaptureFailure('navigation_failed');
        images.push({ ...image, bytes: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex') });
      }
      if (Date.now() >= deadline) throw new CaptureFailure('timeout');
      await post(`/v1/worker/jobs/${encodeURIComponent(job.id)}/complete`, { takenAt: result.takenAt, images }, Math.max(1, deadline - Date.now()));
    } catch (error) {
      const reason = error instanceof CaptureFailure ? error.reason : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'navigation_failed';
      await post(`/v1/worker/jobs/${encodeURIComponent(job.id)}/fail`, { reason, message: reason });
    }
  };
  try {
    while (!options.signal?.aborted) {
      if (running.size >= capacity) { await Promise.race(running); continue; }
      try {
        const response = await post('/v1/worker/claim', { worker: hostname(), capacity: capacity - running.size });
        if (response.status === 204) {
          await delay(1000, undefined, { ...(options.signal ? { signal: options.signal } : {}) }).catch(() => {});
          continue;
        }
        const { jobs } = await response.json() as { jobs: Job[] };
        if (jobs.length > capacity - running.size) throw new Error('Claim exceeded capacity');
        for (const job of jobs) {
          const task = execute(job).catch(() => {}).finally(() => running.delete(task));
          running.add(task);
        }
        if (!jobs.length) await delay(1000, undefined, { ...(options.signal ? { signal: options.signal } : {}) }).catch(() => {});
      } catch {
        await delay(1000, undefined, { ...(options.signal ? { signal: options.signal } : {}) }).catch(() => {});
      }
    }
  } finally { await Promise.all(running); await worker.close(); }
}
