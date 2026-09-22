import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configFor, discover } from '../dist/discover.js';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-find-'));
  for (const [at, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, at)), { recursive: true });
    await writeFile(path.join(root, at), text);
  }
  return root;
}

const PAGE = '<template><button>Go</button></template>';

// Nothing here knows the name of a framework. A directory of prose is
// documentation and a directory of routes is an application, whatever built
// either of them.
test('prose in a directory is the documentation, wherever it sits', async () => {
  const found = await discover(await repo({ 'site/guide.md': '# Guide', 'site/api.md': '# API' }));
  assert.equal(found.docs?.root, 'site');
  assert.equal(found.docs?.pages, 2);
});

test('a directory named for the job wins over a bigger one', async () => {
  const found = await discover(
    await repo({ 'docs/a.md': 'a', 'notes/b.md': 'b', 'notes/c.md': 'c', 'notes/d.md': 'd' }),
  );
  assert.equal(found.docs?.root, 'docs');
});

test('an application is where its routes can be reached from', async () => {
  const found = await discover(await repo({ 'pages/a.vue': PAGE, 'components/B.vue': PAGE }));
  assert.equal(found.apps[0]?.path, '.', 'the components sit beside the routes, not inside them');
});

test('routes under a source directory make that the application', async () => {
  const found = await discover(await repo({ 'src/routes/a.svelte': PAGE, 'src/lib/B.svelte': PAGE }));
  assert.equal(found.apps[0]?.path, 'src');
});

test("an application's own routes are never called its documentation", async () => {
  const found = await discover(await repo({ 'pages/a.tsx': PAGE, 'pages/b.tsx': PAGE }));
  assert.equal(found.docs, null, 'saying nothing beats calling a product its own manual');
  assert.equal(found.apps.length, 1);
});

test('what is already the documentation is not also an application', async () => {
  const found = await discover(
    await repo({ 'docs/pages/a.astro': PAGE, 'docs/pages/b.astro': PAGE, 'docs/guide.md': '# g' }),
  );
  assert.equal(found.docs?.root, 'docs');
  assert.deepEqual(found.apps, []);
});

test('a few files at the top of a repository are notes, not a site', async () => {
  const found = await discover(await repo({ 'README.md': 'r', 'STRATEGY.md': 's' }));
  assert.equal(found.docs, null);
});

test('what it would write says what it could not work out', async () => {
  const found = await discover(await repo({ 'docs/a.md': 'a' }));
  const written = configFor(found);
  assert.match(written, /root: docs/);
  assert.match(written, /apps: \[\]/);
  assert.match(written, /Without at least one/);
});
