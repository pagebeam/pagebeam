import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '@pagebeam/core';
import { capture, explore } from '../dist/capture.js';
import { compareCaptures } from '../dist/compare.js';
import { notesApp } from './fixture.ts';

function config(url = 'http://127.0.0.1:1') {
  return parseConfig({
    capture: { environments: { local: { backend: { kind: 'url', url, revision: 'notes-v1' }, fixtures: { version: 'notes-v1' }, timeoutMs: 20 } } },
    tours: {
      timeoutMs: 1000,
      targets: { local: { url } },
      accounts: { writer: { purpose: 'notes reader', login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } }, confirm: '#signout' } },
      journeys: { notes: { account: 'writer', paths: ['src/**'], viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }],
        explore: { goal: 'Check that notes are visible', maxActions: 2, timeoutMs: 2000 },
        steps: [{ goto: '/notes' }, { expect: { selector: 'li.note', text: 'Second note' } }, { shot: { name: 'list' } }] } },
    },
  });
}

test('empty selection writes JSON without HTML or touching an environment', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  const result = await capture({ cwd, config: config(), environment: 'does-not-exist', target: 'local', changed: ['README.md'] });
  assert.equal(result.report.status, 'empty');
  assert.equal(result.report.backend, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.directory, 'report.json'), 'utf8')), result.report);
  assert.deepEqual(await readdir(result.directory), ['report.json']);
});

test('bad selection retains a failed report and never starts services', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  const result = await capture({ cwd, config: config(), environment: 'local', target: 'local', journeys: ['missing'] });
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.errors[0]!.stage, 'selection');
  await access(path.join(result.directory, 'report.json'));
});

test('cancelled runs retain an incomplete report without starting services', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  const controller = new AbortController();
  controller.abort();
  const result = await capture({ cwd, config: config(), environment: 'local', target: 'local', all: true, signal: controller.signal });
  assert.equal(result.report.status, 'incomplete');
  assert.equal(result.report.backend, undefined);
  await access(path.join(result.directory, 'report.json'));
});

test('secret values in failure messages are redacted in files and returned results', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  process.env.PAGEBEAM_TEST_SECRET = 'disposable-test-value';
  try {
    const result = await capture({ cwd, config: config(), environment: 'local', target: 'local', journeys: [process.env.PAGEBEAM_TEST_SECRET] });
    assert.ok(result.report.errors[0]!.message.includes('<REDACTED>'));
    assert.ok(!(await readFile(path.join(result.directory, 'report.json'), 'utf8')).includes(process.env.PAGEBEAM_TEST_SECRET));
    assert.ok(!JSON.stringify(result.report).includes(process.env.PAGEBEAM_TEST_SECRET));
  } finally { delete process.env.PAGEBEAM_TEST_SECRET; }
});

test('short secrets cannot corrupt JSON keys, status values or run identifiers', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  process.env.PAGEBEAM_TEST_SECRET = 'a';
  try {
    const result = await capture({ cwd, config: config(), environment: 'local', target: 'local', changed: ['README.md', 'a'] });
    const stored = JSON.parse(await readFile(path.join(result.directory, 'report.json'), 'utf8'));
    assert.equal(stored.status, 'incomplete');
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.id, path.basename(result.directory));
    assert.deepEqual(stored.selection.unmapped, ['<REDACTED>']);
  } finally { delete process.env.PAGEBEAM_TEST_SECRET; }
});

test('readiness failure names its stage and credentials do not enter reports', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  process.env.PAGEBEAM_TEST_SECRET = 'disposable-test-value';
  try {
    const parsed = config();
    parsed.tours!.accounts.writer!.login = { script: './not-run.mjs' };
    const result = await capture({ cwd, config: parsed, environment: 'local', target: 'local', all: true });
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.errors[0]!.stage, 'readiness');
    assert.ok(!(await readFile(path.join(result.directory, 'report.json'), 'utf8')).includes(process.env.PAGEBEAM_TEST_SECRET));
  } finally { delete process.env.PAGEBEAM_TEST_SECRET; }
});

test('browser actions, assertions and captures use the signed-in application', async () => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  process.env.NOTES_USER = 'ada'; process.env.NOTES_PASSWORD = 'pw-ada';
  try {
    const parsed = config(app.url);
    parsed.capture!.environments.local!.timeoutMs = 5000;
    const result = await capture({ cwd, config: parsed, environment: 'local', target: 'local', all: true });
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report.errors));
    assert.equal(result.report.results[0]!.steps[1]!.assertion, 'observed');
    const shot = result.report.results[0]!.steps[2]!.file!;
    await access(path.join(result.directory, 'notes', 'desktop', shot));
    const baseline = structuredClone(result.report);
    baseline.revision = 'base'; result.report.revision = 'head';
    assert.equal(compareCaptures(result.report, baseline).compatible, true);
    baseline.backend!.fixtureVersion = 'different-data';
    assert.equal(compareCaptures(result.report, baseline).compatible, false);
  } finally { delete process.env.NOTES_USER; delete process.env.NOTES_PASSWORD; await app.stop(); }
});

test('caller exploration shares assertions and reports a separate assessment', async () => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  process.env.NOTES_USER = 'ada'; process.env.NOTES_PASSWORD = 'pw-ada';
  try {
    const parsed = config(app.url);
    parsed.capture!.environments.local!.timeoutMs = 5000;
    const result = await capture({ cwd, config: parsed, environment: 'local', target: 'local', all: true, mode: 'caller' }, async session => {
      await session.step({ goto: '/notes' });
      assert.ok((await session.observe()).text.includes('Notes'));
      await assert.rejects(session.step({ click: '#new' }), /not permitted/);
      await assert.rejects(session.step({ fill: { selector: '#title', valueEnv: 'NOTES_PASSWORD' } }), /cannot read environment/);
      await session.step({ expect: { selector: 'li.note', text: 'Second note' } });
    });
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report.errors));
    assert.deepEqual(result.report.results[0]!.assessment, { by: 'caller', outcome: 'complete' });
  } finally { delete process.env.NOTES_USER; delete process.env.NOTES_PASSWORD; await app.stop(); }
});

test('model-directed actions use the same executor and stop at their configured budget', async () => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-'));
  process.env.NOTES_USER = 'ada'; process.env.NOTES_PASSWORD = 'pw-ada';
  try {
    const parsed = config(app.url);
    parsed.capture!.environments.local!.timeoutMs = 5000;
    let actions = 0;
    const result = await capture({ cwd, config: parsed, environment: 'local', target: 'local', all: true, mode: 'model' }, session =>
      explore(session, async () => actions++ === 0 ? { goto: '/notes' } : { expect: { selector: 'li.note' } }));
    assert.equal(result.report.status, 'incomplete', JSON.stringify(result.report.errors));
    assert.equal(result.report.results[0]!.steps.length, 2);
  } finally { delete process.env.NOTES_USER; delete process.env.NOTES_PASSWORD; await app.stop(); }
});
