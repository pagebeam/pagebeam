import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFor, type Open } from '../dist/plan.js';
import { bodyFor, titleFor } from '../dist/body.js';
import { readState, stateOf } from '../dist/state.js';
import { byPagebeam, messageFor, readTrailers } from '../dist/trailers.js';
import type { Finding } from '@pagebeam/core';

const finding = (id: string, revision = 'r1'): Finding => ({
  id,
  revision,
  fix: { kind: 'text-splice', author: 'deterministic', changes: [{ path: 'a.md', mode: 'write', contents: revision }] },
  check: 'links',
  standing: 'proven',
  severity: 'error',
  confidence: 1,
  doc: { path: 'a.md', line: 3 },
  title: `${id} does not resolve`,
  detail: 'Nothing answers to it.',
  evidence: [],
});

const opened = (findings: Finding[], commits: string[]): Open => ({
  number: 1,
  head: 'pagebeam/drift',
  body: bodyFor(findings, stateOf(findings), null),
  commits,
});

const ours = (f: Finding): string => messageFor(f, f.title);

test('nothing open and nothing wrong means nothing happens', () => {
  assert.equal(planFor({ findings: [], open: null, ours: true, complete: true }).action, 'noop');
});

test('the first finding opens a pull request', () => {
  assert.equal(planFor({ findings: [finding('a')], open: null, ours: true, complete: true }).action, 'create');
});

test('the same findings as last time push nothing', () => {
  const findings = [finding('a'), finding('b')];
  const plan = planFor({ findings, open: opened(findings, [ours(findings[0]!)]), ours: true, complete: true });
  assert.equal(plan.action, 'noop', 'a nightly run that found nothing new says nothing');
});

test('order does not make findings look different', () => {
  const findings = [finding('a'), finding('b')];
  const plan = planFor({
    findings: [finding('b'), finding('a')],
    open: opened(findings, [ours(findings[0]!)]),
    ours: true,
    complete: true,
  });
  assert.equal(plan.action, 'noop');
});

test('a changed proposal about the same thing updates', () => {
  const before = [finding('a', 'r1')];
  const plan = planFor({
    findings: [finding('a', 'r2')],
    open: opened(before, [ours(before[0]!)]),
    ours: true,
    complete: true,
  });
  assert.equal(plan.action, 'update');
});

test('a new finding updates', () => {
  const before = [finding('a')];
  const plan = planFor({
    findings: [finding('a'), finding('b')],
    open: opened(before, [ours(before[0]!)]),
    ours: true,
    complete: true,
  });
  assert.equal(plan.action, 'update');
});

test('a branch somebody has pushed to is added to, never replaced', () => {
  const before = [finding('a')];
  const plan = planFor({
    findings: [finding('a'), finding('b')],
    open: opened(before, ['fix a typo while I was here', ours(before[0]!)]),
    ours: false,
    complete: true,
  });
  assert.equal(plan.action, 'append');
  assert.match(plan.reason, /somebody has pushed/);
});

test('everything dealt with closes the pull request', () => {
  const before = [finding('a')];
  const plan = planFor({ findings: [], open: opened(before, [ours(before[0]!)]), ours: true, complete: true });
  assert.equal(plan.action, 'close');
});

test('a commit carries what it is about and who wrote it', () => {
  const written = readTrailers(ours(finding('abc', 'rev1')));
  assert.equal(written?.id, 'abc');
  assert.equal(written?.revision, 'rev1');
  assert.equal(written?.standing, 'proven');
});

test('a commit a person wrote carries none of that', () => {
  assert.equal(readTrailers('fix a typo while I was here'), null);
  assert.ok(!byPagebeam(['fix a typo', ours(finding('a'))]));
  assert.ok(byPagebeam([ours(finding('a')), ours(finding('b'))]));
  assert.ok(!byPagebeam([]), 'an empty branch is nobody is');
});

test('the body carries the state back for the next run to read', () => {
  const findings = [finding('a'), finding('b')];
  const body = bodyFor(findings, stateOf(findings), 'c00d5e76abc');
  assert.deepEqual(readState(body), stateOf(findings));
  assert.match(body, /Compared against `c00d5e76`/);
});

test('the body separates what is proven from what wants reading', () => {
  const proven = finding('a');
  const review: Finding = { ...finding('b'), standing: 'review', severity: 'warn' };
  const body = bodyFor([proven, review], stateOf([proven, review]), null);
  assert.match(body, /## Proven/);
  assert.match(body, /## Worth reading/);
  assert.match(titleFor([proven, review]), /2 findings from links/);
});

test('an incomplete scan finding nothing closes nothing', () => {
  const before = [finding('a')];
  const plan = planFor({
    findings: [],
    open: opened(before, [ours(before[0]!)]),
    ours: true,
    complete: false,
  });
  assert.equal(plan.action, 'noop');
  assert.match(plan.reason, /not everything was checked/);
});

test('a branch somebody took over is theirs to close', () => {
  const before = [finding('a')];
  const plan = planFor({
    findings: [],
    open: opened(before, ['my own work']),
    ours: false,
    complete: true,
  });
  assert.equal(plan.action, 'noop');
  assert.match(plan.reason, /theirs to close/);
});

test('state records what was proposed, not what was merely noticed', () => {
  const mendable = finding('a');
  const reported: Finding = { ...finding('b'), fix: undefined };
  const plan = planFor({ findings: [mendable, reported], open: null, ours: true, complete: true });
  assert.deepEqual(plan.state.findings.map((f) => f.id), ['a'], 'b was never offered as a change');
});
