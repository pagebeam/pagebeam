import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { history, launchBrowser, unavailable, type Unavailable } from '@pagebeam/app';
import type { TourJourney, TourStep, Tours } from '@pagebeam/core';
import { missingEnv, open, settle, signIn, TourFailure, TourUsage, type Target } from './accounts.js';

export { TourFailure, TourUsage } from './accounts.js';

export interface ShootRequest {
  cwd: string;
  tours: Tours;
  target?: string | undefined;
  journey?: string | undefined;
  out?: string | undefined;
  executablePath?: string | undefined;
}

export interface FocusBox {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Shot {
  file: string;
  journey: string;
  step: number;
  name: string;
  caption?: string;
  account: string;
  url: string;
  viewport: { name: string; width: number; height: number; scale: number };
  focus: FocusBox[];
  sha: string | null;
}

export interface Manifest {
  target: string;
  url: string;
  journey: string;
  account: string;
  sha: string | null;
  takenAt: string;
  shots: Shot[];
}

export interface Shoot {
  target: string;
  manifests: { file: string; manifest: Manifest }[];
}

type Viewport = TourJourney['viewports'][number];

function pick(tours: Tours, request: ShootRequest): { target: Target; journeys: [string, TourJourney][] } {
  const targets = Object.keys(tours.targets);
  const name = request.target ?? (targets.includes('local') ? 'local' : targets[0]);
  const found = name === undefined ? undefined : tours.targets[name];
  if (name === undefined || found === undefined) {
    throw new TourUsage(
      targets.length === 0
        ? 'tours.targets names no target to shoot'
        : `no target is named ${name}. Targets: ${targets.join(', ')}`,
    );
  }
  let journeys = Object.entries(tours.journeys);
  if (request.journey !== undefined) {
    journeys = journeys.filter(([n]) => n === request.journey);
    if (journeys.length === 0) {
      throw new TourUsage(
        `no journey is named ${request.journey}. Journeys: ${Object.keys(tours.journeys).join(', ')}`,
      );
    }
  }
  if (journeys.length === 0) throw new TourUsage('tours.journeys names no journey to follow');
  return { target: { name, url: found.url }, journeys };
}

// Everything a run needs from the environment is asked for before a browser
// starts, so a missing variable is not found halfway through.
function checkEnv(tours: Tours, journeys: [string, TourJourney][]): void {
  const missing = new Set<string>();
  for (const [, journey] of journeys) {
    for (const env of missingEnv(tours.accounts[journey.account]!)) missing.add(env);
    for (const step of journey.steps) {
      const env = 'fill' in step ? step.fill.valueEnv : undefined;
      if (env !== undefined && (process.env[env] ?? '') === '') missing.add(env);
    }
  }
  if (missing.size > 0) throw new TourUsage(`not set: ${[...missing].join(', ')}`);
}

function said(step: TourStep): string {
  const [kind, value] = Object.entries(step)[0]!;
  if (typeof value === 'object' && value !== null) {
    const v = value as { selector?: string; name?: string };
    return `${kind} ${v.selector ?? v.name ?? ''}`.trim();
  }
  return `${kind} ${String(value)}`;
}

async function act(page: Page, step: TourStep, base: string, timeout: number): Promise<void> {
  if ('goto' in step) {
    await open(page, new URL(step.goto, base).href, timeout);
  } else if ('click' in step) {
    await page.locator(step.click).first().click({ timeout });
    await settle(page, timeout);
  } else if ('fill' in step) {
    const value = step.fill.value ?? process.env[step.fill.valueEnv!] ?? '';
    await page.locator(step.fill.selector).first().fill(value, { timeout });
  } else if ('select' in step) {
    await page.locator(step.select.selector).first().selectOption(step.select.value, { timeout });
  } else if ('wait' in step) {
    if (typeof step.wait === 'number') await page.waitForTimeout(step.wait);
    else await page.locator(step.wait).first().waitFor({ state: 'visible', timeout });
  } else if ('expect' in step) {
    const { selector, text } = step.expect;
    const located = page.locator(selector);
    await (text === undefined ? located : located.filter({ hasText: text }))
      .first()
      .waitFor({ state: 'visible', timeout });
  }
}

async function focusBoxes(
  page: Page,
  selectors: string[],
  fullPage: boolean,
  scale: number,
  timeout: number,
): Promise<FocusBox[]> {
  const boxes: FocusBox[] = [];
  for (const [i, selector] of selectors.entries()) {
    const located = page.locator(selector).first();
    await located.waitFor({ state: 'visible', timeout });
    if (i === 0 && !fullPage) await located.scrollIntoViewIfNeeded({ timeout });
    const box = await located.boundingBox();
    if (box === null) throw new Error(`${selector} has no box to frame`);
    // A box is measured from the viewport; a full-page image starts at the top
    // of the document.
    const [sx, sy] = fullPage
      ? await page.evaluate<[number, number]>('[window.scrollX, window.scrollY]')
      : [0, 0];
    boxes.push({
      selector,
      x: Math.round((box.x + sx) * scale),
      y: Math.round((box.y + sy) * scale),
      width: Math.round(box.width * scale),
      height: Math.round(box.height * scale),
    });
  }
  return boxes;
}

async function clear(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (/^\d{2,}-.+\.png$/.test(name) || name === 'manifest.json') {
      await rm(path.join(dir, name), { force: true });
    }
  }
}

async function follow(
  context: BrowserContext,
  name: string,
  journey: TourJourney,
  viewport: Viewport,
  target: Target,
  dir: string,
  timeout: number,
  sha: string | null,
): Promise<Shot[]> {
  const page = await context.newPage();
  const shots: Shot[] = [];
  let taken = 0;
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page, target.url, timeout).catch((error: Error) => {
      throw new TourFailure(
        `journey "${name}" (${viewport.name}) could not open ${target.url}: ` +
          (error.message.split('\n')[0] ?? 'no reason given'),
      );
    });
    for (const [i, step] of journey.steps.entries()) {
      try {
        if (!('shot' in step)) {
          await act(page, step, target.url, timeout);
          continue;
        }
        const { name: shotName, caption, focus, fullPage } = step.shot;
        await settle(page, timeout);
        const boxes = await focusBoxes(page, focus, fullPage, viewport.scale, timeout);
        taken += 1;
        const file = `${String(taken).padStart(2, '0')}-${shotName}.${viewport.name}.png`;
        await page.screenshot({
          path: path.join(dir, file),
          fullPage,
          animations: 'disabled',
          caret: 'hide',
          timeout,
        });
        shots.push({
          file,
          journey: name,
          step: i,
          name: shotName,
          ...(caption !== undefined ? { caption } : {}),
          account: journey.account,
          url: page.url(),
          viewport: {
            name: viewport.name,
            width: viewport.width,
            height: viewport.height,
            scale: viewport.scale,
          },
          focus: boxes,
          sha,
        });
      } catch (error) {
        if (error instanceof TourFailure) throw error;
        throw new TourFailure(
          `journey "${name}" (${viewport.name}) step ${i} (${said(step)}) failed: ` +
            ((error as Error).message.split('\n')[0] ?? 'no reason given'),
        );
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  return shots;
}

export async function shoot(request: ShootRequest): Promise<Shoot | Unavailable> {
  const { tours, cwd } = request;
  const { target, journeys } = pick(tours, request);
  checkEnv(tours, journeys);

  const launched = await launchBrowser(request.executablePath);
  if (unavailable(launched)) return launched;
  const browser: Browser = launched;

  const out = path.resolve(cwd, request.out ?? '.pagebeam/shots');
  const sha = await history.head(cwd);
  const timeout = tours.timeoutMs;
  // One sign-in per account per run. A different scale needs its own context,
  // which starts from the session the first one made.
  const contexts = new Map<string, Map<number, BrowserContext>>();
  const manifests: Shoot['manifests'] = [];

  async function contextFor(account: string, scale: number): Promise<BrowserContext> {
    let byScale = contexts.get(account);
    if (byScale === undefined) {
      const { context } = await signIn(browser, account, tours.accounts[account]!, target, {
        cwd,
        timeout,
        scale,
      });
      byScale = new Map([[scale, context]]);
      contexts.set(account, byScale);
    }
    const existing = byScale.get(scale);
    if (existing !== undefined) return existing;
    const first = byScale.values().next().value as BrowserContext;
    const context = await browser.newContext({
      deviceScaleFactor: scale,
      storageState: await first.storageState(),
    });
    byScale.set(scale, context);
    return context;
  }

  try {
    for (const [name, journey] of journeys) {
      const dir = path.join(out, target.name, name);
      await mkdir(dir, { recursive: true });
      await clear(dir);
      const shots: Shot[] = [];
      for (const viewport of journey.viewports) {
        const context = await contextFor(journey.account, viewport.scale);
        shots.push(...(await follow(context, name, journey, viewport, target, dir, timeout, sha)));
      }
      const manifest: Manifest = {
        target: target.name,
        url: target.url,
        journey: name,
        account: journey.account,
        sha,
        takenAt: new Date().toISOString(),
        shots,
      };
      const file = path.join(dir, 'manifest.json');
      await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
      manifests.push({ file, manifest });
    }
  } finally {
    await browser.close();
  }
  return { target: target.name, manifests };
}
