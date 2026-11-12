import { lookup } from 'node:dns/promises';
import { createServer, request } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { publicAddress } from './address.js';
import { CaptureFailure } from './types.js';

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export interface TestNetwork {
  resolve: Resolver;
  connectTo?: (address: string, port: number) => { host: string; port: number };
}

export class ForwardProxy {
  private server = createServer();
  private sockets = new Set<Socket>();
  private jobs = new Map<string, Set<string>>();
  url = '';
  private constructor(private network: TestNetwork) {}

  static async start(): Promise<ForwardProxy> {
    return this.create({ resolve: host => lookup(host, { all: true }) });
  }

  // Local routing overrides must never be available to production construction.
  static async forTest(network: TestNetwork): Promise<ForwardProxy> {
    if (!process.env.NODE_TEST_CONTEXT) throw new Error('Test network requires the Node test runner');
    return this.create(network);
  }

  private static async create(network: TestNetwork): Promise<ForwardProxy> {
    const proxy = new ForwardProxy(network);
    await proxy.listen();
    return proxy;
  }

  register(): string { const id = randomUUID(); this.jobs.set(id, new Set()); return id; }
  release(id: string): void { this.jobs.delete(id); }
  refused(id: string, host: string): boolean { return this.jobs.get(id)?.has(host) ?? false; }

  async check(url: URL): Promise<{ host: string; port: number }> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!['http:', 'https:'].includes(url.protocol) || ![80, 443].includes(port)) throw new CaptureFailure('private_address');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.network.resolve(host);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new CaptureFailure('private_address');
    const address = addresses[0]!.address;
    return this.network.connectTo?.(address, port) ?? { host: address, port };
  }

  private authenticate(header: string | undefined): string | undefined {
    if (!header?.startsWith('Basic ')) return undefined;
    const id = Buffer.from(header.slice(6), 'base64').toString().split(':')[0]!;
    return this.jobs.has(id) ? id : undefined;
  }

  private async listen(): Promise<void> {
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('request', (req, res) => {
      const id = this.authenticate(req.headers['proxy-authorization']);
      if (!id) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="capture"' }).end(); return; }
      let url: URL;
      try { url = new URL(req.url!); } catch { res.writeHead(400).end(); return; }
      void this.check(url).then(target => {
        const headers = { ...req.headers };
        delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const upstream = request({ ...target, method: req.method, path: url.pathname + url.search, headers }, response => {
          res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
        });
        upstream.setTimeout(20_000, () => upstream.destroy());
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        res.on('close', () => upstream.destroy()); req.pipe(upstream);
      }).catch(error => {
        if (error instanceof CaptureFailure) this.jobs.get(id)?.add(url.href);
        res.writeHead(403).end();
      });
    });
    this.server.on('connect', (req, socket, head) => {
      const id = this.authenticate(req.headers['proxy-authorization']);
      if (!id) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="capture"\r\n\r\n'); return; }
      let url: URL;
      try { url = new URL(`https://${req.url}`); } catch { socket.destroy(); return; }
      void this.check(url).then(target => {
        const upstream = connect(target);
        this.sockets.add(upstream); upstream.on('close', () => this.sockets.delete(upstream));
        upstream.setTimeout(20_000, () => upstream.destroy());
        upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
        upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
      }).catch(error => {
        if (error instanceof CaptureFailure) this.jobs.get(id)?.add(url.origin);
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
    });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy failed to bind');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
