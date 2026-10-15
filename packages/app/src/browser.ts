import type { Browser, Page } from 'playwright-core';

const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export type Unavailable = { reason: string };

export function unavailable<T extends object>(result: T | Unavailable): result is Unavailable {
  return 'reason' in result;
}

export async function moduleDefault(
  file: string,
): Promise<(page: unknown, ...rest: unknown[]) => Promise<void>> {
  const url = new URL(`file://${file}`).href;
  const loaded = (await import(url)) as { default?: unknown };
  if (typeof loaded.default !== 'function') {
    throw new Error(`${file} must export a default function`);
  }
  return loaded.default as (page: unknown, ...rest: unknown[]) => Promise<void>;
}

export interface SavedSession {
  storageState?: string | undefined;
  storageStateEnv?: string | undefined;
}

// Playwright storage state, as a file or as base64 in an environment variable.
// A file written from the environment is a credential: pass it to
// discardSession once the browser is closed.
export async function sessionFile(
  session: SavedSession,
): Promise<{ file: string | undefined; written: boolean }> {
  if (session.storageStateEnv !== undefined) {
    const encoded = process.env[session.storageStateEnv];
    if (encoded === undefined || encoded === '') {
      throw new Error(`${session.storageStateEnv} is not set`);
    }
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'pagebeam-auth-'));
    const file = nodePath.join(dir, 'state.json');
    await writeFile(file, Buffer.from(encoded, 'base64').toString('utf8'));
    return { file, written: true };
  }
  return { file: session.storageState, written: false };
}

export async function discardSession(file: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const nodePath = await import('node:path');
  await rm(nodePath.dirname(file), { recursive: true, force: true }).catch(() => undefined);
}

export async function browserPath(given?: string): Promise<string | undefined> {
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

export async function launchBrowser(executablePath?: string): Promise<Browser | Unavailable> {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return { reason: 'playwright-core is not installed' };
  }
  const found = await browserPath(executablePath);
  if (found === undefined) {
    return { reason: 'no browser was found to drive' };
  }
  return chromium.launch({ executablePath: found, headless: true });
}

export async function isShown(page: Page, selector: string, timeout: number): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}
