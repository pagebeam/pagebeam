import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { OutcomePublisher } from './outcome.js';

export interface CloudOptions {
  token: string;
  apiUrl?: string | undefined;
  repository: string;
  pullRequest?: number;
  branch?: string;
  headSha?: string | null;
  baseSha?: string | null;
  idempotencyKey: string;
  fetch?: typeof globalThis.fetch;
}

export function cloud(options: CloudOptions): OutcomePublisher {
  return { async publish(outcome, context) {
    const redact = (error: unknown): string => String(error instanceof Error ? error.message : error).split(options.token).join('<REDACTED>');
    try {
      const api = new URL(options.apiUrl ?? 'https://api.pagebeam.dev');
      const request = options.fetch ?? globalThis.fetch;
      const root = await realpath(context.directory);
      const files = new Map<string, { bytes: Buffer; media_type: string; size: number; sha256: string }>();
      for (const evidence of outcome.evidence) {
        if (!evidence.mediaType.startsWith('image/') && evidence.mediaType !== 'application/json') continue;
        const name = evidence.file;
        if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('evidence is outside the outcome directory');
        const target = await realpath(path.resolve(root, name));
        const relative = path.relative(root, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('evidence is outside the outcome directory');
        const bytes = await readFile(target);
        files.set(name, { bytes, media_type: evidence.mediaType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const checked = async (response: Response): Promise<Response> => {
        if (!response.ok) {
          const body = await response.text();
          let message = body;
          try { message = JSON.parse(body).message ?? body; } catch {}
          throw new Error(`Cloud upload failed (${response.status}): ${message}`);
        }
        return response;
      };
      const post = async (pathname: string, body?: unknown, headers?: Record<string, string>) => {
        const response = await checked(await request(new URL(pathname, api), { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        return (await response.json()).data;
      };
      const run = await post('/v1/runs', {
        kind: 'review', repository: options.repository, pull_request: options.pullRequest, branch: options.branch,
        head_sha: options.headSha, base_sha: options.baseSha ?? null, outcome,
        files: [...files].map(([name, { bytes: _bytes, ...file }]) => ({ path: name, ...file })),
      }, { 'Idempotency-Key': options.idempotencyKey });
      const uploads = run.uploads as { path: string; url: string; headers: Record<string, string> }[];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, uploads.length) }, async () => {
        while (next < uploads.length) {
          const upload = uploads[next++]!;
          const file = files.get(upload.path);
          if (!file) throw new Error('Server requested undeclared evidence');
          const url = new URL(upload.url);
          const headers = new Headers(upload.headers);
          headers.delete('Authorization');
          if (url.origin === api.origin) headers.set('Authorization', `Bearer ${options.token}`);
          for (let attempt = 0; ; attempt++) {
            let response: Response;
            try { response = await request(url, { method: 'PUT', redirect: 'error', headers, body: new Uint8Array(file.bytes) }); }
            catch (error) { if (attempt === 3) throw error; await setTimeout(100 * 2 ** attempt); continue; }
            if (response.status >= 500 && attempt < 3) { await response.arrayBuffer(); await setTimeout(100 * 2 ** attempt); continue; }
            await checked(response);
            break;
          }
        }
      }));
      const complete = await post(`/v1/runs/${encodeURIComponent(run.id)}/complete`);
      const review = new URL(String(complete.review_url));
      if (!/^https?:$/.test(review.protocol) || /\s/.test(String(complete.review_url))) throw new Error('Cloud returned an invalid review URL');
      return { url: review.href, urls: {} };
    } catch (error) { throw new Error(redact(error)); }
  } };
}
