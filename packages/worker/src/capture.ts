import { chromium, errors, type Browser, type BrowserContext } from 'playwright-core';
import { browserPath } from '@pagebeam/app';
import { ForwardProxy } from './proxy.js';
import { CaptureFailure, type CaptureResult, type Job } from './types.js';

export class CaptureWorker {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;
  constructor(private proxy: ForwardProxy, private executablePath?: string) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= (async () => {
      const executablePath = await browserPath(this.executablePath ?? process.env.CHROME_PATH);
      if (!executablePath) throw new CaptureFailure('navigation_failed');
      this.browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true,
        // The worker drains accepted jobs before closing the shared browser.
        handleSIGTERM: false, handleSIGINT: false, args: [
        `--proxy-server=${this.proxy.url}`, '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic',
      ] });
      return this.browser;
    })().finally(() => { this.launching = undefined; });
    return this.launching;
  }

  async capture(job: Job): Promise<CaptureResult> {
    const id = this.proxy.register();
    let context: BrowserContext | undefined;
    let expired = false;
    let privateNavigation = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; void context?.close().catch(() => {}); reject(new CaptureFailure('timeout')); }, 45_000);
    });
    const run = async (): Promise<CaptureResult> => {
      const browser = await this.getBrowser();
      if (expired) throw new CaptureFailure('timeout');
      context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
        proxy: { server: this.proxy.url, bypass: '<-loopback>', username: id, password: id } });
      if (expired) { await context.close(); throw new CaptureFailure('timeout'); }
      const page = await context.newPage();
      context.on('page', extra => { if (extra !== page) void extra.close(); });
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame() && frame.url() !== 'about:blank' && !/^https?:/.test(frame.url())) {
          privateNavigation = true; void page.close();
        }
      });
      page.on('requestfailed', request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          const url = new URL(request.url());
          if (this.proxy.refused(id, url.href) || url.protocol === 'https:' && this.proxy.refused(id, url.origin)) privateNavigation = true;
        }
      });
      page.on('response', response => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame() && response.status() === 403 && this.proxy.refused(id, request.url())) privateNavigation = true;
      });
      page.on('download', download => { void download.cancel(); });
      await context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            const url = new URL(request.url());
            await this.proxy.check(url);
          } catch (error) {
            if (error instanceof CaptureFailure) privateNavigation = true;
            await route.abort(); return;
          }
        }
        await route.continue();
      });
      const images: CaptureResult['images'] = [];
      for (const viewport of job.viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: false });
        const deadline = Date.now() + 20_000;
        const remaining = () => Math.max(1, deadline - Date.now());
        const url = new URL(job.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CaptureFailure('private_address');
        await page.goto(job.url, { waitUntil: ['load', 'networkidle'].includes(job.waitFor) ? 'load' : 'domcontentloaded', timeout: remaining() });
        if (job.waitFor === 'networkidle') {
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(error => {
            if (!(error instanceof errors.TimeoutError)) throw error;
          });
        }
        if (!['load', 'networkidle'].includes(job.waitFor)) await page.locator(job.waitFor).first().waitFor({ state: 'visible', timeout: remaining() });
        if (privateNavigation) throw new CaptureFailure('private_address');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: false });
        if (job.fullPage) {
          await page.evaluate(async () => {
            for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 16384); y += Math.max(innerHeight, 320)) {
              scrollTo(0, y); await new Promise(resolve => setTimeout(resolve, 50));
            }
            scrollTo(0, 0);
          });
        }
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
        await page.evaluate(async () => { await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        const height = job.fullPage ? await page.evaluate(() => Math.min(16384, Math.max(innerHeight, document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))) : viewport.height;
        const shot = await cdp.send('Page.captureScreenshot', { format: job.format, ...(job.format === 'jpeg' ? { quality: 85 } : {}),
          clip: { x: 0, y: 0, width: viewport.width, height, scale: 1 }, captureBeyondViewport: true });
        const bytes = Buffer.from(shot.data, 'base64');
        if (privateNavigation) throw new CaptureFailure('private_address');
        await cdp.detach();
        images.push({ viewport: viewport.name, width: viewport.width * viewport.scale, height: height * viewport.scale, bytes });
      }
      return { takenAt: new Date().toISOString(), images };
    };
    try { return await Promise.race([run(), timeout]); }
    catch (error) {
      if (privateNavigation) throw new CaptureFailure('private_address');
      if (error instanceof CaptureFailure) throw error;
      throw new CaptureFailure(expired || error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'navigation_failed');
    } finally {
      clearTimeout(timer); await context?.close().catch(() => {}); this.proxy.release(id);
    }
  }

  async close(): Promise<void> { await this.browser?.close(); }
}

export async function capture(job: Job): Promise<CaptureResult> {
  const proxy = await ForwardProxy.start();
  const worker = new CaptureWorker(proxy);
  try { return await worker.capture(job); } finally { await worker.close(); await proxy.close(); }
}
