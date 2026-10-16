import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../dist/config.js';

const base = { docs: { root: 'docs' } };

test('an application named only by url is refused, not quietly ignored', () => {
  assert.throws(
    () => parseConfig({ ...base, apps: [{ name: 'dashboard', url: 'http://localhost:3000' }] }),
    /path/,
  );
});

test('a running application is read alongside its source, not instead of it', () => {
  const config = parseConfig({
    ...base,
    apps: [{ name: 'dashboard', path: '.', url: 'http://localhost:3000', routes: ['/'] }],
  });
  assert.equal(config.apps[0]?.path, '.');
  assert.equal(config.apps[0]?.url, 'http://localhost:3000');
});

test('a setting that does not exist is an error', () => {
  assert.throws(() => parseConfig({ ...base, apps: [{ name: 'a', path: '.', prth: 'typo' }] }));
});

test('the check that finds what nothing documents runs unless it is turned off', () => {
  assert.notEqual(parseConfig(base).checks.undocumented, false);
  assert.equal(parseConfig({ ...base, checks: { undocumented: false } }).checks.undocumented, false);
});

test('naming a provider is enough to have it asked', () => {
  const on = parseConfig({ ...base, model: { baseUrl: 'https://api.example.test/v1', name: 'm' } });
  assert.equal(on.model?.enrich, true);
});

test('a provider can be kept and still not asked', () => {
  const off = parseConfig({
    ...base,
    model: { baseUrl: 'http://127.0.0.1:4000', name: 'm', enrich: false },
  });
  assert.equal(off.model?.enrich, false);
  assert.equal(off.model?.baseUrl, 'http://127.0.0.1:4000');
});

test('a provider wanting more than a bearer token can say so', () => {
  const c = parseConfig({
    ...base,
    model: {
      baseUrl: 'https://api.example.test/v1',
      name: 'm',
      headers: { 'anthropic-version': '2023-06-01' },
    },
  });
  assert.deepEqual(c.model?.headers, { 'anthropic-version': '2023-06-01' });
});

test('a key is named, never written down', () => {
  assert.throws(
    () => parseConfig({ ...base, model: { baseUrl: 'https://x.test/v1', name: 'm', apiKey: 'sk-real' } }),
    /apiKey/,
  );
});

test('a project names the instructions it keeps rather than having them guessed at', () => {
  const c = parseConfig({
    ...base,
    model: {
      baseUrl: 'https://x.test/v1',
      name: 'm',
      skills: ['docs/writing-style.md', 'docs/TERMS.md'],
    },
  });
  assert.deepEqual(c.model?.skills, ['docs/writing-style.md', 'docs/TERMS.md']);
  assert.deepEqual(parseConfig({ ...base, model: { baseUrl: 'https://x.test/v1', name: 'm' } }).model?.skills, []);
});

test('a check says for itself whether a model is asked about what it found', () => {
  const c = parseConfig({
    ...base,
    model: { baseUrl: 'https://x.test/v1', name: 'm' },
    checks: { links: { enrich: false }, undocumented: { enrich: true }, strings: {} },
  });
  assert.equal((c.checks.links as { enrich?: boolean }).enrich, false);
  assert.equal((c.checks.undocumented as { enrich?: boolean }).enrich, true);
  assert.equal((c.checks.strings as { enrich?: boolean }).enrich, undefined, 'silence inherits');
});

test('counting how much of a specification the prose covers is decided, not assumed', () => {
  assert.equal((parseConfig(base).checks.openapi as { coverage: string }).coverage, 'auto');
  assert.equal(
    (parseConfig({ ...base, checks: { openapi: { coverage: 'never' } } }).checks.openapi as { coverage: string })
      .coverage,
    'never',
  );
  assert.throws(() => parseConfig({ ...base, checks: { openapi: { coverage: 'sometimes' } } }));
});

test('a check says for itself whether a model is asked about what it found', () => {
  const c = parseConfig({
    ...base,
    model: { baseUrl: 'https://x.test/v1', name: 'm' },
    checks: { links: { enrich: false }, undocumented: { enrich: true }, strings: {} },
  });
  assert.equal((c.checks.links as { enrich?: boolean }).enrich, false, 'said here');
  assert.equal((c.checks.undocumented as { enrich?: boolean }).enrich, true, 'said here too');
  assert.equal((c.checks.strings as { enrich?: boolean }).enrich, undefined, 'silence inherits');
});

test('whether coverage is counted is decided, not assumed', () => {
  assert.equal((parseConfig(base).checks.openapi as { coverage: string }).coverage, 'auto');
  assert.equal(
    (parseConfig({ ...base, checks: { openapi: { coverage: 'always' } } }).checks.openapi as { coverage: string }).coverage,
    'always',
  );
  assert.throws(() => parseConfig({ ...base, checks: { openapi: { coverage: 'sometimes' } } }));
});

const tours = {
  targets: { local: { url: 'http://localhost:3000' } },
  accounts: {
    writer: {
      purpose: 'a user with notes',
      login: { script: './login.mjs' },
      confirm: 'text=Sign out',
    },
  },
  journeys: { write: { account: 'writer', steps: [{ goto: '/notes' }, { shot: { name: 'notes' } }] } },
};

test('a journey is shot at one desktop viewport at scale 2 unless it says otherwise', () => {
  const parsed = parseConfig({ ...base, tours });
  assert.deepEqual(parsed.tours?.journeys.write?.viewports, [
    { name: 'desktop', width: 1440, height: 900, scale: 2 },
  ]);
});

test('a tours setting that does not exist is an error, at any depth', () => {
  assert.throws(() => parseConfig({ ...base, tours: { ...tours, extra: true } }));
  assert.throws(() =>
    parseConfig({
      ...base,
      tours: { ...tours, accounts: { writer: { ...tours.accounts.writer, password: 'x' } } },
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      tours: { ...tours, journeys: { write: { account: 'writer', steps: [{ shot: { name: 'a', zoom: 2 } }] } } },
    }),
  );
});

test('a step does exactly one thing', () => {
  assert.throws(() =>
    parseConfig({
      ...base,
      tours: { ...tours, journeys: { write: { account: 'writer', steps: [{ goto: '/', click: 'a' }] } } },
    }),
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        tours: {
          ...tours,
          journeys: { write: { account: 'writer', steps: [{ fill: { selector: '#a', value: 'x', valueEnv: 'X' } }] } },
        },
      }),
    /exactly one of value or valueEnv/,
  );
});

test('a fresh account without a seed to make it is refused', () => {
  assert.throws(
    () =>
      parseConfig({
        ...base,
        tours: { ...tours, accounts: { writer: { ...tours.accounts.writer, fresh: true } } },
      }),
    /a fresh account needs a seed/,
  );
});

test('a journey signed in as an account that does not exist is refused', () => {
  assert.throws(
    () => parseConfig({ ...base, tours: { ...tours, journeys: { write: { account: 'nobody', steps: [{ goto: '/' }] } } } }),
    /no account is named nobody/,
  );
});

test('a journey is not recorded unless it asks, and record: true takes the default pace', () => {
  assert.equal(parseConfig({ ...base, tours }).tours?.journeys.write?.record, false);
  const recorded = (record: unknown) =>
    parseConfig({
      ...base,
      tours: { ...tours, journeys: { write: { account: 'writer', record, steps: [{ goto: '/' }] } } },
    }).tours?.journeys.write?.record;
  assert.deepEqual(recorded(true), { typeMs: 70, moveMs: 500, holdMs: 700, cursor: true });
  assert.deepEqual(recorded({ holdMs: 0 }), { typeMs: 70, moveMs: 500, holdMs: 0, cursor: true });
  assert.throws(() => recorded({ fps: 60 }));
});

test('any step can carry a note, and there is no say step', () => {
  const steps = (list: unknown[]) =>
    parseConfig({
      ...base,
      tours: { ...tours, journeys: { write: { account: 'writer', steps: list } } },
    }).tours?.journeys.write?.steps;
  assert.deepEqual(steps([{ click: '#new', note: 'Start a note' }]), [{ click: '#new', note: 'Start a note' }]);
  assert.equal((steps([{ note: 'Notes', shot: { name: 'a' } }])![0] as { note?: string }).note, 'Notes');
  assert.throws(() => steps([{ click: '#new', note: '' }]));
  assert.throws(() => steps([{ say: 'Here are your notes' }]));
  assert.throws(() => steps([{ note: 'Only a note' }]));
});
