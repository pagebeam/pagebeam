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
  labels: [{ text, kind: 'button', file }], envKeys: [], text: [],
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
