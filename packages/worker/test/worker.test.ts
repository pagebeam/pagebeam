import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { browserPath } from '@pagebeam/app';
import { publicAddress } from '../dist/address.js';
import { ForwardProxy } from '../dist/proxy.js';
import { CaptureWorker } from '../dist/capture.js';
import { runWorker, workerLoop } from '../dist/loop.js';
import type { Job } from '../dist/types.js';

const refused = [
  '0.0.0.0', '0.2.3.4', '10.1.2.3', '127.0.0.1', '127.255.255.255',
  '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  '100.64.0.1', '100.127.255.255', '224.0.0.1', '239.255.255.255', '240.1.1.1', '255.255.255.255',
  '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
  '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fdff::1', 'ff02::1', '2001:db8::1', '3fff::1',
  '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1', '::a9fe:a9fe',
  '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001::1', 'not-an-ip',
];
test('public address policy denies special ranges and embedded private IPv4', () => {
  for (const ip of refused) assert.equal(publicAddress(ip), false, ip);
  for (const ip of refused.filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip))) {
    for (const prefix of ['::ffff:', '::', '64:ff9b::']) assert.equal(publicAddress(prefix + ip), false, prefix + ip);
  }
  for (const ip of ['1.1.1.1', '2606:4700:4700::1111', '::ffff:1.1.1.1', '::101:101', '64:ff9b::101:101']) assert.equal(publicAddress(ip), true, ip);
});

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, url: `http://127.0.0.1:${address.port}`, close: async () => {
    instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve()));
  } };
}
function job(url: string, extra: Partial<Job> = {}): Job {
  return { id: 'capture', url, viewports: [{ name: '400x320', width: 400, height: 320, scale: 1 }],
    fullPage: false, waitFor: 'load', format: 'png', uploads: {}, ...extra };
}

async function fixture() {
  let privateHits = 0;
  let pollHits = 0;
  const site = await server((req, res) => {
    if (req.url === '/poll') { pollHits++; res.end('ok'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end(); return; }
    if (req.url === '/private') privateHits++;
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/polling' ? '<h1>polling</h1><script>setInterval(() => fetch("/poll"), 200)</script>' :
      req.url === '/long' ? '<body style="margin:0;height:19000px;background:red">long</body>' :
      req.url === '/subresource' ? '<h1>public</h1><img src="http://127.0.0.1/private"><img src="http://capture.test:8080/private">' : '<h1 id="ready">hello</h1>');
  });
  const proxy = await ForwardProxy.forTest({
    resolve: async host => [{ address: host === 'capture.test' ? '1.1.1.1' : '127.0.0.1', family: 4 }],
    connectTo: () => ({ host: '127.0.0.1', port: site.port }),
  });
  const worker = new CaptureWorker(proxy);
  return { site, proxy, worker, privateHits: () => privateHits, pollHits: () => pollHits,
    close: async () => { await worker.close(); await proxy.close(); await site.close(); } };
}

const chrome = await browserPath(process.env.CHROME_PATH);
const browserTest = { skip: chrome ? false : 'No Chrome executable exists (browserPath); real browser capture tests skipped' };

test('networkidle captures a page that keeps polling within the job budget', { ...browserTest, timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const started = Date.now();
    const result = await f.worker.capture(job('http://capture.test/polling', { waitFor: 'networkidle' }));
    assert.ok(Date.now() - started < 45_000);
    assert.ok(f.pollHits() >= 20);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]!.bytes.readUInt32BE(16), 400);
    assert.equal(result.images[0]!.bytes.readUInt32BE(20), 320);
  } finally { await f.close(); }
});

test('Chrome blocks private navigations, redirect hops, and nonstandard ports', browserTest, async () => {
  const f = await fixture();
  try {
    for (const url of [`http://127.0.0.1:${f.site.port}`, `http://localhost:${f.site.port}`, 'http://private.test',
      'http://capture.test/redirect', 'http://capture.test:8080', 'http://127.0.0.1', 'http://localhost']) {
      await assert.rejects(f.worker.capture(job(url)), { reason: 'private_address' }, url);
    }
  } finally { await f.close(); }
});

test('proxy itself refuses private IPs, mixed DNS answers, and ports', async () => {
  const proxy = await ForwardProxy.forTest({ resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  const id = proxy.register();
  try {
    for (const url of ['http://127.0.0.1', 'http://localhost', 'http://capture.test', 'http://1.1.1.1:8080']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(proxy.url, { path: url, headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${id}:${id}`).toString('base64')}` } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403);
    }
  } finally { await proxy.close(); }
});

test('capture scales PNGs, emits JPEG, scrolls full pages, blocks private subresources', browserTest, async () => {
  const f = await fixture();
  try {
    const result = await f.worker.capture(job('http://capture.test', { waitFor: '#ready', viewports: [
      { name: '400x320', width: 400, height: 320, scale: 1 }, { name: '390x400@2', width: 390, height: 400, scale: 2 },
    ] }));
    assert.equal(result.images.length, 2);
    assert.ok(Number.isFinite(Date.parse(result.takenAt)));
    for (const image of result.images) {
      assert.equal(image.bytes.readUInt32BE(16), image.width);
      assert.equal(image.bytes.readUInt32BE(20), image.height);
    }
    const jpeg = await f.worker.capture(job('http://capture.test', { format: 'jpeg' }));
    assert.equal(jpeg.images[0]!.bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
    const long = await f.worker.capture(job('http://capture.test/long', { fullPage: true }));
    assert.equal(long.images[0]!.height, 16384);
    assert.equal(long.images[0]!.bytes.readUInt32BE(20), 16384);
    const subresource = await f.worker.capture(job('http://capture.test/subresource'));
    assert.equal(subresource.images.length, 1);
    assert.equal(f.privateHits(), 0);
  } finally { await f.close(); }
});

test('worker claims, uploads, completes and fails without leaking its token', browserTest, async () => {
  const f = await fixture();
  const controller = new AbortController();
  const uploaded = new Map<string, Buffer>();
  let uploadAuthorization: string | undefined;
  const uploads = await server((req, res) => {
    uploadAuthorization = req.headers.authorization;
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { uploaded.set(req.url!, Buffer.concat(chunks)); res.end(); });
  });
  let claimed = false;
  const completed: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const api = await server((req, res) => {
    try { assert.equal(req.headers.authorization, 'Bearer test-worker-token'); } catch (error) { errors.push(error); }
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (req.url === '/v1/worker/claim') {
        if (claimed) { res.writeHead(204).end(); return; }
        claimed = true; assert.equal(body.capacity, 2);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jobs: [job('http://capture.test', { id: 'good', uploads: {
          '400x320': { url: `${uploads.url}/image`, headers: { 'Content-Type': 'image/png', Authorization: 'Bearer test-worker-token' } },
        } }), job('http://127.0.0.1', { id: 'private' })] }));
      } else {
        if (req.url?.endsWith('/complete')) completed.push(body);
        else failures.push(body);
        res.end('{}');
        if (completed.length + failures.length === 2) controller.abort();
      }
    });
  });
  const watchdog = setTimeout(() => controller.abort(), 30_000);
  try {
    await workerLoop({ apiUrl: api.url, token: 'test-worker-token', signal: controller.signal }, f.worker);
    assert.deepEqual(errors, []);
    assert.equal(completed.length, 1); assert.equal(failures.length, 1);
    assert.equal(failures[0]!.reason, 'private_address');
    assert.equal(uploadAuthorization, undefined);
    const image = (completed[0]!.images as { bytes: number; sha256: string }[])[0]!;
    assert.equal(image.bytes, uploaded.get('/image')!.length);
    assert.equal(image.sha256, createHash('sha256').update(uploaded.get('/image')!).digest('hex'));
  } finally { clearTimeout(watchdog); await f.close(); await api.close(); await uploads.close(); }
});

test('CONNECT checks the tunnel destination and refuses private and nonstandard ports', async () => {
  const proxy = await ForwardProxy.forTest({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  const id = proxy.register();
  try {
    for (const authority of ['127.0.0.1:443', 'localhost:443', 'capture.test:443', '[::ffff:a9fe:a9fe]:443', '1.1.1.1:8080']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(proxy.url, { method: 'CONNECT', path: authority,
          headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${id}:${id}`).toString('base64')}` } });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403, authority);
    }
  } finally { await proxy.close(); }
});

test('production runWorker fails private jobs and stops claiming after abort', browserTest, async () => {
  const controller = new AbortController();
  let claims = 0;
  let failure: unknown;
  const api = await server((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/v1/worker/claim') {
        claims++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jobs: [job('http://127.0.0.1')] }));
      } else {
        failure = req.url;
        controller.abort(); res.end('{}');
      }
    });
  });
  const watchdog = setTimeout(() => controller.abort(), 10_000);
  try {
    await runWorker({ apiUrl: api.url, token: 'test-worker-token', capacity: 1, signal: controller.signal });
    assert.equal(failure, '/v1/worker/jobs/capture/fail');
    assert.equal(claims, 1);
  } finally { clearTimeout(watchdog); await api.close(); }
});

test('test routing cannot be constructed outside the Node test runner', async () => {
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(ForwardProxy.forTest({ resolve: async () => [] }), /requires the Node test runner/);
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
});

test('concurrent jobs use isolated proxy credentials and a disconnected browser relaunches', browserTest, async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([
      f.worker.capture(job('http://capture.test')),
      f.worker.capture(job('http://capture.test/subresource')),
    ]);
    assert.deepEqual(results.map(result => result.images.length), [1, 1]);
    await f.worker.close();
    assert.equal((await f.worker.capture(job('http://capture.test'))).images.length, 1);
  } finally { await f.close(); }
});

test('a DNS answer that changes after navigation preflight is blocked by the proxy', browserTest, async () => {
  let lookups = 0;
  const proxy = await ForwardProxy.forTest({ resolve: async host => {
    if (host !== 'rebind.test') return [{ address: '127.0.0.1', family: 4 }];
    return [{ address: ++lookups === 1 ? '1.1.1.1' : '127.0.0.1', family: 4 }];
  } });
  const worker = new CaptureWorker(proxy);
  try { await assert.rejects(worker.capture(job('http://rebind.test')), { reason: 'private_address' }); }
  finally { await worker.close(); await proxy.close(); }
});
