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

// One corpus for a whole product means a page describing a control on one
// screen marks the same word documented on every other screen, and a page
// about one application satisfies another.
const on = (where: string, labels: string[]): Snapshot => ({
  app: 'dashboard', rev: null, source: 'parsed', whole: true, covered: true, unparsed: [],
  labels: labels.map((text) => ({ text, kind: 'button', file: `pages/${where}.vue` })), envKeys: [],
  files: [{ path: `pages/${where}.vue`, text: '<template><div /></template>' }],
});

const about = (path: string, href: string, prose: string): DocPage => ({
  path, format: 'markdown', raw: '', prose,
  links: [{ href, line: 1 }] as never, codeSpans: [], codeBlocks: [], slug: null,
  emphasised: [], directives: [],
});

test('a page about one screen does not document another', () => {
  const billing = about('billing.md', '/billing', 'Press Start Your Plan, Cancel Plan and Change Card.');
  const both: Snapshot = {
    ...on('billing', ['Start Your Plan', 'Cancel Plan', 'Change Card']),
    labels: [
      ...on('billing', ['Start Your Plan', 'Cancel Plan', 'Change Card']).labels,
      ...on('reports', ['Start Your Plan', 'Cancel Plan', 'Change Card']).labels,
    ],
    files: [
      { path: 'pages/billing.vue', text: '<template><div /></template>' },
      { path: 'pages/reports.vue', text: '<template><div /></template>' },
    ],
  };
  const found = checkUndocumented([billing], [both], null);
  assert.equal(found.length, 1, 'the words are documented, just not for the screen that has none');
  assert.match(found[0]!.doc.path, /reports/);
});

test('a page about the screen does document it', () => {
  const reports = about('reports.md', '/reports', 'Press Start Your Plan, Cancel Plan and Change Card.');
  assert.deepEqual(
    checkUndocumented([reports], [on('reports', ['Start Your Plan', 'Cancel Plan', 'Change Card'])], null),
    [],
  );
});

test('where nothing ties a page to a screen, everything written is read', () => {
  const loose = about('guide.md', '/somewhere-else', 'Press Start Your Plan, Cancel Plan and Change Card.');
  assert.deepEqual(
    checkUndocumented([loose], [on('reports', ['Start Your Plan', 'Cancel Plan', 'Change Card'])], null),
    [],
    'no evidence to scope by is not a reason to report everything',
  );
});

test('the home screen is documented by the home page, even when other screens have pages', () => {
  const snapshot: Snapshot = {
    app: 'dashboard', rev: null, source: 'parsed', whole: true, covered: true, unparsed: [],
    labels: [
      ...['Save Account', 'Delete Account', 'Invite Member'].map((text) => ({ text, kind: 'button', file: 'pages/index.vue' })),
      ...['Start Your Plan', 'Cancel Plan', 'Change Card'].map((text) => ({ text, kind: 'button', file: 'pages/billing.vue' })),
    ] as never,
    envKeys: [],
    files: [
      { path: 'pages/index.vue', text: '<template><div /></template>' },
      { path: 'pages/billing.vue', text: '<template><div /></template>' },
    ],
  };
  const home = about('index.md', '/getting-started', 'Save Account. Delete Account. Invite Member.');
  const billing = about('billing.md', '/billing', 'Press Start Your Plan, Cancel Plan and Change Card.');
  assert.deepEqual(checkUndocumented([home, billing], [snapshot], null), []);
});
