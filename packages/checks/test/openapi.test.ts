import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCitations, checkCoverage, citations, readSpec, templatise } from '../src/openapi.ts';
import { parseAll, type DocPage } from '@pagebeam/docs';

const page = (prose: string): DocPage => ({
  path: 'a.md', format: 'markdown', raw: prose, prose, links: [], codeSpans: [],
  codeBlocks: [], emphasised: [], directives: [], slug: null,
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
    ['api'],
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
    ['api'],
  );
  assert.deepEqual(findings, [], 'DELETE /users/7 is DELETE /users/{key}');
});

test('an operation the site serves is documented, whatever named it', () => {
  const ops = [{ method: 'GET', path: '/api/v1/wallets' }, { method: 'GET', path: '/api/v1/gone' }];
  const served = new Set(['GET /api/v1/wallets']);
  const findings = checkCoverage([], ops as never, 'spec.json', 'api', served);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /1 of 2/);
});

test('with nothing served, the source pages are all there is to go on', () => {
  const ops = [{ method: 'GET', path: '/api/v1/wallets' }];
  assert.equal(checkCoverage([], ops as never, 'spec.json', 'api', null).length, 1);
  assert.equal(checkCoverage([], ops as never, 'spec.json', 'api', new Set(['GET /api/v1/wallets'])).length, 0);
});

// A commit's owner decides whose work a later run may replace. A name that is
// really a list of names belongs to no application, so anything counting
// ownership reads it as somebody else's and keeps it for ever.
test('one specification owns its finding', () => {
  const found = checkCitations(
    [{ method: 'DELETE', path: '/users', page: 'a.md', line: 1 }],
    [{ method: 'GET', path: '/users' }],
    ['api'],
  );
  assert.equal(found[0]?.app, 'api');
});

test('an operation absent from all of them together belongs to none of them', () => {
  const found = checkCitations(
    [{ method: 'DELETE', path: '/users', page: 'a.md', line: 1 }],
    [{ method: 'GET', path: '/users' }],
    ['api', 'admin'],
  );
  assert.equal(found[0]?.app, undefined, 'no application owns it');
  assert.match(found[0]!.title, /api, admin/, 'and a reader is still told which were checked');
});

test('a path shown by the site with one method does not cover another', () => {
  const ops = [{ method: 'GET', path: '/users' }, { method: 'DELETE', path: '/users' }];
  const findings = checkCoverage([], ops as never, 'spec.json', 'api', new Set(['GET /users']));
  assert.match(findings[0]!.title, /1 of 2/);
});

test('TRACE is an operation like any other', async () => {
  const file = await spec('trace.json', JSON.stringify({ paths: { '/echo': { trace: {} } } }));
  const { operations } = await readSpec(file);
  assert.deepEqual(operations.map((o) => `${o.method} ${o.path}`), ['TRACE /echo']);
});

test('a citation says the line it is on', async () => {
  const pages = await parseAll('', ['a.md'], async () => '# API\n\nSome text.\n\nDELETE /users removes one.\n');
  const findings = checkCitations(citations(pages), [{ method: 'GET', path: '/users' }], ['api']);
  assert.equal(findings[0]!.doc.line, 5);
});

test('frontmatter, comments and imports are not documentation', async () => {
  const text = '---\nnote: GET /secret\n---\n{/* DELETE /hidden */}\nVisible prose. Call GET /users here.\n';
  const found = citations(await parseAll('', ['a.mdx'], async () => text));
  assert.deepEqual(found.map((c) => `${c.method} ${c.path}:${c.line}`), ['GET /users:5']);
});

test('API operations shown in HTML or stated by a component are citations', async () => {
  const pages = await parseAll('', ['a.md', 'b.mdx'], async (file) =>
    file === 'a.md'
      ? 'Intro\n\n<p>Use <code>GET /users</code> to list users.</p>\n\n<script>run("DELETE /x")</script>\n'
      : '# Ref\n\n<ApiOperation method="GET" path="/users" />\n\n<Card title="POST /nope" />\n',
  );
  assert.deepEqual(
    citations(pages).map((c) => `${c.page} ${c.method} ${c.path}:${c.line}`),
    ['a.md GET /users:3', 'b.mdx GET /users:3'],
  );
});
