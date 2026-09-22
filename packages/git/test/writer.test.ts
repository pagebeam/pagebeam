import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { write } from '../dist/writer.js';
import type { Forge, PullRequest, Raise } from '../dist/forge.js';
import type { Finding } from '@pagebeam/core';

function fake(): Forge & { calls: string[]; current: PullRequest | null } {
  const state = {
    calls: [] as string[],
    current: null as PullRequest | null,
    async findOpen() {
      state.calls.push('findOpen');
      return state.current;
    },
    async create(raise: Raise) {
      state.calls.push('create');
      state.current = { number: 7, url: 'https://example.test/pull/7', body: raise.body, head: raise.head };
      return state.current;
    },
    async update(n: number, _t: string, body: string) {
      state.calls.push('update');
      state.current = { ...(state.current as PullRequest), body };
      return state.current;
    },
    async close(_n: number) {
      state.calls.push('close');
      state.current = null;
    },
  };
  return state;
}

const fixing = (id: string, text: string): Finding => ({
  id, revision: text, check: 'strings', standing: 'proven', severity: 'error', confidence: 1,
  doc: { path: 'docs/a.md' }, title: `${id} was renamed`, detail: 'It moved.', evidence: [],
  fix: { kind: 'text-splice', author: 'deterministic', changes: [{ path: 'docs/a.md', mode: 'write', contents: text }] },
});

const unfixable = (id: string): Finding => ({
  id, revision: 'r', check: 'links', standing: 'proven', severity: 'error', confidence: 1,
  doc: { path: 'docs/a.md' }, title: `${id} does not resolve`, detail: 'Nothing answers.', evidence: [],
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-w-'));
  const remote = await mkdtemp(path.join(tmpdir(), 'pagebeam-remote-'));
  execFileSync('git', ['-C', remote, 'init', '-q', '--bare', '-b', 'main']);
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs/a.md'), 'Original.\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first']);
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'main']);
  return dir;
}

const base = async (findings: Finding[]) => ({
  repo: await repo(), branch: 'pagebeam/drift', base: 'main', findings,
  comparedWith: null, dryRun: true,
});

test('a finding with a fix becomes a commit and a pull request', async () => {
  const forge = fake();
  const result = await write(forge, { ...(await base([fixing('a', 'One.\n')])), dryRun: false });
  assert.equal(result.action, 'create');
  assert.equal(result.commits, 1);
  assert.equal(result.url, 'https://example.test/pull/7');

});

test('findings nothing can mend raise nothing', async () => {
  const forge = fake();
  const result = await write(forge, { ...(await base([unfixable('a')])), dryRun: false });
  assert.equal(result.action, 'noop');
  assert.match(result.reason, /nothing found has a fix/);
  assert.ok(!forge.calls.includes('create'), 'a pull request needs something to propose');
});

test('the same findings twice change nothing the second time', async () => {
  const forge = fake();
  const where = await base([fixing('a', 'One.\n')]);
  await write(forge, { ...where, dryRun: false });
  const calls = forge.calls.length;
  const again = await write(forge, { ...where, dryRun: false });
  assert.equal(again.action, 'noop');
  assert.equal(forge.calls.length, calls + 1, 'it looked, and did nothing else');
});

test('everything dealt with closes the pull request', async () => {
  const forge = fake();
  const where = await base([fixing('a', 'One.\n')]);
  await write(forge, { ...where, dryRun: false });
  const result = await write(forge, { ...where, findings: [], dryRun: false });
  assert.equal(result.action, 'close');
  assert.ok(forge.calls.includes('close'));
});

test('a branch somebody pushed to is added to rather than replaced', async () => {
  const forge = fake();
  const where = await base([fixing('a', 'One.\n')]);
  await write(forge, { ...where, dryRun: false });

  execFileSync('git', ['-C', where.repo, 'switch', '-q', 'pagebeam/drift']);
  await writeFile(path.join(where.repo, 'docs/mine.md'), 'Mine.\n');
  execFileSync('git', ['-C', where.repo, 'add', '-A']);
  execFileSync('git', ['-C', where.repo, '-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-qm', 'my own work']);
  execFileSync('git', ['-C', where.repo, 'switch', '-q', 'main']);

  const result = await write(forge, {
    ...where,
    findings: [fixing('a', 'One.\n'), fixing('b', 'Two.\n')],
    dryRun: false,
  });
  assert.equal(result.action, 'append');
  const log = execFileSync('git', ['-C', where.repo, 'log', '--format=%s', 'main..pagebeam/drift']).toString();
  assert.match(log, /my own work/, 'their commit is still there');
});
