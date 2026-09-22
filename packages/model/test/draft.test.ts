import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { draft, systemFor } from '../dist/draft.js';
import { ask, Unanswered } from '../dist/client.js';
import type { Finding } from '@pagebeam/core';

const PAGE = 'Open the ledger.\n\nPress **Add transaction** to log a payment.\n\nThat is all.\n';

const finding = (): Finding => ({
  id: 'abc123', revision: 'r1', check: 'strings', standing: 'proven', severity: 'error',
  confidence: 1, app: 'ui',
  doc: { path: 'docs/guide.md' },
  title: '"Add transaction" was removed from ui',
  detail: 'It was a button in ui and is gone.',
  evidence: [{ kind: 'read', detail: 'labels were read from source', ref: { path: 'a.vue', line: 12 } }],
});

// Stands in for a router. What it is given matters as much as what it returns.
async function router(answer: string | number): Promise<{ url: string; seen: any[]; stop: () => Promise<void> }> {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, headers: req.headers, body: JSON.parse(body || '{}') });
      if (typeof answer === 'number') {
        res.writeHead(answer, { 'content-type': 'text/plain' });
        return res.end('no');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r as () => void));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, stop: () => new Promise((r) => server.close(() => r(undefined))) };
}

const CORRECTED = 'Open the ledger.\n\nPress **Record transaction** to log a payment.\n\nThat is all.';

test('a page nothing could mend comes back with a change to propose', async () => {
  const api = await router(CORRECTED);
  try {
    const out = await draft({ baseUrl: api.url, model: 'local' }, finding(), PAGE);
    assert.equal(out?.fix?.author, 'model', 'the fix says who wrote it');
    assert.equal(out?.fix?.changes[0]?.path, 'docs/guide.md');
    assert.match(String(out?.fix?.changes[0]?.contents), /Record transaction/);
  } finally {
    await api.stop();
  }
});

test('the request goes where it was pointed and carries no provider of its own', async () => {
  const api = await router(CORRECTED);
  try {
    await draft({ baseUrl: `${api.url}/`, model: 'qwen', apiKey: 'k' }, finding(), PAGE);
    assert.equal(api.seen[0].url, '/chat/completions', 'a trailing slash does not double up');
    assert.equal(api.seen[0].auth, 'Bearer k');
    assert.equal(api.seen[0].body.model, 'qwen');
    assert.equal(api.seen[0].body.temperature, 0);
  } finally {
    await api.stop();
  }
});

test('a router that wants no key is not sent an empty one', async () => {
  const api = await router(CORRECTED);
  try {
    await draft({ baseUrl: api.url, model: 'local' }, finding(), PAGE);
    assert.equal(api.seen[0].auth, undefined);
  } finally {
    await api.stop();
  }
});

test('a fence around the answer is not part of the page', async () => {
  const api = await router('```markdown\n' + CORRECTED + '\n```');
  try {
    const out = await draft({ baseUrl: api.url, model: 'local' }, finding(), PAGE);
    assert.ok(!String(out?.fix?.changes[0]?.contents).includes('```markdown'));
  } finally {
    await api.stop();
  }
});

test('a page that came back unchanged is not a correction', async () => {
  const api = await router(PAGE);
  try {
    assert.equal(await draft({ baseUrl: api.url, model: 'local' }, finding(), PAGE), null);
  } finally {
    await api.stop();
  }
});

test('a model that lost the page rather than edited it is refused', async () => {
  const api = await router('Press Record transaction.');
  try {
    assert.equal(await draft({ baseUrl: api.url, model: 'local' }, finding(), PAGE), null);
  } finally {
    await api.stop();
  }
});

test('a router that cannot answer leaves the finding as it was', async () => {
  const api = await router(500);
  try {
    assert.equal(await draft({ baseUrl: api.url, model: 'local' }, finding(), PAGE), null);
  } finally {
    await api.stop();
  }
});

test('a finding that already has an exact fix is not put to a model', async () => {
  const api = await router(CORRECTED);
  try {
    const exact: Finding = {
      ...finding(),
      fix: { kind: 'text-splice', author: 'deterministic', changes: [] },
    };
    const out = await draft({ baseUrl: api.url, model: 'local' }, exact, PAGE);
    assert.equal(out?.fix?.author, 'deterministic');
    assert.equal(api.seen.length, 0, 'the model was never asked');
  } finally {
    await api.stop();
  }
});

test('the same draft twice is the same revision, a different one is not', async () => {
  const a = await router(CORRECTED);
  const b = await router(CORRECTED + '\n\nAlso this.');
  try {
    const one = await draft({ baseUrl: a.url, model: 'local' }, finding(), PAGE);
    const again = await draft({ baseUrl: a.url, model: 'local' }, finding(), PAGE);
    const other = await draft({ baseUrl: b.url, model: 'local' }, finding(), PAGE);
    assert.equal(one?.revision, again?.revision, 'nothing is rewritten for the same answer');
    assert.notEqual(one?.revision, other?.revision, 'a new answer replaces the old commit');
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('a router that is not there is reported, not swallowed', async () => {
  await assert.rejects(
    ask({ baseUrl: 'http://127.0.0.1:1', model: 'local', timeoutMs: 2000 }, 's', 'u'),
    Unanswered,
  );
});

test('whatever the provider wants beyond a bearer token is sent as given', async () => {
  const api = await router(CORRECTED);
  try {
    await draft(
      { baseUrl: api.url, model: 'm', apiKey: 'k', headers: { 'x-project': 'p' } },
      finding(),
      PAGE,
    );
    assert.equal(api.seen[0].auth, 'Bearer k');
    assert.equal(api.seen[0].headers?.['x-project'] ?? 'missing', 'p');
  } finally {
    await api.stop();
  }
});

test('what a project keeps for its writers is given to the model', async () => {
  const api = await router(CORRECTED);
  try {
    await draft({ baseUrl: api.url, model: 'm' }, finding(), PAGE, [
      '--- docs/writing-style.md ---\nNever use an em dash. Say "is addressed".',
    ]);
    const system = api.seen[0].body.messages[0].content;
    assert.match(system, /Never use an em dash/, 'the project instruction reached the model');
    assert.match(system, /Do not invent behaviour/, 'and did not displace the contract');
    assert.ok(
      system.indexOf('Do not invent behaviour') < system.indexOf('Never use an em dash'),
      'the contract is stated before anything can qualify it',
    );
  } finally {
    await api.stop();
  }
});

test('no skills leaves the model told exactly what it was told before', async () => {
  const api = await router(CORRECTED);
  try {
    await draft({ baseUrl: api.url, model: 'm' }, finding(), PAGE, []);
    assert.equal(api.seen[0].body.messages[0].content, systemFor());
  } finally {
    await api.stop();
  }
});

test('evidence reaches the model as what it says, not as what it is', async () => {
  const api = await router(CORRECTED);
  try {
    await draft({ baseUrl: api.url, model: 'm' }, finding(), PAGE);
    const asked = api.seen[0].body.messages[1].content;
    assert.ok(!asked.includes('[object Object]'), 'an object run together as text says nothing');
    assert.match(asked, /read: labels were read from source \(a\.vue:12\)/);
  } finally {
    await api.stop();
  }
});
