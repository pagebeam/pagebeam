import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates, compare, dictionaryOf, normalise } from '../src/strings.ts';
import type { DocPage } from '@pagebeam/docs';
import type { Grade, Snapshot } from '@pagebeam/core';

const PARSED_PAIRED: Grade = { source: 'parsed', depth: 'paired' };
const PARSED_ALONE: Grade = { source: 'parsed', depth: 'single' };

function doc(value: string, before = 'Click the ', after = ' button.'): DocPage {
  return {
    path: 'guide.md', format: 'markdown', raw: '', prose: '', links: [], codeSpans: [],
    codeBlocks: [], emphasised: [{ value, line: 7, marker: 'strong', before, after }], directives: [], slug: null,
  };
}

function app(labels: string[], text: string[] = []): Snapshot {
  return {
    app: 'dashboard', rev: null, source: 'parsed',
    labels: labels.map((t) => ({ text: t, kind: 'button', file: 'a.vue' })),
    envKeys: [], files: text.map((v, i) => ({ path: `f${i}.ts`, text: v })),
  };
}

test('a control removed since the earlier revision is reported', () => {
  const findings = compare(
    candidates([doc('Create a report')], false),
    [dictionaryOf(app(['Compose a report']))],
    [dictionaryOf(app(['Create a report']))],
    PARSED_PAIRED,
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /was removed from dashboard/);
  assert.equal(findings[0]!.severity, 'error');
});

test('a control that never existed is not called removed', () => {
  const findings = compare(
    candidates([doc('Invented label')], false),
    [dictionaryOf(app(['Real label']))],
    [dictionaryOf(app(['Real label']))],
    PARSED_PAIRED,
  );
  assert.deepEqual(findings, [], 'it was not there before either, so nothing was removed');
});

test('a control still present is silent', () => {
  const findings = compare(
    candidates([doc('Create a report')], false),
    [dictionaryOf(app(['Create a report']))],
    [dictionaryOf(app(['Create a report']))],
    PARSED_PAIRED,
  );
  assert.deepEqual(findings, []);
});

test('a label mentioned only in a comment does not count as present', () => {
  const parsed = app([], ['// the Create a report button was removed last week']);
  const findings = compare(
    candidates([doc('Create a report')], true),
    [dictionaryOf({ ...parsed, labels: [{ text: 'Other', kind: 'button', file: 'a.vue' }] })],
    null,
    PARSED_ALONE,
  );
  assert.equal(findings.length, 1, 'a comment naming a control is not the control');
});

test('an application no parser covers falls back to its text', () => {
  const unparsed: Snapshot = {
    app: 'api', rev: null, source: 'raw', labels: [], envKeys: [],
    files: [{ path: 'a.py', text: 'render("Create a report")' }],
  };
  const findings = compare(
    candidates([doc('Create a report')], true),
    [dictionaryOf(unparsed)],
    null,
    { source: 'raw', depth: 'single' },
  );
  assert.deepEqual(findings, [], 'text is all there is, so text has to answer');
});

test('confidence and severity follow the evidence', () => {
  const made = (grade: Grade) =>
    compare(candidates([doc('Gone label')], true), [dictionaryOf(app(['Other']))], null, grade)[0]!;
  const parsed = made(PARSED_ALONE);
  const raw = made({ source: 'raw', depth: 'single' });
  assert.ok(parsed.confidence > raw.confidence);
  assert.equal(raw.severity, 'info');
  assert.match(parsed.detail, /no earlier revision/);
});

test('placeholder folding survives the rewrite', () => {
  assert.equal(normalise('Select all N'), normalise('Select all {{count}}'));
});

test('a phrase sharing words with another label is not a match', () => {
  const findings = compare(
    candidates([doc('Create a report')], false),
    [dictionaryOf(app(['Lay the report out again', 'Recreate it']))],
    [dictionaryOf(app(['Create a report']))],
    PARSED_PAIRED,
  );
  assert.equal(findings.length, 1, 'only a placeholder label may be matched word by word');
});
