import type { Label } from '@pagebeam/core';
import { html } from './html.js';

const DEFAULT_TIMEOUT = 15_000;
const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export interface RenderRequest {
  app: string;
  baseUrl: string;
  routes: string[];
  timeoutMs?: number | undefined;
  executablePath?: string | undefined;
}

export interface Rendered {
  labels: Label[];
  visited: string[];
  failed: { route: string; reason: string }[];
}

export type Unavailable = { reason: string };

async function browserPath(given?: string): Promise<string | undefined> {
  if (given !== undefined) return given;
  const { access } = await import('node:fs/promises');
  for (const candidate of CHROME_PATHS) {
    const ok = await access(candidate).then(
      () => true,
      () => false,
    );
    if (ok) return candidate;
  }
  return undefined;
}

// Reading a running application is the only way to see what a framework with
// no parser actually shows, and the only way to see a label a catalogue
// resolves at runtime. It sees the pages it is told to open and no others,
// which is why what it returns is never treated as a complete reading.
export async function render(request: RenderRequest): Promise<Rendered | Unavailable> {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return { reason: 'playwright-core is not installed' };
  }

  const executablePath = await browserPath(request.executablePath);
  if (executablePath === undefined) {
    return { reason: 'no browser was found to drive' };
  }

  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT;
  const browser = await chromium.launch({ executablePath, headless: true });
  const labels: Label[] = [];
  const visited: string[] = [];
  const failed: { route: string; reason: string }[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const route of request.routes) {
      const url = new URL(route, request.baseUrl).href;
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });
        const markup = await page.content();
        labels.push(...html.extract(markup, route));
        visited.push(route);
      } catch (error) {
        failed.push({ route, reason: (error as Error).message.split('\n')[0] ?? 'unreachable' });
      }
    }
  } finally {
    await browser.close();
  }
  return { labels, visited, failed };
}

export function unavailable(result: Rendered | Unavailable): result is Unavailable {
  return 'reason' in result;
}
