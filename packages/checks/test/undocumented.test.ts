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

test('a name the running application showed is not something to document', () => {
  const rendered: Snapshot = {
    app: 'dashboard', rev: null, source: 'rendered', whole: false, covered: true, unparsed: [],
    labels: [
      { text: 'Billing', kind: 'h2', file: '/systems', from: 'rendered' },
      { text: 'Payments API', kind: 'h2', file: '/systems', from: 'rendered' },
      { text: 'Customer Records', kind: 'h2', file: '/systems', from: 'rendered' },
    ],
    envKeys: [], files: [],
  };
  assert.deepEqual(
    checkUndocumented([page('')], [rendered], null),
    [],
    'those are the names of somebody systems, not controls',
  );
});

// A label occurring inside a longer word is not that label. "Save" is in
// "autosave" and in "saved", and a page saying either has described neither.
test('a word inside a longer word has not described the control', () => {
  const controls: [string, string][] = [
    ['Save', 'pages/editor.vue'],
    ['Undo', 'pages/editor.vue'],
    ['Redo', 'pages/editor.vue'],
  ];
  const found = checkUndocumented([page('Your work is autosaved, and saved drafts are kept.')], [app(controls)], null);
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /"Save"/, 'autosaved is not Save');
});

test('a phrase has to appear whole', () => {
  const controls: [string, string][] = [
    ['Start Your Plan', 'pages/billing.vue'],
    ['Cancel Plan', 'pages/billing.vue'],
    ['Change Card', 'pages/billing.vue'],
  ];
  const apart = checkUndocumented([page('You can start something. Your plan is shown here.')], [app(controls)], null);
  assert.equal(apart.length, 1, 'the words are all there, the phrase is not');

  const whole = checkUndocumented(
    [page('Press Start Your Plan, then Cancel Plan, then Change Card.')],
    [app(controls)],
    null,
  );
  assert.deepEqual(whole, [], 'said whole, all three are described');
});

test('punctuation between a label and the prose is not a difference', () => {
  const controls: [string, string][] = [
    ['Save changes', 'pages/editor.vue'],
    ['Undo', 'pages/editor.vue'],
    ['Redo', 'pages/editor.vue'],
  ];
  const found = checkUndocumented(
    [page('Press **Save changes**. Then Undo, or Redo.')],
    [app(controls)],
    null,
  );
  assert.deepEqual(found, []);
});
