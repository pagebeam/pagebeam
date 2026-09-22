import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCitations, checkCoverage, readSpec, templatise } from '../src/openapi.ts';
import type { DocPage } from '@pagebeam/docs';

const page = (prose: string): DocPage => ({
  path: 'a.md', format: 'markdown', raw: '', prose, links: [], codeSpans: [],
  codeBlocks: [], emphasised: [], directives: [],
});

async function spec(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-oa-'));
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

test('a method is part of an operation, not decoration', () => {
  const ops = [{ method: 'GET', path: '/users' }, { method: 'POST', path: '/users' }];
  const findings = checkCoverage([page('GET /users')], ops, 's', 'api');
  assert.equal(findings.length, 1, 'POST /users is not documented by writing GET /users');
  assert.match(findings[0]!.title, /1 of 2/);
});

test('a worked example stands for the templated path', () => {
  assert.equal(templatise('/users/123', [{ method: 'GET', path: '/users/{id}' }]), '/users/{id}');
  assert.equal(templatise('/health', [{ method: 'GET', path: '/health' }]), '/health');
});

test('a documented endpoint the specification lacks is reported', () => {
  const findings = checkCitations(
    [{ method: 'DELETE', path: '/users', page: 'a.md', line: 1 }],
    [{ method: 'GET', path: '/users' }],
    'api',
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /DELETE \/users/);
});

test('a specification may be YAML', async () => {
  const file = await spec('s.yaml', 'openapi: 3.1.0\npaths:\n  /health:\n    get: {}\n');
  const { operations } = await readSpec(file);
  assert.deepEqual(operations.map((o) => `${o.method} ${o.path}`), ['GET /health']);
});

test('a path item referenced inside the document is followed', async () => {
  const file = await spec(
    's.yaml',
    "openapi: 3.1.0\npaths:\n  /users:\n    $ref: '#/components/pathItems/u'\ncomponents:\n  pathItems:\n    u:\n      get: {}\n      post: {}\n",
  );
  const { operations, unresolved } = await readSpec(file);
  assert.deepEqual(operations.map((o) => o.method).sort(), ['GET', 'POST']);
  assert.deepEqual(unresolved, []);
});

test('a reference outside the document is reported, not silently dropped', async () => {
  const file = await spec('s.yaml', "openapi: 3.1.0\npaths:\n  /u:\n    $ref: './other.yaml#/x'\n");
  const { operations, unresolved } = await readSpec(file);
  assert.deepEqual(operations, []);
  assert.equal(unresolved.length, 1);
});

test('a worked example resolves against its own method', () => {
  const ops = [
    { method: 'GET', path: '/users/{id}' },
    { method: 'DELETE', path: '/users/{key}' },
  ];
  assert.equal(templatise('/users/7', ops, 'DELETE'), '/users/{key}');
  assert.equal(templatise('/users/7', ops, 'GET'), '/users/{id}');
});

test('an endpoint documented with a concrete value is not called absent', () => {
  const ops = [
    { method: 'GET', path: '/users/{id}' },
    { method: 'DELETE', path: '/users/{key}' },
  ];
  const findings = checkCitations(
    [{ method: 'DELETE', path: '/users/7', page: 'a.md', line: 1 }],
    ops,
    'api',
  );
  assert.deepEqual(findings, [], 'DELETE /users/7 is DELETE /users/{key}');
});

test('an operation the site serves is documented, whatever named it', () => {
  const ops = [{ method: 'GET', path: '/api/v1/wallets' }, { method: 'GET', path: '/api/v1/gone' }];
  const served = new Set(['/api/v1/wallets']);
  const findings = checkCoverage([], ops as never, 'spec.json', 'api', served);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /1 of 2/);
});

test('with nothing served, the source pages are all there is to go on', () => {
  const ops = [{ method: 'GET', path: '/api/v1/wallets' }];
  assert.equal(checkCoverage([], ops as never, 'spec.json', 'api', null).length, 1);
  assert.equal(checkCoverage([], ops as never, 'spec.json', 'api', new Set(['/api/v1/wallets'])).length, 0);
});
