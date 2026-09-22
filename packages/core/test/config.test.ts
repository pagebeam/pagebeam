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
