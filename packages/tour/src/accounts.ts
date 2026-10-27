import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { moduleDefault } from '@pagebeam/app';
import type { TourAccount, TourRequirement } from '@pagebeam/core';

// A live site can keep a connection open for as long as the page is, so the
// network never goes idle: wait for the load, then briefly for quiet.
const QUIET_MS = 5000;

export async function settle(page: Page, timeout: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, QUIET_MS) }).catch(() => undefined);
}

export async function open(page: Page, url: string, timeout: number): Promise<void> {
  await page.goto(url, { waitUntil: 'load', timeout });
  await settle(page, timeout);
}

const exec = promisify(execFile);

export class TourFailure extends Error {
  constructor(message: string, readonly stage = 'sign-in') { super(message); }
}

// What was asked for cannot be run as configured, before anything was opened.
export class TourUsage extends TourFailure {}

export interface Target {
  name: string;
  url: string;
}

export interface Credentials {
  username: string;
  password: string;
}

function local(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
}

export function seedRunsOn(account: TourAccount, target: Target): boolean {
  if (account.seed === undefined) return false;
  if (account.seed.targets !== undefined) return account.seed.targets.includes(target.name);
  return local(target.url);
}

function seedAdvice(account: TourAccount, target: Target): string {
  if (account.seed === undefined) return 'No seed is configured for this account.';
  if (!seedRunsOn(account, target)) {
    return `Its seed does not run on ${target.name}, so prepare the account there by hand.`;
  }
  return `Run the seed: ${account.seed.command}`;
}

// The seed prints the new user as JSON, {"username": "...", "password": "..."},
// on the last line of its output. Anything printed before that is its own.
async function seed(name: string, account: TourAccount, target: Target, cwd: string, env: NodeJS.ProcessEnv, timeout: number, safeErrors = false): Promise<Credentials> {
  const command = account.seed!.command;
  if (!seedRunsOn(account, target)) {
    throw new TourFailure(
      `account "${name}" is fresh, but its seed may not run on target "${target.name}". ` +
        'List the target under seed.targets if it should.',
    );
  }
  let stdout: string;
  try {
    const executable = typeof command === 'string' ? 'sh' : command[0]!;
    const args = typeof command === 'string' ? ['-c', command] : command.slice(1);
    ({ stdout } = await exec(executable, args, {
      cwd: path.resolve(cwd, account.seed!.cwd ?? '.'),
      env: { ...env, PAGEBEAM_TARGET: target.name, PAGEBEAM_TARGET_URL: target.url },
      maxBuffer: 1 << 24,
      timeout,
      killSignal: 'SIGKILL',
    }));
  } catch (error) {
    if (safeErrors) throw new TourFailure(`the seed for account "${name}" failed`, 'account-preparation');
    const e = error as { stderr?: string; message: string };
    const said = (e.stderr ?? '').trim().split('\n').at(-1) || e.message.split('\n')[0];
    throw new TourFailure(`the seed for account "${name}" failed (${command}): ${said}`);
  }
  const last = stdout.trim().split('\n').at(-1) ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = undefined;
  }
  const made = parsed as Partial<Credentials> | undefined;
  if (typeof made?.username !== 'string' || typeof made.password !== 'string') {
    throw new TourFailure(
      `the seed for account "${name}" must print {"username": ..., "password": ...} as its last line (${command})`,
    );
  }
  return { username: made.username, password: made.password };
}

export function missingEnv(account: TourAccount, env: NodeJS.ProcessEnv = process.env): string[] {
  if (account.fresh) return [];
  return [account.login.usernameEnv, account.login.passwordEnv].filter(
    (name): name is string => name !== undefined && (env[name] ?? '') === '',
  );
}

function fromEnv(account: TourAccount, env: NodeJS.ProcessEnv): Credentials | undefined {
  const { usernameEnv, passwordEnv } = account.login;
  if (usernameEnv === undefined || passwordEnv === undefined) return undefined;
  return { username: env[usernameEnv] ?? '', password: env[passwordEnv] ?? '' };
}

function describe(check: TourRequirement): string {
  if ('request' in check) return `GET ${check.request} answers ${check.status}`;
  const where = check.goto === undefined ? '' : ` at ${check.goto}`;
  if ('count' in check) return `at least ${check.count.min} of ${check.count.selector}${where}`;
  return `"${check.text}" is shown${where}`;
}

async function unmet(page: Page, check: TourRequirement, base: string, timeout: number): Promise<string | null> {
  if ('request' in check) {
    const response = await page.request.get(new URL(check.request, base).href, { timeout });
    return response.status() === check.status ? null : `it answered ${response.status()}`;
  }
  if (check.goto !== undefined) {
    await open(page, new URL(check.goto, base).href, timeout);
  }
  if ('count' in check) {
    const { selector, min } = check.count;
    if (min > 0) {
      await page
        .locator(selector)
        .nth(min - 1)
        .waitFor({ state: 'attached', timeout })
        .catch(() => undefined);
    }
    const found = await page.locator(selector).count();
    return found >= min ? null : `found ${found}`;
  }
  const shown = await page
    .getByText(check.text)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  return shown ? null : 'it was not found';
}

export interface SignedIn {
  context: BrowserContext;
  credentials: Credentials | undefined;
}

export async function signIn(
  browser: Browser,
  name: string,
  account: TourAccount,
  target: Target,
  options: { cwd: string; timeout: number; scale: number; env?: NodeJS.ProcessEnv; safeErrors?: boolean; credentials?: (value: Credentials) => void; setup?: (context: BrowserContext) => Promise<void> },
): Promise<SignedIn> {
  const { cwd, timeout, scale } = options;
  const env = options.env ?? process.env;
  const credentials = account.fresh ? await seed(name, account, target, cwd, env, timeout, options.safeErrors) : fromEnv(account, env);
  if (credentials) options.credentials?.(credentials);
  const context = await browser.newContext({ deviceScaleFactor: scale });
  await options.setup?.(context);
  const page = await context.newPage();
  try {
    const form = account.login.form;
    if (form !== undefined) {
      if (credentials === undefined) {
        throw new TourFailure(`account "${name}" has a login form but no credentials`);
      }
      await open(page, new URL(form.url, target.url).href, timeout);
      await page.locator(form.username).first().fill(credentials.username, { timeout });
      await page.locator(form.password).first().fill(credentials.password, { timeout });
      await page.locator(form.submit).first().click({ timeout });
    } else {
      await open(page, target.url, timeout);
    }
    if (account.login.script !== undefined) {
      const script = await moduleDefault(path.resolve(cwd, account.login.script));
      await script(page, credentials, { env, target });
    }

    // Without this a login form that rejected the password is photographed as
    // if it were the product.
    const confirmed = await page
      .locator(account.confirm)
      .first()
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
    if (!confirmed) {
      throw new TourFailure(
        `account "${name}" did not sign in on target "${target.name}": ${account.confirm} never appeared`,
      );
    }

    for (const [i, check] of account.requires.entries()) {
      const why = await unmet(page, check, target.url, timeout);
      if (why === null) continue;
      throw new TourFailure(
        `account "${name}" is not ready on target "${target.name}": ` +
          `requirement ${i + 1} (${describe(check)}) failed, ${why}. ${seedAdvice(account, target)}`, 'account-readiness',
      );
    }
  } catch (error) {
    await context.close();
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
  return { context, credentials };
}
