#!/usr/bin/env node
import { runWorker } from './loop.js';

const signal = new AbortController();
process.once('SIGTERM', () => signal.abort());
process.once('SIGINT', () => signal.abort());
const apiUrl = process.env.PAGEBEAM_API_URL;
const token = process.env.PAGEBEAM_WORKER_TOKEN;
if (!apiUrl || !token) {
  console.error('PAGEBEAM_API_URL and PAGEBEAM_WORKER_TOKEN are required');
  process.exitCode = 1;
} else {
  await runWorker({ apiUrl, token, capacity: Number(process.env.PAGEBEAM_WORKER_CAPACITY ?? 2), signal: signal.signal }).catch(() => {
    console.error('Worker stopped after a configuration or browser failure'); process.exitCode = 1;
  });
}
