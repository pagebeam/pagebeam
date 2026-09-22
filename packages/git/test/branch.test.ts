import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apply, commit, commitsOn, exists, headOf, open, within } from '../dist/branch.js';
import type { Finding } from '@pagebeam/core';

const finding = (id: string): Finding => ({
  id, revision: 'r1', check: 'links', standing: 'proven', severity: 'error', confidence: 1,
  doc: { path: 'docs/a.md' }, title: `${id} does not resolve`, detail: 'Nothing answers to it.',
  evidence: [],
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-repo-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs/a.md'), 'Original line.\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first']);
  return dir;
}

test('work happens in a checkout of its own, leaving the repository alone', async () => {
  const dir = await repo();
  const before = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
  const session = await open(dir, 'pagebeam/drift', 'main', true);
  try {
    await apply(session.dir, [{ path: 'docs/a.md', mode: 'write', contents: 'Replaced.\n' }]);
    await commit(session.dir, finding('a'), 'docs: fix a');
    assert.equal(
      execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(),
      before,
      'the branch somebody had checked out has not moved',
    );
    assert.equal(await readFile(path.join(dir, 'docs/a.md'), 'utf8'), 'Original line.\n');
  } finally {
    await session.end();
  }
  assert.ok(await exists(dir, 'pagebeam/drift'));
});

test('a splice changes only the bytes it names', async () => {
  const dir = await repo();
  const session = await open(dir, 'pagebeam/drift', 'main', true);
  try {
    await apply(session.dir, [
      { path: 'docs/a.md', mode: 'write', splice: { start: 0, end: 8, text: 'Replaced' } },
    ]);
    assert.equal(await readFile(path.join(session.dir, 'docs/a.md'), 'utf8'), 'Replaced line.\n');
  } finally {
    await session.end();
  }
});

test('a commit that would change nothing is not made', async () => {
  const dir = await repo();
  const session = await open(dir, 'pagebeam/drift', 'main', true);
  try {
    assert.equal(await commit(session.dir, finding('a'), 'docs: nothing'), false);
  } finally {
    await session.end();
  }
});

test('replaying from the base discards what was there before', async () => {
  const dir = await repo();
  const first = await open(dir, 'pagebeam/drift', 'main', true);
  await apply(first.dir, [{ path: 'docs/a.md', mode: 'write', contents: 'One.\n' }]);
  await commit(first.dir, finding('a'), 'docs: a');
  const firstHead = await headOf(first.dir);
  await first.end();

  const again = await open(dir, 'pagebeam/drift', 'main', true);
  try {
    await apply(again.dir, [{ path: 'docs/a.md', mode: 'write', contents: 'Two.\n' }]);
    await commit(again.dir, finding('b'), 'docs: b');
    assert.notEqual(await headOf(again.dir), firstHead);
    assert.deepEqual(
      (await commitsOn(dir, 'pagebeam/drift', 'main')).length,
      1,
      'one finding, one commit, not two',
    );
  } finally {
    await again.end();
  }
});

test('carrying on from a branch keeps what is already on it', async () => {
  const dir = await repo();
  const first = await open(dir, 'pagebeam/drift', 'main', true);
  await apply(first.dir, [{ path: 'docs/a.md', mode: 'write', contents: 'One.\n' }]);
  await commit(first.dir, finding('a'), 'docs: a');
  await first.end();

  const again = await open(dir, 'pagebeam/drift', 'main', false);
  try {
    await apply(again.dir, [{ path: 'docs/b.md', mode: 'write', contents: 'Two.\n' }]);
    await commit(again.dir, finding('b'), 'docs: b');
    assert.equal((await commitsOn(dir, 'pagebeam/drift', 'main')).length, 2);
  } finally {
    await again.end();
  }
});

test('a proposal cannot write outside the checkout', async () => {
  const dir = await repo();
  const session = await open(dir, 'pagebeam/drift', 'main', true);
  try {
    await assert.rejects(
      () => apply(session.dir, [{ path: '../escaped.md', mode: 'write', contents: 'no' }]),
      /outside the checkout/,
    );
    await assert.rejects(
      () => apply(session.dir, [{ path: '/etc/passwd', mode: 'delete' }]),
      /outside the checkout/,
    );
    assert.equal(within(session.dir, 'docs/a.md'), path.join(session.dir, 'docs/a.md'));
  } finally {
    await session.end();
  }
});
