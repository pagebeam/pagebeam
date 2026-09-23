import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settles } from '../dist/settles.js';
import type { Finding } from '@pagebeam/core';

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'a', revision: 'r', check: 'strings', standing: 'proven', severity: 'error',
  confidence: 1, doc: { path: 'guide.md' },
  title: '"Add transaction" was removed from ui',
  detail: 'It is gone.', evidence: [],
  fix: {
    kind: 'new-file', author: 'model',
    changes: [{ path: 'guide.md', mode: 'write', contents: '' }],
  },
  ...over,
});

const WAS = 'Press **Add transaction**.\n\nSee [the guide](/guide).\n\n```sh\nnpm run dev\n```\n';

test('a page that settles what was raised is accepted', async () => {
  const now = 'Press **Record transaction**.\n\nSee [the guide](/guide).\n\n```sh\nnpm run dev\n```\n';
  assert.equal(await settles(finding(), WAS, now), null);
});

test('a page that dropped a link nobody asked about is refused', async () => {
  const now = 'Press **Record transaction**.\n\n```sh\nnpm run dev\n```\n';
  assert.match(String((await settles(finding(), WAS, now))?.because), /link/);
});

test('a page that dropped a code block nobody asked about is refused', async () => {
  const now = 'Press **Record transaction**.\n\nSee [the guide](/guide).\n';
  assert.match(String((await settles(finding(), WAS, now))?.because), /code block/);
});

test('the dead link a finding was about is the one it may remove', async () => {
  const dead = finding({
    check: 'links',
    title: '/screenshots/gone.png does not resolve',
    doc: { path: 'guide.md' },
  });
  const was = 'See [a shot](/screenshots/gone.png) and [the guide](/guide).\n';
  const now = 'See [the guide](/guide).\n';
  assert.equal(await settles(dead, was, now), null);
});

test('a page with nothing to compare against is judged on itself', async () => {
  const now = '# Dashboard\n\nThe controls here.\n';
  assert.equal(await settles(finding({ check: 'undocumented', title: 'x gained 3 control(s)' }), null, now), null);
});
