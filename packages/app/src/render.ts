import type { Label } from '@pagebeam/core';
import { html } from './html.js';

const DEFAULT_TIMEOUT = 15_000;
const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export interface Route {
  path: string;
  // A module whose default export is given the page. Use it to open what the
  // route does not show on arrival: a drawer, a tab, a dialog.
  prepare?: string | undefined;
}

export interface Auth {
  // Playwright storage state, as a file or as base64 in an environment
  // variable. Credentials never pass through pagebeam.
  storageState?: string | undefined;
  storageStateEnv?: string | undefined;
  // A module whose default export is given a page and signs in on it.
  script?: string | undefined;
  // Something only a signed-in page has. Without it there is no way to tell a
  // dashboard from the login screen it redirected to.
  confirm?: string | undefined;
}

export interface RenderRequest {
  app: string;
  baseUrl: string;
  routes: (string | Route)[];
  auth?: Auth | undefined;
  timeoutMs?: number | undefined;
  executablePath?: string | undefined;
}

export interface Rendered {
  labels: Label[];
  visited: string[];
  failed: { route: string; reason: string }[];
}

async function moduleDefault(file: string): Promise<(page: unknown) => Promise<void>> {
  const url = new URL(`file://${file}`).href;
  const loaded = (await import(url)) as { default?: unknown };
  if (typeof loaded.default !== 'function') {
    throw new Error(`${file} must export a default function`);
  }
  return loaded.default as (page: unknown) => Promise<void>;
}

async function storageFrom(auth: Auth): Promise<string | undefined> {
  if (auth.storageStateEnv !== undefined) {
    const encoded = process.env[auth.storageStateEnv];
    if (encoded === undefined || encoded === '') {
      throw new Error(`${auth.storageStateEnv} is not set`);
    }
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'pagebeam-auth-'));
    const file = nodePath.join(dir, 'state.json');
    await writeFile(file, Buffer.from(encoded, 'base64').toString('utf8'));
    return file;
  }
  return auth.storageState;
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
  // Checked before a browser is started: a misconfiguration is not something
  // to discover halfway through reading an application.
  if (request.auth !== undefined && request.auth.confirm === undefined) {
    return { reason: 'signing in was configured without a way to confirm it worked' };
  }

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
  const auth = request.auth;
  const browser = await chromium.launch({ executablePath, headless: true });
  const labels: Label[] = [];
  const visited: string[] = [];
  const failed: { route: string; reason: string }[] = [];

  try {
    const storageState = auth === undefined ? undefined : await storageFrom(auth);
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();

    if (auth?.script !== undefined) {
      const signIn = await moduleDefault(auth.script);
      await page.goto(request.baseUrl, { waitUntil: 'networkidle', timeout });
      await signIn(page);
    }

    // Without this a dashboard that bounced every request to a login screen
    // looks like a dashboard whose every control has been deleted.
    if (auth?.confirm !== undefined) {
      const first = request.routes[0];
      const firstPath = typeof first === 'string' ? first : (first?.path ?? '/');
      await page.goto(new URL(firstPath, request.baseUrl).href, {
        waitUntil: 'networkidle',
        timeout,
      });
      const present = await page
        .locator(auth.confirm)
        .first()
        .isVisible({ timeout })
        .catch(() => false);
      if (!present) {
        return { reason: `signed-in check ${auth.confirm} was not found, so nothing was read` };
      }
    }

    for (const entry of request.routes) {
      const route = typeof entry === 'string' ? { path: entry } : entry;
      const url = new URL(route.path, request.baseUrl).href;
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });
        if (route.prepare !== undefined) await (await moduleDefault(route.prepare))(page);
        const markup = await page.content();
        labels.push(...html.extract(markup, route.path));
        visited.push(route.path);
      } catch (error) {
        failed.push({
          route: route.path,
          reason: (error as Error).message.split('\n')[0] ?? 'unreachable',
        });
      }
    }
  } catch (error) {
    return { reason: (error as Error).message.split('\n')[0] ?? 'the application could not be read' };
  } finally {
    await browser.close();
  }
  return { labels, visited, failed };
}

export function unavailable(result: Rendered | Unavailable): result is Unavailable {
  return 'reason' in result;
}
