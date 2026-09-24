import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { envReads } from '../dist/env.js';

const READS = {
  'config/agents.php': "<?php return ['p' => env('AGENTS_PROVIDER', 'x'), 'k' => getenv(\"PHP_KEY\")];",
  'app/settings.py': "A = os.environ['PY_KEY']\nB = os.environ.get('PY_OTHER')\nC = os.getenv('PY_THIRD')",
  'server/main.go': 'port := os.Getenv("GO_PORT")',
  'web/nuxt.config.ts': "export default { a: process.env.NUXT_KEY, b: process.env['NUXT_OTHER'], c: import.meta.env.VITE_KEY }",
  'lib/boot.rb': "ENV.fetch('RB_KEY')\nENV['RB_OTHER']",
  'vendor/pkg/x.php': "env('VENDORED_KEY')",
  'node_modules/pkg/x.js': 'process.env.MODULE_KEY',
  'web/a.test.ts': 'process.env.TEST_ONLY_KEY',
};
const WANTED = ['AGENTS_PROVIDER', 'GO_PORT', 'NUXT_KEY', 'NUXT_OTHER', 'PHP_KEY', 'PY_KEY', 'PY_OTHER', 'PY_THIRD', 'RB_KEY', 'RB_OTHER', 'VITE_KEY'];

test('variables the source reads are found today and at a revision, outside vendored code and tests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-env-'));
  for (const [at, text] of Object.entries(READS)) {
    await mkdir(path.dirname(path.join(root, at)), { recursive: true });
    await writeFile(path.join(root, at), text);
  }
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '-Af']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x']);
  const exclude = ['**/*.test.*'];
  assert.deepEqual([...(await envReads(root, exclude))].sort(), WANTED);
  assert.deepEqual([...(await envReads(root, exclude, 'HEAD'))].sort(), WANTED);
});
