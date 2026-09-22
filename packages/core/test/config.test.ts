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
