import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '@pagebeam/core';
import { selectJourneys } from '../dist/selection.js';

const config = parseConfig({
  tours: {
    targets: { local: { url: 'http://localhost:3000' } },
    accounts: { reader: { purpose: 'test reader', login: { script: './login.mjs' }, confirm: '#signed-in' } },
    journeys: {
      expenses: { account: 'reader', paths: ['src/expenses/**'], steps: [{ goto: '/expenses' }] },
      wallets: { account: 'reader', paths: ['src/wallets/**'], steps: [{ goto: '/wallets' }] },
    },
  },
  capture: { environments: {}, groups: { shared: { paths: ['src/components/**'], journeys: ['expenses'] } } },
});

test('changed files select only mapped journeys and explain shared selection', () => {
  assert.deepEqual(selectJourneys(config.tours!, config.capture, { changed: ['src/wallets/form.vue', 'src/components/input.vue', 'README.md'] }), {
    journeys: [{ name: 'wallets', reasons: ['path: src/wallets/form.vue'] }, { name: 'expenses', reasons: ['group shared: src/components/input.vue'] }],
    unmapped: ['README.md'],
  });
});

test('explicit selection overrides changed paths and deduplicates names', () => {
  assert.deepEqual(selectJourneys(config.tours!, config.capture, { journeys: ['wallets', 'wallets'], changed: ['src/expenses/form.vue'] }), {
    journeys: [{ name: 'wallets', reasons: ['explicit selection'] }], unmapped: [],
  });
});

test('unknown changes and an empty diff never select everything', () => {
  assert.deepEqual(selectJourneys(config.tours!, config.capture, { changed: ['unknown.ts'] }), { journeys: [], unmapped: ['unknown.ts'] });
  assert.deepEqual(selectJourneys(config.tours!, config.capture, { changed: [] }), { journeys: [], unmapped: [] });
  assert.throws(() => selectJourneys(config.tours!, config.capture, {}), /select journeys/);
});

test('full runs require an explicit request and reject conflicting selection', () => {
  assert.equal(selectJourneys(config.tours!, config.capture, { all: true }).journeys.length, 2);
  assert.throws(() => selectJourneys(config.tours!, config.capture, { all: true, journeys: ['wallets'] }), /not both/);
  assert.throws(() => selectJourneys(config.tours!, config.capture, { journeys: ['missing'] }), /unknown journey/);
  assert.throws(() => selectJourneys(config.tours!, config.capture, { all: 'false' } as never), /must be a boolean/);
});

test('invalid representative groups fail before any environment starts', () => {
  assert.throws(() => selectJourneys(config.tours!, { ...config.capture!, groups: { shared: { paths: ['**'], journeys: ['missing'] } } }, { changed: [] }), /unknown journey/);
});

test('capture-only configurations do not silently enable documentation discovery', () => {
  assert.deepEqual(config.docs.include, []);
  assert.throws(() => parseConfig({ tours: { ...config.tours, journeys: { empty: { account: 'reader' } } } }), /steps or an exploration goal/);
});

test('exploration defaults are bounded and interactions are opt-in', () => {
  const parsed = parseConfig({ tours: { ...config.tours, journeys: { explore: { account: 'reader', explore: { goal: 'Read the expense list' } } } } });
  assert.equal(parsed.tours!.journeys.explore!.explore!.maxActions, 50);
  assert.equal(parsed.tours!.journeys.explore!.explore!.timeoutMs, 300_000);
  assert.equal(parsed.tours!.journeys.explore!.explore!.allowChanges, false);
  assert.ok(!parsed.tours!.journeys.explore!.explore!.actions.includes('click'));
});

test('all backend sources have explicit runtime and data contracts', () => {
  const backends = [
    { kind: 'url', url: 'http://localhost:8080', revision: 'backend-v1' },
    { kind: 'image', compose: 'compose.yml', service: 'api', image: `example/backend@sha256:${'a'.repeat(64)}`, ready: 'http://localhost:8080/health' },
    { kind: 'directory', path: '../backend', start: 'npm start', ready: 'http://localhost:8080/health' },
    { kind: 'mock', path: '.', start: 'node mocks.mjs', ready: 'http://localhost:8080/health', fixtures: 'fixtures', version: 'v1', validate: 'node validate.mjs' },
  ];
  for (const backend of backends) {
    const parsed = parseConfig({ capture: { environments: { test: { backend } } } });
    assert.equal(parsed.capture!.environments.test!.backend.kind, backend.kind);
  }
  assert.throws(() => parseConfig({ capture: { environments: { test: { backend: { ...backends[1], image: 'example/backend:latest' } } } } }));
  assert.throws(() => parseConfig({ capture: { environments: { test: { backend: { ...backends[3], validate: undefined } } } } }));
});
