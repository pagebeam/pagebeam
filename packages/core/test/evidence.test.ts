import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestSource, caveatOf, confidenceOf, severityOf, standingOf } from '../src/evidence.ts';

test('a parser beats text search', () => {
  assert.equal(bestSource(['raw', 'parsed']), 'parsed');
  assert.equal(bestSource(['raw', 'parsed', 'rendered']), 'rendered');
  assert.equal(bestSource([]), 'raw');
});

test('history and extraction move confidence independently', () => {
  const parsedPaired = confidenceOf({ source: 'parsed', depth: 'paired' });
  const parsedAlone = confidenceOf({ source: 'parsed', depth: 'single' });
  const rawPaired = confidenceOf({ source: 'raw', depth: 'paired' });
  assert.ok(parsedPaired > parsedAlone, 'an earlier revision raises confidence');
  assert.ok(parsedPaired > rawPaired, 'a parser raises confidence');
  assert.ok(rawPaired > confidenceOf({ source: 'raw', depth: 'single' }));
});

test('only a parsed comparison across revisions is an error', () => {
  assert.equal(severityOf({ source: 'parsed', depth: 'paired' }), 'error');
  assert.equal(severityOf({ source: 'rendered', depth: 'paired' }), 'error');
  assert.equal(severityOf({ source: 'parsed', depth: 'single' }), 'warn');
  assert.equal(severityOf({ source: 'raw', depth: 'paired' }), 'warn');
  assert.equal(severityOf({ source: 'raw', depth: 'single' }), 'info');
});

test('anything less than the best evidence says so', () => {
  assert.equal(caveatOf({ source: 'rendered', depth: 'paired' }), null);
  assert.match(caveatOf({ source: 'raw', depth: 'single' }) ?? '', /no parser.*no earlier revision/is);
});

test('a partial view cannot prove something is gone', () => {
  const whole = { source: 'parsed', depth: 'paired' } as const;
  const partial = { source: 'rendered', depth: 'paired', whole: false } as const;
  assert.equal(standingOf(whole), 'proven');
  assert.equal(standingOf(partial), 'review', 'a page nobody opened shows nothing');
  assert.ok(confidenceOf(whole) > confidenceOf(partial));
  assert.equal(severityOf(partial), 'info');
  assert.match(caveatOf(partial) ?? '', /nobody looked/);
});

test('rendering still outranks reading source when the view is whole', () => {
  assert.ok(
    confidenceOf({ source: 'rendered', depth: 'paired' }) >
      confidenceOf({ source: 'parsed', depth: 'paired' }),
  );
});
