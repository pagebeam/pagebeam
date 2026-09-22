import assert from 'node:assert/strict';
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
