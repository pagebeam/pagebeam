import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { render, unavailable } from '../dist/index.js';

const PAGE = `<!doctype html><html><body>
  <button>Declared in the markup</button>
  <div id="later"></div>
  <script>
    document.getElementById('later').innerHTML =
      '<button aria-label="Close the dialog">Injected after load</button>';
  </script>
</body></html>`;

async function serve(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a control that only exists once javascript has run is still read', async (t) => {
  const site = await serve();
  try {
    const result = await render({ app: 'demo', baseUrl: site.url, routes: ['/'] });
    if (unavailable(result)) {
      t.skip(`no browser to drive: ${result.reason}`);
      return;
    }
    const texts = result.labels.map((l) => l.text);
    assert.ok(texts.includes('Declared in the markup'), 'markup labels');
    assert.ok(
      texts.includes('Injected after load'),
      'this is the whole point: no parser can see this',
    );
    assert.ok(
      result.labels.some((l) => l.text === 'Close the dialog' && l.kind.endsWith('@aria-label')),
      'accessible names survive',
    );
    assert.deepEqual(result.visited, ['/']);
    assert.deepEqual(result.failed, []);
  } finally {
    await site.stop();
  }
});

test('a route that does not answer is reported, not silently dropped', async (t) => {
  const result = await render({
    app: 'demo',
    baseUrl: 'http://127.0.0.1:1',
    routes: ['/nope'],
    timeoutMs: 2000,
  });
  if (unavailable(result)) {
    t.skip(`no browser to drive: ${result.reason}`);
    return;
  }
  assert.deepEqual(result.visited, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.route, '/nope');
});

test('labels are attributed to the route that showed them', async (t) => {
  const site = await serve();
  try {
    const result = await render({ app: 'demo', baseUrl: site.url, routes: ['/settings'] });
    if (unavailable(result)) {
      t.skip(`no browser to drive: ${result.reason}`);
      return;
    }
    assert.ok(result.labels.every((l) => l.file === '/settings'));
  } finally {
    await site.stop();
  }
});

const GUARDED = (authed: boolean): string =>
  authed
    ? '<!doctype html><body><button>Create a report</button><a>Sign out</a></body>'
    : '<!doctype html><body><button>Sign in</button></body>';

async function guarded(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const authed = (req.headers.cookie ?? '').includes('session=');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(GUARDED(authed));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  const port = typeof a === 'object' && a !== null ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a login screen standing in for every page is refused, not harvested', async (t) => {
  const site = await guarded();
  try {
    const result = await render({
      app: 'd',
      baseUrl: site.url,
      routes: ['/dashboard', '/settings'],
      auth: { confirm: 'text=Sign out' },
    });
    if (!unavailable(result)) {
      assert.fail(`expected a refusal, got ${JSON.stringify(result.labels.map((l) => l.text))}`);
    }
    assert.match(result.reason, /signed-in check/);
  } finally {
    await site.stop();
  }
});

test('signing in is confirmed before anything is read', async (t) => {
  const site = await guarded();
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-login-'));
  const script = path.join(dir, 'login.mjs');
  await writeFile(
    script,
    'export default async (page) => {\n' +
      '  await page.context().addCookies([{ name: "session", value: "1", url: page.url() }]);\n' +
      '};\n',
  );
  try {
    const result = await render({
      app: 'd',
      baseUrl: site.url,
      routes: ['/dashboard'],
      auth: { script, confirm: 'text=Sign out' },
    });
    if (unavailable(result)) {
      t.skip(`no browser to drive: ${result.reason}`);
      return;
    }
    assert.ok(result.labels.some((l) => l.text === 'Create a report'), 'the real page was read');
    assert.ok(!result.labels.some((l) => l.text === 'Sign in'), 'not the login screen');
  } finally {
    await site.stop();
  }
});

test('signing in with no way to confirm it is refused', async () => {
  const result = await render({
    app: 'd',
    baseUrl: 'http://127.0.0.1:1',
    routes: ['/'],
    auth: { storageState: '/nowhere.json' },
  });
  assert.ok(unavailable(result));
  assert.match(result.reason, /confirm it worked/);
});

test('a page that drops out of the session is not read as the product', async (t) => {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    // The first page is signed in; the second has been bounced to sign-in.
    const signedIn = hits === 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      signedIn
        ? '<!doctype html><body><button>Create a report</button><a>Sign out</a></body>'
        : '<!doctype html><body><button>Sign in</button></body>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  const port = typeof a === 'object' && a !== null ? a.port : 0;
  try {
    const result = await render({
      app: 'd',
      baseUrl: `http://127.0.0.1:${port}`,
      routes: ['/one', '/two'],
      auth: { confirm: 'text=Sign out' },
    });
    if (unavailable(result)) {
      t.skip(`no browser to drive: ${result.reason}`);
      return;
    }
    assert.deepEqual(result.visited, ['/one']);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]!.reason, /not signed in/);
    assert.ok(!result.labels.some((l) => l.text === 'Sign in'), 'the login form was not harvested');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
