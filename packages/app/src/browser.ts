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

export type Engine = 'chromium' | 'firefox';

// Installs the Firefox build matching the playwright-core that will launch it.
export async function installFirefox(): Promise<void> {
  const { createRequire } = await import('node:module');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const nodePath = await import('node:path');
  const manifest = createRequire(import.meta.url).resolve('playwright-core/package.json');
  const cli = nodePath.join(nodePath.dirname(manifest), 'cli.js');
  const deps = process.env.PAGEBEAM_INSTALL_BROWSER_DEPS === '1' ? ['--with-deps'] : [];
  await promisify(execFile)(process.execPath, [cli, 'install', ...deps, 'firefox'], { maxBuffer: 64 * 1024 * 1024 });
}

export async function launchBrowser(
  executablePath?: string,
  engine: Engine = 'chromium',
  install: () => Promise<void> = installFirefox,
): Promise<Browser | Unavailable> {
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    return { reason: 'playwright-core is not installed' };
  }
  if (engine === 'firefox') {
    // Playwright drives a patched Firefox build; a stock Firefox install cannot be controlled.
    const { access } = await import('node:fs/promises');
    const found = executablePath ?? playwright.firefox.executablePath();
    const exists = () => access(found).then(() => true, () => false);
    let ok = await exists();
    if (!ok && executablePath === undefined && process.env.PAGEBEAM_INSTALL_BROWSERS === '1') {
      try {
        await install();
      } catch (error) {
        return { reason: `Playwright Firefox could not be installed: ${(error as Error).message}` };
      }
      ok = await exists();
    }
    if (!ok) return { reason: 'no Playwright Firefox was found to drive (run npx playwright install firefox)' };
    return playwright.firefox.launch({ executablePath: found, headless: true });
  }
  const found = await browserPath(executablePath);
  if (found === undefined) {
    return { reason: 'no browser was found to drive' };
  }
  return playwright.chromium.launch({ executablePath: found, headless: true, args: ['--disable-font-subpixel-positioning'] });
}

export async function isShown(page: Page, selector: string, timeout: number): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}
