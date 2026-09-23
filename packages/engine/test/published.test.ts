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

// The question is what a reader is served, so nothing here knows or asks what
// produced the page. A reference written by hand and one generated from the
// specification are the same answer to a reader and the same answer here.
test('an operation a page serves is found, whatever wrote the page', async () => {
  const root = await site({
    'reference/operations/8415e940/index.html': '<h1>Create wallet</h1><code>/api/v1/wallets</code>',
  });
  assert.deepEqual([...(await publishedPaths(root, ['/api/v1/wallets'])).found], ['/api/v1/wallets']);
});

test('an operation nothing serves is not found', async () => {
  const root = await site({ 'index.html': '<h1>Welcome</h1>' });
  assert.equal((await publishedPaths(root, ['/api/v1/wallets'])).found.size, 0);
});

test('a page that escapes the address it shows still serves it', async () => {
  const root = await site({ 'a.html': '<code>&#x2F;api&#x2F;v1&#x2F;wallets</code>' });
  assert.equal((await publishedPaths(root, ['/api/v1/wallets'])).found.size, 1);
});

test('pages are found however deep the site nests them', async () => {
  const root = await site({ 'a/b/c/d/e/index.html': '<p>/api/v1/deep</p>' });
  assert.equal((await publishedPaths(root, ['/api/v1/deep'])).found.size, 1);
});

test('what is not a page is not read', async () => {
  const root = await site({ 'spec.json': '{"paths":{"/api/v1/wallets":{}}}' });
  assert.equal((await publishedPaths(root, ['/api/v1/wallets'])).found.size, 0, 'the specification is not the documentation');
});

test('some served and some not is answered exactly', async () => {
  const root = await site({ 'a.html': '/api/v1/one', 'b.html': '/api/v1/two' });
  const { found } = await publishedPaths(root, ['/api/v1/one', '/api/v1/two', '/api/v1/three']);
  assert.deepEqual([...found].sort(), ['/api/v1/one', '/api/v1/two']);
});

test('a site larger than the scan reads is reported as incomplete', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i <= PAGE_LIMIT; i++) files[`p${i}.html`] = '<p>nothing here</p>';
  const root = await site(files);
  const result = await publishedPaths(root, ['/api/v1/wallets']);
  assert.equal(result.complete, false);
});

test('a page that cannot be read is an error, not a page that says nothing', async () => {
  const root = await site({ 'locked/index.html': '/api/v1/wallets' });
  await chmod(path.join(root, 'locked'), 0o000);
  try {
    await assert.rejects(publishedPaths(root, ['/api/v1/wallets']), { code: 'EACCES' });
  } finally {
    await chmod(path.join(root, 'locked'), 0o755);
  }
});
