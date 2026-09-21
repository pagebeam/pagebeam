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
