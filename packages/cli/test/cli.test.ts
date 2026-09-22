import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../dist/main.js');

async function invoke(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

async function site(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-cli-'));
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

test('an unknown option is refused rather than ignored', async () => {
  const { code, err } = await invoke(['check', '--nonsense']);
  assert.equal(code, 2);
  assert.match(err, /unknown option: --nonsense/);
});

test('an invalid profile is refused rather than silently downgraded', async () => {
  const { code, err } = await invoke(['check', '--profile', 'strict']);
  assert.equal(code, 2);
  assert.match(err, /--profile must be one of/);
});

test('an option missing its value is refused', async () => {
  const { code } = await invoke(['check', '--cwd']);
  assert.equal(code, 2);
});

test('a clean site exits zero and says what it checked', async () => {
  const root = await site({ 'pagebeam.config.yaml': 'docs:\n  root: docs\n', 'docs/a.md': '# A\n' });
  const { code, out } = await invoke(['check', '--cwd', root]);
  assert.equal(code, 0);
  assert.match(out, /No drift found/);
});

test('reading nothing exits two', async () => {
  const root = await site({ 'pagebeam.config.yaml': 'docs:\n  root: docs\n' });
  const { code, out } = await invoke(['check', '--cwd', root]);
  assert.equal(code, 2);
  assert.match(out, /Nothing was checked/);
});

test('a file that cannot be read ends the run rather than looking empty', async () => {
  const root = await site({
    'pagebeam.config.yaml': 'docs:\n  root: docs\n',
    'docs/a.md': '# A\n',
    'docs/locked.md': '# L\n',
  });
  await chmod(path.join(root, 'docs/locked.md'), 0o000);
  const { code, out } = await invoke(['check', '--cwd', root]);
  await chmod(path.join(root, 'docs/locked.md'), 0o644);
  if (process.getuid?.() === 0) return;
  assert.equal(code, 2, out);
});

test('a finding of unknown age never blocks under enforce', async () => {
  const root = await site({
    'pagebeam.config.yaml': 'docs:\n  root: docs\n',
    'docs/a.md': '[gone](/nowhere)\n',
  });
  const strict = await invoke(['check', '--cwd', root, '--profile', 'enforce']);
  assert.equal(strict.code, 0, 'no history means no known age, so nothing is introduced');
  assert.match(strict.out, /does not resolve/);
});

test('json output carries the fields a machine needs', async () => {
  const root = await site({ 'pagebeam.config.yaml': 'docs:\n  root: docs\n', 'docs/a.md': '# A\n' });
  const { out } = await invoke(['check', '--cwd', root, '--json']);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  for (const key of ['problem', 'degraded', 'comparedWith', 'grade', 'pages', 'findings']) {
    assert.ok(key in parsed, key);
  }
});

// Asking a question of a pipe is waiting for an answer nobody will give.
test('with nobody there to answer, it says what it worked out instead of asking', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-init-'));
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs/guide.md'), '# Guide\n');

  const { stdout } = await run(process.execPath, [CLI, 'init', '--cwd', root]);
  assert.match(stdout, /Wrote pagebeam.config.yaml/);
  assert.match(stdout, /docs: docs/);
  assert.match((await readFile(path.join(root, 'pagebeam.config.yaml'), 'utf8')), /root: docs/);
});

test('it will not write over a configuration somebody already has', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-init-'));
  await writeFile(path.join(root, 'pagebeam.config.yaml'), 'docs:\n  root: mine\n');
  await assert.rejects(run(process.execPath, [CLI, 'init', '--cwd', root]));
  assert.match(await readFile(path.join(root, 'pagebeam.config.yaml'), 'utf8'), /root: mine/);
});
