import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parsePage } from '../dist/index.js';

async function page(name: string, body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-docs-'));
  await writeFile(path.join(dir, name), body);
  return parsePage(dir, name);
}

test('an mdx import is not prose', async () => {
  const parsed = await page('a.mdx', "import Box from './Box';\n\nReal words here.\n");
  assert.ok(!parsed!.prose.includes('import Box'), 'the import statement is code, not text');
  assert.match(parsed!.prose, /Real words here/);
});

test('an mdx expression is not prose', async () => {
  const parsed = await page('a.mdx', 'Value is {1 + 1} today.\n');
  assert.ok(!parsed!.prose.includes('1 + 1'));
});

test('the same file as markdown keeps the import as text', async () => {
  const parsed = await page('a.md', "import Box from './Box';\n\nReal words here.\n");
  assert.match(parsed!.prose, /import Box/, 'markdown has no imports, so it is a paragraph');
});

test('frontmatter is not prose in either', async () => {
  for (const name of ['a.md', 'a.mdx']) {
    const parsed = await page(name, '---\ntitle: T\nslug: /s\n---\n\nBody.\n');
    assert.ok(!parsed!.prose.includes('title: T'), name);
    assert.equal(parsed!.slug, '/s', name);
  }
});

test('a link written as a component attribute is a link', async () => {
  const parsed = await page('a.mdx', '<Link to="/broken">Read it</Link>\n');
  assert.deepEqual(parsed!.links.map((l) => l.href), ['/broken']);
});

test('an image written as a component is checked like any other', async () => {
  const parsed = await page('a.mdx', '<img src="/missing.png" alt="A screenshot" />\n');
  assert.deepEqual(parsed!.links.map((l) => l.href), ['/missing.png']);
  assert.ok(parsed!.emphasised.some((e) => e.value === 'A screenshot'));
});

test('a control named in a component title is a control', async () => {
  const parsed = await page('a.mdx', '<Admonition title="Click Save first">Body.</Admonition>\n');
  assert.ok(parsed!.emphasised.some((e) => e.value === 'Click Save first'));
});

test('content nested inside components is still read', async () => {
  const parsed = await page(
    'a.mdx',
    '<Tabs>\n  <TabItem value="npm">\n    Press **Install now** and read [the guide](/guide).\n  </TabItem>\n</Tabs>\n',
  );
  assert.ok(parsed!.links.some((l) => l.href === '/guide'));
  assert.ok(parsed!.emphasised.some((e) => e.value === 'Install now'));
});

test('the same attributes in plain markdown are not components', async () => {
  const parsed = await page('a.md', '<Link to="/broken">Read it</Link>\n');
  assert.deepEqual(parsed!.links.map((l) => l.href), [], 'markdown has no components to read');
});
