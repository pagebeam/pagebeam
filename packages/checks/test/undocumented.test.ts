import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkUndocumented } from '../dist/undocumented.js';
import type { DocPage } from '@pagebeam/docs';
import type { Snapshot } from '@pagebeam/core';

const page = (prose: string): DocPage => ({
  path: 'g.md', format: 'markdown', raw: '', prose, links: [], codeSpans: [],
  codeBlocks: [], slug: null, emphasised: [], directives: [],
});

const app = (labels: [string, string][]): Snapshot => ({
  app: 'dashboard', rev: null, source: 'parsed', whole: true, covered: true, unparsed: [],
  labels: labels.map(([text, file]) => ({ text, kind: 'button', file })), envKeys: [], files: [],
});

const three: [string, string][] = [
  ['Start Your Plan', 'pages/billing.vue'],
  ['Cancel Plan', 'pages/billing.vue'],
  ['Change Card', 'pages/billing.vue'],
];

test('controls no page mentions are reported by the screen they live on', () => {
  const findings = checkUndocumented([page('Nothing about billing here.')], [app(three)], null);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /3 control\(s\) the documentation never mentions/);
  assert.equal(findings[0]!.standing, 'review', 'undocumented is not broken');
});

test('controls the documentation describes are not reported', () => {
  const findings = checkUndocumented(
    [page('Press Start Your Plan, then Cancel Plan, then Change Card.')],
    [app(three)],
    null,
  );
  assert.deepEqual(findings, []);
});

test('with a past, only what arrived since is asked about', () => {
  const findings = checkUndocumented(
    [page('Nothing about billing here.')],
    [app([...three, ['Pause Plan', 'pages/billing.vue']])],
    [app(three)],
  );
  assert.deepEqual(findings, [], 'one new control is not a documentation gap worth raising');
});

test('a screenful of new controls with nothing written is worth raising', () => {
  const arrived: [string, string][] = [
    ['Pause Plan', 'pages/billing.vue'],
    ['Resume Plan', 'pages/billing.vue'],
    ['Download Invoice', 'pages/billing.vue'],
  ];
  const findings = checkUndocumented(
    [page('Nothing about billing here.')],
    [app([...three, ...arrived])],
    [app(three)],
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /gained 3 control\(s\)/);
});

test('a fragment or an identifier is not a control anybody looks up', () => {
  const noise: [string, string][] = [
    [', across every workspace you own', 'pages/a.vue'],
    ['repository_analysis', 'pages/a.vue'],
    ['model.api_key', 'pages/a.vue'],
    ['. The key is never shown.', 'pages/a.vue'],
  ];
  assert.deepEqual(checkUndocumented([page('')], [app(noise)], null), []);
});
