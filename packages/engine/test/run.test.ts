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

test('a check that was asked for and could not run makes the answer untrustworthy', async () => {
  const result = await run(
    await site({
      'pagebeam.config.yaml': 'docs:\n  root: docs\nchecks:\n  openapi: {}\n',
      'docs/a.md': '# A\n',
    }),
  );
  assert.deepEqual(result.degraded, ['openapi']);
});

test('a check nobody asked for is not applicable rather than degraded', async () => {
  const result = await run(
    await site({ 'pagebeam.config.yaml': 'docs:\n  root: docs\n', 'docs/a.md': '# A\n' }),
  );
  assert.ok(result.skipped.length > 0);
  assert.deepEqual(result.degraded, []);
});

test('a finding says what its evidence can carry', async () => {
  const result = await run(
    await site({
      'pagebeam.config.yaml':
        'docs:\n  root: docs\napps:\n  - name: api\n    path: api\n    envFiles: [".env.example"]\n',
      'docs/c.md': '```ini\nGONE=1\n```\n',
      'api/.env.example': 'KEPT=1\n',
    }),
  );
  const key = result.findings.find((f) => f.check === 'config-keys');
  assert.equal(key?.standing, 'review', 'an example file is not the contract');
});

import { execFileSync } from 'node:child_process';

function commit(root: string, message: string): void {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', [
    '-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message,
  ]);
}

test('a problem that predates the change is not blamed on it', async () => {
  const root = await site({
    'pagebeam.config.yaml': 'docs:\n  root: docs\nhistory:\n  sinceDays: 3650\n',
    'docs/a.md': '[old](/already-broken)\n',
  });
  execFileSync('git', ['-C', root, 'init', '-q']);
  commit(root, 'first');
  await writeFile(path.join(root, 'docs/b.md'), '[new](/just-broken)\n');
  commit(root, 'second');

  const result = await run(root);
  assert.notEqual(result.comparedWith, null, 'the documentation has a past to compare with');
  const byPage = new Map(result.findings.map((f) => [f.doc.path, f.introduced]));
  assert.equal(byPage.get('a.md'), false, 'already broken before this change');
  assert.equal(byPage.get('b.md'), true, 'broken by this change');
});

test('documentation in a nested directory is still readable at an earlier revision', async () => {
  const root = await site({
    'pagebeam.config.yaml': 'docs:\n  root: site/content\nhistory:\n  sinceDays: 3650\n',
    'site/content/a.md': '[old](/already-broken)\n',
  });
  execFileSync('git', ['-C', root, 'init', '-q']);
  commit(root, 'first');
  await writeFile(path.join(root, 'site/content/b.md'), '# B\n');
  commit(root, 'second');

  const result = await run(root);
  assert.notEqual(result.comparedWith, null);
  assert.equal(
    result.findings.find((f) => f.doc.path === 'a.md')?.introduced,
    false,
    'a nested root must not make every finding look new',
  );
});

test('a file that will not parse means the reading is not whole', async () => {
  const root = await site({
    'pagebeam.config.yaml':
      "docs:\n  root: docs\napps:\n  - name: ui\n    path: app\n    include: ['**/*.vue']\n",
    'docs/a.md': '# A\n',
    'app/Broken.vue': '<template><div v-if=></template>\n',
  });
  const { snapshot } = await import('@pagebeam/app');
  const taken = await snapshot({
    app: 'ui',
    root: path.join(root, 'app'),
    include: ['**/*.vue'],
    exclude: [],
    envFiles: [],
  });
  assert.ok(taken.unparsed.length > 0, 'the file was recorded as unreadable');
  assert.equal(taken.whole, false, 'part of the application was never read');
});
