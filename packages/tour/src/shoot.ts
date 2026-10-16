import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { history, launchBrowser, unavailable, type Unavailable } from '@pagebeam/app';
import type { TourJourney, TourStep, Tours } from '@pagebeam/core';
import { missingEnv, open, settle, signIn, TourFailure, TourUsage, type Target } from './accounts.js';
import { ffmpegFound, HIDE_CURSOR, paceOf, Recorder, type Box, type Recording } from './record.js';

export { TourFailure, TourUsage } from './accounts.js';
export type { Box, Moment, Recording } from './record.js';

export interface ShootRequest {
  cwd: string;
  tours: Tours;
  target?: string | undefined;
  journey?: string | undefined;
  out?: string | undefined;
  executablePath?: string | undefined;
  ffmpeg?: string | undefined;
  // How long the narration for a step lasts, by journey and step number,
  // measured from the recorded or generated voice over.
  narration?: Narration | undefined;
}

export type Narration = Record<string, Record<string, number>>;

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
  note?: string;
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
  recordings: Recording[];
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

function checkNarration(tours: Tours, narration: Narration): void {
  for (const [name, lengths] of Object.entries(narration)) {
    const journey = tours.journeys[name];
    if (journey === undefined) throw new TourUsage(`the narration names no journey called ${name}`);
    for (const [key, ms] of Object.entries(lengths)) {
      const step = /^(0|[1-9]\d*)$/.test(key) ? journey.steps[Number(key)] : undefined;
      if (step === undefined) {
        throw new TourUsage(
          `the narration names step ${key} of journey "${name}", which has steps 0 to ${journey.steps.length - 1}`,
        );
      }
      if ('shot' in step) {
        throw new TourUsage(`the narration names step ${key} of journey "${name}", a shot, which a recording does not hold`);
      }
      if (!Number.isInteger(ms) || ms <= 0) {
        throw new TourUsage(`the narration for journey "${name}" must be whole milliseconds above zero`);
      }
    }
  }
}

function said(step: TourStep): string {
  const [kind, value] = Object.entries(step).find(([key]) => key !== 'note')!;
  if (typeof value === 'object' && value !== null) {
    const v = value as { selector?: string; name?: string };
    return `${kind} ${v.selector ?? v.name ?? ''}`.trim();
  }
  return `${kind} ${String(value)}`;
}

async function act(
  page: Page,
  step: TourStep,
  base: string,
  timeout: number,
  recorder: Recorder | null,
): Promise<Box | undefined> {
  const point = (selector: string) => recorder?.pointAt(page.locator(selector).first(), timeout);
  let box: Box | undefined;
  if ('goto' in step) {
    await open(page, new URL(step.goto, base).href, timeout);
  } else if ('click' in step) {
    box = await point(step.click);
    await page.locator(step.click).first().click({ timeout });
    await settle(page, timeout);
  } else if ('fill' in step) {
    const value = step.fill.value ?? process.env[step.fill.valueEnv!] ?? '';
    const field = page.locator(step.fill.selector).first();
    if (recorder === null) {
      await field.fill(value, { timeout });
    } else {
      box = await point(step.fill.selector);
      await field.click({ timeout });
      await field.fill('', { timeout });
      await field.pressSequentially(value, {
        delay: recorder.pace.typeMs,
        timeout: timeout + value.length * recorder.pace.typeMs,
      });
    }
  } else if ('select' in step) {
    box = await point(step.select.selector);
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
  return box;
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
    if (/^\d{2,}-.+\.png$/.test(name) || /^recording\..+\.mp4$/.test(name) || name === 'manifest.json') {
      await rm(path.join(dir, name), { force: true });
    }
  }
}

interface Run {
  name: string;
  journey: TourJourney;
  viewport: Viewport;
  target: Target;
  dir: string;
  timeout: number;
  sha: string | null;
  narration: Record<string, number> | undefined;
  ffmpeg: string;
}

function failed(run: Run, error: unknown, where: string): TourFailure {
  if (error instanceof TourFailure) return error;
  return new TourFailure(
    `journey "${run.name}" (${run.viewport.name}) ${where}: ` +
      ((error as Error).message.split('\n')[0] ?? 'no reason given'),
  );
}

async function follow(context: BrowserContext, run: Run): Promise<{ shots: Shot[]; recording?: Recording }> {
  const { name, journey, viewport, target, dir, timeout, sha } = run;
  const page = await context.newPage();
  const pace = paceOf(journey);
  const recorder = pace === null ? null : new Recorder(page, pace, viewport);
  const shots: Shot[] = [];
  let taken = 0;
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await recorder?.start();
    await open(page, target.url, timeout).catch((error: Error) => {
      throw new TourFailure(
        `journey "${name}" (${viewport.name}) could not open ${target.url}: ` +
          (error.message.split('\n')[0] ?? 'no reason given'),
      );
    });
    for (const [i, step] of journey.steps.entries()) {
      try {
        if (!('shot' in step)) {
          const at = recorder?.now() ?? 0;
          const box = await act(page, step, target.url, timeout, recorder);
          if (recorder !== null) {
            await recorder.hold();
            const narrated = run.narration?.[String(i)];
            if (narrated !== undefined) await recorder.holdUntil(at + narrated);
            recorder.timeline.push({
              step: i,
              action: said(step),
              at,
              until: recorder.now(),
              ...(box !== undefined ? { box } : {}),
              ...(step.note !== undefined ? { note: step.note } : {}),
            });
          }
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
          style: HIDE_CURSOR,
          timeout,
        });
        shots.push({
          file,
          journey: name,
          step: i,
          name: shotName,
          ...(caption !== undefined ? { caption } : {}),
          ...(step.note !== undefined ? { note: step.note } : {}),
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
        throw failed(run, error, `step ${i} (${said(step)}) failed`);
      }
    }
    if (recorder === null) return { shots };
    await recorder.hold();
    const file = `recording.${viewport.name}.mp4`;
    const durationMs = await recorder
      .stop(path.join(dir, file), run.ffmpeg)
      .catch((error: unknown) => {
        throw failed(run, error, 'could not be recorded');
      });
    return {
      shots,
      recording: {
        file,
        viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
        durationMs,
        timeline: recorder.timeline,
      },
    };
  } finally {
    await recorder?.discard();
    await page.close().catch(() => undefined);
  }
}

export async function shoot(request: ShootRequest): Promise<Shoot | Unavailable> {
  const { tours, cwd } = request;
  const { target, journeys } = pick(tours, request);
  checkEnv(tours, journeys);
  if (request.narration !== undefined) checkNarration(tours, request.narration);

  const ffmpeg = request.ffmpeg ?? 'ffmpeg';
  if (journeys.some(([, journey]) => paceOf(journey) !== null) && !(await ffmpegFound(ffmpeg))) {
    return { reason: `no ffmpeg was found to encode recordings (${ffmpeg})` };
  }

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
      const recordings: Recording[] = [];
      for (const viewport of journey.viewports) {
        const context = await contextFor(journey.account, viewport.scale);
        const run = { name, journey, viewport, target, dir, timeout, sha, ffmpeg, narration: request.narration?.[name] };
        const followed = await follow(context, run);
        shots.push(...followed.shots);
        if (followed.recording !== undefined) recordings.push(followed.recording);
      }
      const manifest: Manifest = {
        target: target.name,
        url: target.url,
        journey: name,
        account: journey.account,
        sha,
        takenAt: new Date().toISOString(),
        shots,
        recordings,
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
