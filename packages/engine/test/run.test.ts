import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../dist/run.js';
import { pretty } from '../dist/report.js';

async function site(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-'));
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

test('a site with no documentation is a problem, not a pass', async () => {
  const result = await run(await site({ 'pagebeam.config.yaml': 'docs:\n  root: docs\n' }));
  assert.notEqual(result.problem, null);
  assert.equal(result.pages, 0);
  assert.match(pretty(result), /Nothing was checked/);
});

test('a broken internal link is found through the whole path', async () => {
  const root = await site({
    'pagebeam.config.yaml': 'docs:\n  root: docs\n',
    'docs/index.md': '# Home\n\n[gone](/nowhere)\n',
  });
  const result = await run(root);
  assert.equal(result.problem, null);
  assert.equal(result.pages, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.check, 'links');
});

test('a relative link to a missing neighbour is found', async () => {
  const result = await run(
    await site({
      'pagebeam.config.yaml': 'docs:\n  root: docs\n',
      'docs/a.md': '[b](./b.md)\n',
    }),
  );
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0]!.detail, /not a file beside it/);
});

test('a relative link to a real neighbour is silent', async () => {
  const result = await run(
    await site({
      'pagebeam.config.yaml': 'docs:\n  root: docs\n',
      'docs/a.md': '[b](./b.md)\n',
      'docs/b.md': '# B\n',
    }),
  );
  assert.deepEqual(result.findings, []);
});

test('a nested documentation root does not make every link broken', async () => {
  const result = await run(
    await site({
      'pagebeam.config.yaml': "docs:\n  root: .\n  include: ['src/pages/**/*.md']\n",
      'src/pages/index.md': '[guide](/guide)\n',
      'src/pages/guide.md': '# Guide\n',
    }),
  );
  assert.deepEqual(result.findings, [], 'src/pages is the site root, not a path segment');
});

test('a documented key missing from every application is reported', async () => {
  const result = await run(
    await site({
      'pagebeam.config.yaml':
        'docs:\n  root: docs\napps:\n  - name: api\n    path: api\n    envFiles: [".env.example"]\n',
      'docs/config.md': '```ini\nAPP_KEY=x\nGONE_KEY=y\n```\n',
      'api/.env.example': 'APP_KEY=real\n',
    }),
  );
  const keys = result.findings.filter((f) => f.check === 'config-keys');
  assert.equal(keys.length, 1);
  assert.match(keys[0]!.title, /GONE_KEY/);
});

test('checks that cannot run are named rather than counted as passing', async () => {
  const result = await run(
    await site({ 'pagebeam.config.yaml': 'docs:\n  root: docs\n', 'docs/i.md': '# I\n' }),
  );
  assert.ok(result.skipped.length > 0);
  assert.match(pretty(result), /not a clean bill of health/);
});
