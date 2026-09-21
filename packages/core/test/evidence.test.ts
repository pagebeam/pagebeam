import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestSource, caveatOf, confidenceOf, severityOf } from '../src/evidence.ts';

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
