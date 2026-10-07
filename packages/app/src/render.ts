import type { Label } from '@pagebeam/core';
import { html } from './html.js';
import {
  discardSession,
  isShown,
  launchBrowser,
  moduleDefault,
  sessionFile,
  unavailable,
  type Unavailable,
} from './browser.js';

const DEFAULT_TIMEOUT = 15_000;

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

  const browser = await launchBrowser(request.executablePath);
  if (unavailable(browser)) return browser;

  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT;
  const auth = request.auth;
  let credentials: string | null = null;
  const labels: Label[] = [];
  const visited: string[] = [];
  const failed: { route: string; reason: string }[] = [];

  try {
    const saved = auth === undefined ? undefined : await sessionFile(auth);
    const storageState = saved?.file;
    if (saved?.written === true && storageState !== undefined) credentials = storageState;
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();

    if (auth?.script !== undefined) {
      const signIn = await moduleDefault(auth.script);
      await page.goto(request.baseUrl, { waitUntil: 'networkidle', timeout });
      await signIn(page);
    }

    for (const entry of request.routes) {
      const route = typeof entry === 'string' ? { path: entry } : entry;
      const url = new URL(route.path, request.baseUrl).href;
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });

        // Checked on arrival at every page, not once at the start. A session
        // expires, and one route in ten may be the one that demands a
        // stronger sign-in; reading the login form as if it were the product
        // is worse than not reading the page at all.
        if (auth?.confirm !== undefined) {
          const present = await isShown(page, auth.confirm, timeout);
          if (!present) {
            if (visited.length === 0) {
              return {
                reason: `signed-in check ${auth.confirm} was not found, so nothing was read`,
              };
            }
            failed.push({ route: route.path, reason: 'this page was not signed in' });
            continue;
          }
        }

        if (route.prepare !== undefined) await (await moduleDefault(route.prepare))(page);
        const markup = await page.content();
        labels.push(
          ...html.extract(markup, route.path).map((l) => ({ ...l, from: 'rendered' as const })),
        );
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
    // A saved session is a credential. It does not outlive the run.
    if (credentials !== null) await discardSession(credentials);
  }
  return { labels, visited, failed };
}
