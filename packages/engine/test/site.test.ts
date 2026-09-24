import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { siteOf } from '../dist/site.js';

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-site-'));
  await mkdir(path.join(root, '.git'));
  for (const [at, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, at)), { recursive: true });
    await writeFile(path.join(root, at), text);
  }
  return root;
}

const deps = (d: Record<string, string>, scripts: Record<string, string> = {}) => JSON.stringify({ scripts, dependencies: d });

test('a docs site is recognised by what its framework leaves behind', async () => {
  const cases = [
    { files: { 'package.json': deps({ astro: '6', '@astrojs/starlight': '0.40' }) }, name: 'Astro', output: 'dist', content: 'src/content/docs' },
    { files: { 'package.json': deps({ '@docusaurus/core': '3' }) }, name: 'Docusaurus (v2+)', output: 'build', content: null },
    { files: { 'package.json': deps({ vitepress: '1' }) }, name: 'VitePress', output: 'docs/.vitepress/dist', content: null },
    { files: { 'config.toml': 'baseURL = "https://example.org/"\n' }, name: 'Hugo', output: 'public', content: null },
  ];
  for (const c of cases) {
    const root = await project(c.files);
    const site = await siteOf(root);
    assert.equal(site?.framework?.name, c.name);
    assert.equal(site?.output, c.output, c.name);
    assert.equal(site?.content ?? null, c.content === null ? null : path.join(root, c.content));
  }
});

test('the project build script is preferred to the framework command, with its own package manager', async () => {
  const root = await project({ 'package.json': deps({ vitepress: '1' }, { build: 'vitepress build' }), 'pnpm-lock.yaml': '' });
  const site = await siteOf(root);
  assert.equal(site?.build, 'pnpm run build');
  assert.equal(site?.install, 'pnpm install --frozen-lockfile');
});

test('the site is found above the pages, and not beyond their repository', async () => {
  const root = await project({ 'package.json': deps({ astro: '6', '@astrojs/starlight': '0.40' }), 'src/content/docs/a.md': '# A' });
  assert.equal((await siteOf(path.join(root, 'src/content/docs')))?.dir, root);
  const bare = await project({ 'docs/a.md': '# A' });
  assert.equal(await siteOf(path.join(bare, 'docs')), null);
});
