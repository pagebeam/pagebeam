import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMoved } from '../dist/moved.js';
import type { DocPage } from '@pagebeam/docs';
import type { Snapshot } from '@pagebeam/core';

const page = (value: string): DocPage => ({
  path: 'guide.md', format: 'markdown', raw: '', prose: '', links: [], codeSpans: [],
  codeBlocks: [], slug: null, directives: [],
  emphasised: [{ value, line: 3, marker: 'strong', before: 'Click the ', after: ' button.' }],
});

const app = (text: string, file: string): Snapshot => ({
  app: 'dashboard', rev: null, source: 'parsed',
  labels: [{ text, kind: 'button', file }], envKeys: [], files: [],
});

test('a page is flagged when the code behind a control it names changed', () => {
  const findings = checkMoved(
    [page('Create a report')],
    [app('Create a report', 'components/ReportForm.vue')],
    [{ app: 'dashboard', changed: ['components/ReportForm.vue'] }],
    () => true,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.standing, 'review', 'nothing is broken, so nothing is proven');
  assert.equal(findings[0]!.severity, 'info');
  assert.match(findings[0]!.detail, /still exist/);
});

test('a page edited alongside the code is not flagged', () => {
  const findings = checkMoved(
    [page('Create a report')],
    [app('Create a report', 'components/ReportForm.vue')],
    [{ app: 'dashboard', changed: ['components/ReportForm.vue'] }],
    () => false,
  );
  assert.deepEqual(findings, [], 'somebody already looked at it');
});

test('untouched code under untouched prose is silent', () => {
  const findings = checkMoved(
    [page('Create a report')],
    [app('Create a report', 'components/ReportForm.vue')],
    [{ app: 'dashboard', changed: ['components/Other.vue'] }],
    () => true,
  );
  assert.deepEqual(findings, []);
});

test('a control the page names but no application declares is not this check', () => {
  const findings = checkMoved(
    [page('Invented')],
    [app('Create a report', 'components/ReportForm.vue')],
    [{ app: 'dashboard', changed: ['components/ReportForm.vue'] }],
    () => true,
  );
  assert.deepEqual(findings, [], 'absence is the label check, movement is this one');
});

test('several controls on one page make one finding, not several', () => {
  const both: DocPage = {
    ...page('Create a report'),
    emphasised: [
      { value: 'Create a report', line: 3, marker: 'strong', before: 'Click the ', after: ' button.' },
      { value: 'Show related items', line: 9, marker: 'strong', before: 'Click the ', after: ' button.' },
    ],
  };
  const snapshot: Snapshot = {
    ...app('Create a report', 'components/ReportForm.vue'),
    labels: [
      { text: 'Create a report', kind: 'button', file: 'components/ReportForm.vue' },
      { text: 'Show related items', kind: 'button', file: 'components/ReportForm.vue' },
    ],
  };
  const findings = checkMoved(
    [both], [snapshot], [{ app: 'dashboard', changed: ['components/ReportForm.vue'] }], () => true,
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.detail, /"Create a report", "Show related items"/);
});

const withLabels = (labels: [string, string][], file: string): Snapshot => ({
  app: 'dashboard', rev: null, source: 'parsed',
  labels: labels.map(([text, kind]) => ({ text, kind, file })), envKeys: [], files: [],
});

test('a file reformatted without touching its controls is not movement', () => {
  const same = [['Create a report', 'button']] as [string, string][];
  const findings = checkMoved(
    [page('Create a report')],
    [withLabels(same, 'c.vue')],
    [{ app: 'dashboard', changed: ['c.vue'] }],
    () => true,
    [withLabels(same, 'c.vue')],
  );
  assert.deepEqual(findings, [], 'the file changed, what it offers the reader did not');
});

test('a control gaining a sibling is movement', () => {
  const findings = checkMoved(
    [page('Create a report')],
    [withLabels([['Create a report', 'button'], ['Undo', 'button']], 'c.vue')],
    [{ app: 'dashboard', changed: ['c.vue'] }],
    () => true,
    [withLabels([['Create a report', 'button']], 'c.vue')],
  );
  assert.equal(findings.length, 1);
});

test('a control changing what kind of thing it is counts', () => {
  const findings = checkMoved(
    [page('Create a report')],
    [withLabels([['Create a report', 'a']], 'c.vue')],
    [{ app: 'dashboard', changed: ['c.vue'] }],
    () => true,
    [withLabels([['Create a report', 'button']], 'c.vue')],
  );
  assert.equal(findings.length, 1, 'a button becoming a link is worth reading about');
});

const noParser = (files: [string, string][]): Snapshot => ({
  app: 'core', rev: null, source: 'raw', labels: [], envKeys: [],
  files: files.map(([path, text]) => ({ path, text })),
});

test('an application with no parser still produces the signal', () => {
  const findings = checkMoved(
    [page('Start import')],
    [noParser([['ui.py', 'button("Start import")\nlabel("New")']])],
    [{ app: 'core', changed: ['ui.py'] }],
    () => true,
    [noParser([['ui.py', 'button("Start import")']])],
  );
  assert.equal(findings.length, 1, 'no parser is not no evidence');
  assert.equal(findings[0]!.standing, 'review');
  assert.match(findings[0]!.detail, /No parser covers core/);
});

test('an application with no parser says how weak the reading is', () => {
  const weak = checkMoved(
    [page('Start import')],
    [noParser([['ui.py', 'button("Start import")\nlabel("New")']])],
    [{ app: 'core', changed: ['ui.py'] }],
    () => true,
    [noParser([['ui.py', 'button("Start import")']])],
  )[0]!;
  const strong = checkMoved(
    [page('Create a report')],
    [withLabels([['Create a report', 'button'], ['Undo', 'button']], 'c.vue')],
    [{ app: 'dashboard', changed: ['c.vue'] }],
    () => true,
    [withLabels([['Create a report', 'button']], 'c.vue')],
  )[0]!;
  assert.ok(strong.confidence > weak.confidence);
});

test('reformatting a file no parser covers is not movement', () => {
  const findings = checkMoved(
    [page('Start import')],
    [noParser([['ui.py', 'button(\n  "Start import"\n)']])],
    [{ app: 'core', changed: ['ui.py'] }],
    () => true,
    [noParser([['ui.py', 'button("Start import")']])],
  );
  assert.deepEqual(findings, [], 'the words are the same, only the layout moved');
});
