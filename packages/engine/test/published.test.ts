import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PAGE_LIMIT, publishedPaths } from '../dist/published.js';

async function site(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-built-'));
  for (const [at, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, at)), { recursive: true });
    await writeFile(path.join(root, at), text);
  }
  return root;
}

const op = (method: string, p: string) => ({ method, path: p });

test('an operation shown with its method is found, whatever wrote the page', async () => {
  const root = await site({
    'reference/operations/8415e940/index.html': '<h1>Create wallet</h1><span>POST</span> <code>/api/v1/wallets</code>',
  });
  assert.deepEqual([...(await publishedPaths(root, [op('post', '/api/v1/wallets')])).found], ['POST /api/v1/wallets']);
});

test('a path shown with one method does not cover another method on it', async () => {
  const root = await site({ 'users.html': '<p>GET /users lists everyone.</p>' });
  const { found } = await publishedPaths(root, [op('get', '/users'), op('delete', '/users')]);
  assert.deepEqual([...found], ['GET /users']);
});

test('text a reader cannot see does not count', async () => {
  const root = await site({
    'a.html':
      '<script>const spec = {"paths": {"/users": {"get": {}}}}; // GET /users</script>' +
      '<div hidden>GET /users</div><div aria-hidden="true">GET /users</div>' +
      '<a href="/users" title="GET /users">Home</a>',
  });
  assert.equal((await publishedPaths(root, [op('get', '/users')])).found.size, 0);
});

test('a longer path does not stand for a shorter one', async () => {
  const root = await site({ 'a.html': '<p>GET /users/{id}</p>' });
  assert.equal((await publishedPaths(root, [op('get', '/users')])).found.size, 0);
});

test('a page that escapes the address it shows still serves it', async () => {
  const root = await site({ 'a.html': '<p>GET <code>&#x2F;api&#x2F;v1&#x2F;wallets</code></p>' });
  assert.equal((await publishedPaths(root, [op('get', '/api/v1/wallets')])).found.size, 1);
});

test('pages are found however deep the site nests them', async () => {
  const root = await site({ 'a/b/c/d/e/index.html': '<p>GET /api/v1/deep</p>' });
  assert.equal((await publishedPaths(root, [op('get', '/api/v1/deep')])).found.size, 1);
});

test('what is not a page is not read', async () => {
  const root = await site({ 'spec.json': '{"paths":{"/api/v1/wallets":{"get":{}}}}' });
  assert.equal((await publishedPaths(root, [op('get', '/api/v1/wallets')])).found.size, 0);
});

test('a site larger than the scan reads is reported as incomplete', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i <= PAGE_LIMIT; i++) files[`p${i}.html`] = '<p>nothing here</p>';
  const root = await site(files);
  assert.equal((await publishedPaths(root, [op('get', '/api/v1/wallets')])).complete, false);
});

test('a page that cannot be read is an error, not a page that says nothing', async () => {
  const root = await site({ 'locked/index.html': '<p>GET /api/v1/wallets</p>' });
  await chmod(path.join(root, 'locked'), 0o000);
  try {
    await assert.rejects(publishedPaths(root, [op('get', '/api/v1/wallets')]), { code: 'EACCES' });
  } finally {
    await chmod(path.join(root, 'locked'), 0o755);
  }
});
