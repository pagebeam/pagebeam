import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { brokenLinks, loadConfig } from '../dist/index.js';

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [at, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, at)), { recursive: true });
    await writeFile(path.join(root, at), text);
  }
}

// The config lives in the product repository and the pages in a docs
// repository beside it, so the pages are reached through `..`.
async function layout(): Promise<{ product: string; elsewhere: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-broken-'));
  await put(root, {
    'product/pagebeam.config.yaml': 'docs:\n  root: ../docs/content\n',
    'docs/content/index.md': '# Home\n\nRead the [guide](/guide).\n',
    'docs/content/guide.md': '# Guide\n',
  });
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'pagebeam-proposed-'));
  return { product: path.join(root, 'product'), elsewhere };
}

test('pages are read through the config, even when they sit outside its folder', async () => {
  const { product } = await layout();
  const { config } = await loadConfig(product);
  assert.deepEqual(await brokenLinks(product, config), []);
});

test('a proposed copy of the pages is read from where it is, not from the config', async () => {
  const { product, elsewhere } = await layout();
  const { config } = await loadConfig(product);
  await put(elsewhere, {
    'index.md': '# Home\n\nRead the [guide](/guide) and the [missing page](/nowhere).\n',
    'guide.md': '# Guide\n',
  });
  const found = await brokenLinks(product, config, elsewhere);
  assert.deepEqual(
    found.map((f) => f.title),
    ['/nowhere does not resolve'],
  );
});
