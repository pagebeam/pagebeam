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

// Documentation in one repository and the product in another is the case this
// was built for, and from inside the documentation the product is not below,
// it is beside.
async function checkout(layout: Record<string, Record<string, string>>): Promise<string> {
  const above = await mkdtemp(path.join(tmpdir(), 'pagebeam-beside-'));
  for (const [repo, files] of Object.entries(layout)) {
    // What makes a directory a checkout rather than a neighbour that happens
    // to share a parent.
    await mkdir(path.join(above, repo), { recursive: true });
    await writeFile(path.join(above, repo, 'package.json'), '{}');
    for (const [at, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(above, repo, at)), { recursive: true });
      await writeFile(path.join(above, repo, at), text);
    }
  }
  return above;
}

test('the product checked out beside the documentation is found', async () => {
  const above = await checkout({
    docs: { 'content/guide.md': '# Guide' },
    dashboard: { 'pages/billing.vue': PAGE, 'pages/reports.vue': PAGE },
  });
  const found = await discover(path.join(above, 'docs'));
  assert.equal(found.docs?.root, 'content');
  assert.equal(found.apps[0]?.path, '../dashboard');
  assert.equal(found.apps[0]?.name, 'dashboard');
  assert.equal(found.apps[0]?.routes, 2);
});

test('a repository holding its own product is not asked about its neighbours', async () => {
  const above = await checkout({
    app: { 'docs/guide.md': '# Guide', 'pages/a.vue': PAGE },
    other: { 'pages/b.vue': PAGE },
  });
  const found = await discover(path.join(above, 'app'));
  assert.deepEqual(found.apps.map((a) => a.path), ['.'], 'it has already said what it describes');
});

test('a neighbour with no routes is not an application', async () => {
  const above = await checkout({
    docs: { 'content/guide.md': '# Guide' },
    assets: { 'src/logo.svg': '<svg />', 'src/theme.ts': 'export const a = 1' },
  });
  const found = await discover(path.join(above, 'docs'));
  assert.deepEqual(found.apps, []);
});

test('several neighbours are offered, the one with most routes first', async () => {
  const above = await checkout({
    docs: { 'content/guide.md': '# Guide' },
    small: { 'pages/a.vue': PAGE },
    big: { 'pages/a.vue': PAGE, 'pages/b.vue': PAGE, 'pages/c.vue': PAGE },
  });
  const found = await discover(path.join(above, 'docs'));
  assert.deepEqual(found.apps.map((a) => a.name), ['big', 'small']);
});

test('a hundred neighbours is not a list anybody reads', async () => {
  const many: Record<string, Record<string, string>> = { docs: { 'content/g.md': '# G' } };
  for (let i = 0; i < 20; i += 1) many[`app${i}`] = { [`pages/a${i}.vue`]: PAGE };
  const found = await discover(path.join(await checkout(many), 'docs'));
  assert.ok(found.apps.length <= 8, `offered ${found.apps.length}`);
});

// Documentation and the product in one repository, in different parts of it.
test('a monorepo is read from its root', async () => {
  const root = await repo({
    'docs/guide.md': '# Guide',
    'apps/web/pages/index.vue': PAGE,
    'apps/web/pages/about.vue': PAGE,
    'apps/admin/pages/home.vue': PAGE,
    'packages/ui/src/Button.vue': PAGE,
  });
  const found = await discover(root);
  assert.equal(found.docs?.root, 'docs');
  assert.deepEqual(found.apps.map((a) => a.path), ['apps/web', 'apps/admin']);
  assert.ok(!found.apps.some((a) => a.path.startsWith('packages/')), 'a library has no screens');
});
