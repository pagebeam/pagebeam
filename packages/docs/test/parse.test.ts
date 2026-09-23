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

test('astro structure is read, not guessed at from text', async () => {
  const parsed = await page(
    'a.astro',
    '---\nconst x = 1;\n---\n<a href="/guide">Read</a>\n<strong>Create a <em>report</em></strong>\n<pre><code>npm run dev</code></pre>\n',
  );
  assert.deepEqual(parsed!.links.map((l) => l.href), ['/guide']);
  assert.ok(parsed!.emphasised.some((e) => e.value === 'Create a report' && e.marker === 'strong'));
  assert.equal(parsed!.codeBlocks.length, 1);
  assert.ok(!parsed!.prose.includes('const x = 1'), 'frontmatter is not prose');
});

test('an astro component attribute can carry a link', async () => {
  const parsed = await page('a.astro', '<Figure src="/shots/a.png" caption="The Save button" />\n');
  assert.deepEqual(parsed!.links.map((l) => l.href), ['/shots/a.png']);
  assert.ok(parsed!.emphasised.some((e) => e.value === 'The Save button'));
});

test('a component showing an address as text is not a link', async () => {
  const parsed = await page('a.astro', '<Browser url="app.example.com/systems" />\n');
  assert.deepEqual(parsed!.links, [], 'no scheme and no slash, so it is being displayed');
});

test('a component genuinely linking somewhere still is one', async () => {
  const parsed = await page('a.astro', '<Link to="/real">Go</Link>\n');
  assert.deepEqual(parsed!.links.map((l) => l.href), ['/real']);
});

test('script and style contents are not prose', async () => {
  const parsed = await page('a.astro', '<script>const secret = "hello";</script><p>Visible.</p>\n');
  assert.ok(!parsed!.prose.includes('secret'));
  assert.match(parsed!.prose, /Visible/);
});

test('text inside a hidden element is not text the page shows', async () => {
  const md = await page('a.md', '# A\n\n<div hidden>GET /private</div>\n\n<p style="display: none">DELETE /admin</p>\n');
  assert.doesNotMatch(md!.prose, /private|admin/);
  const mdx = await page('b.mdx', '# B\n\n<div aria-hidden="true">GET /private</div>\n\n<Endpoint hidden method="GET" path="/admin" />\n');
  assert.doesNotMatch(mdx!.prose, /private/);
  assert.deepEqual(mdx!.operations, []);
  const astro = await page('c.astro', '<div hidden><p>GET /private</p></div><p>GET /public</p>');
  assert.doesNotMatch(astro!.prose, /private/);
  assert.match(astro!.prose, /public/);
});
