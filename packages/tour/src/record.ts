import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CDPSession, Locator, Page } from 'playwright-core';
import type { TourJourney } from '@pagebeam/core';

const exec = promisify(execFile);

export type Pace = Exclude<TourJourney['record'], false>;

export function paceOf(journey: TourJourney): Pace | null {
  return journey.record === false ? null : journey.record;
}

export async function ffmpegFound(command: string): Promise<boolean> {
  return exec(command, ['-version']).then(
    () => true,
    () => false,
  );
}

const CURSOR_ID = 'pagebeam-cursor';
export const HIDE_CURSOR = `#${CURSOR_ID}{display:none!important}`;

// Headless Chrome draws no pointer, so a recording would show clicks landing
// from nowhere. The position is kept across page loads so the pointer does not
// jump back to a corner after every navigation.
const CURSOR_SCRIPT = `(() => {
  const id = ${JSON.stringify(CURSOR_ID)};
  let at = [24, 24];
  try { at = JSON.parse(sessionStorage.getItem(id)) || at; } catch {}
  const draw = () => {
    if (document.getElementById(id) || !document.body) return;
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;' +
      'border-radius:50%;background:rgba(20,20,20,.55);border:2px solid #fff;' +
      'box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;z-index:2147483647;' +
      'transition:transform .12s ease-out,background .12s;transform:translate(' + at[0] + 'px,' + at[1] + 'px)';
    document.body.appendChild(el);
  };
  const move = (x, y) => {
    at = [x, y];
    try { sessionStorage.setItem(id, JSON.stringify(at)); } catch {}
    const el = document.getElementById(id);
    if (el) el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  };
  addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
  addEventListener('mousedown', () => { const el = document.getElementById(id); if (el) el.style.background = 'rgba(20,20,20,.9)'; }, true);
  addEventListener('mouseup', () => { const el = document.getElementById(id); if (el) el.style.background = 'rgba(20,20,20,.55)'; }, true);
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', draw); else draw();
})();`;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Moment {
  step: number;
  action: string;
  at: number;
  until: number;
  box?: Box;
  say?: string;
}

export interface Recording {
  file: string;
  viewport: { name: string; width: number; height: number };
  durationMs: number;
  timeline: Moment[];
}

interface Size {
  width: number;
  height: number;
}

interface Frame {
  file: string;
  at: number;
}

const FPS = 30;

// Chrome sends a frame only when the page changes. Each tick of a steady frame
// rate shows the latest frame sent by then, so the video keeps the real timing.
async function encode(frames: Frame[], end: number, size: Size, out: string, ffmpeg: string): Promise<void> {
  const width = Math.ceil(size.width / 2) * 2;
  const height = Math.ceil(size.height / 2) * 2;
  const child = spawn(
    ffmpeg,
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-i',
      '-',
      '-vf',
      // Chrome can send a frame at another size while a page settles, and the
      // video would otherwise take the size of the first frame.
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let said = '';
  child.stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
  let closed = false;
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      closed = true;
      if (code === 0) resolve();
      else reject(new Error(said.trim() || `ffmpeg exited ${code}`));
    });
  });
  child.stdin.on('error', () => undefined);
  const start = frames[0]!.at;
  const ticks = Math.max(1, Math.round(((end - start) * FPS) / 1000));
  let shown = 0;
  let image = await readFile(frames[0]!.file);
  for (let k = 0; k < ticks; k += 1) {
    const at = start + (k * 1000) / FPS;
    let next = shown;
    while (next + 1 < frames.length && frames[next + 1]!.at <= at) next += 1;
    if (next !== shown) {
      shown = next;
      image = await readFile(frames[shown]!.file);
    }
    if (closed) break;
    if (!child.stdin.write(image)) {
      await Promise.race([new Promise((resolve) => child.stdin.once('drain', resolve)), done.catch(() => undefined)]);
    }
  }
  child.stdin.end();
  await done;
}

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class Recorder {
  readonly pace: Pace;
  readonly timeline: Moment[] = [];
  private readonly page: Page;
  private session: CDPSession | undefined;
  private frames: Frame[] = [];
  private dir = '';
  private writes: Promise<void>[] = [];
  private pointer: [number, number] = [24, 24];
  private sayingUntil = 0;

  constructor(page: Page, pace: Pace) {
    this.page = page;
    this.pace = pace;
  }

  async start(): Promise<void> {
    if (this.pace.cursor) await this.page.addInitScript(CURSOR_SCRIPT);
    this.dir = await mkdtemp(path.join(tmpdir(), 'pagebeam-frames-'));
    this.session = await this.page.context().newCDPSession(this.page);
    this.session.on('Page.screencastFrame', (frame) => {
      const file = path.join(this.dir, `${String(this.frames.length).padStart(6, '0')}.jpg`);
      this.frames.push({ file, at: Date.now() });
      this.writes.push(writeFile(file, Buffer.from(frame.data, 'base64')));
      this.session?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await this.session.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  }

  // Times in the timeline count from the first frame, which is where the video starts.
  now(): number {
    const first = this.frames[0]?.at;
    return first === undefined ? 0 : Date.now() - first;
  }

  hold(): Promise<void> {
    return this.page.waitForTimeout(this.pace.holdMs);
  }

  async pointAt(located: Locator, timeout: number): Promise<Box | undefined> {
    await located.waitFor({ state: 'visible', timeout });
    await located.scrollIntoViewIfNeeded({ timeout });
    const box = await located.boundingBox();
    if (box === null) return undefined;
    const to: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
    const from = this.pointer;
    const steps = Math.max(1, Math.round(this.pace.moveMs / 16));
    for (let k = 1; k <= steps; k += 1) {
      const t = ease(k / steps);
      await this.page.mouse.move(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
      await this.page.waitForTimeout(16);
    }
    this.pointer = to;
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }

  // A line starts once the one before it has finished, while the steps after it
  // carry on, so what is said plays over what is done.
  async say(step: number, text: string, ms: number): Promise<void> {
    const wait = this.sayingUntil - this.now();
    if (wait > 0) await this.page.waitForTimeout(wait);
    const at = this.now();
    this.sayingUntil = at + ms;
    this.timeline.push({ step, action: 'say', at, until: this.sayingUntil, say: text });
  }

  async finish(): Promise<void> {
    const wait = this.sayingUntil - this.now();
    if (wait > 0) await this.page.waitForTimeout(wait);
    await this.hold();
  }

  async stop(size: Size, out: string, ffmpeg: string): Promise<number> {
    const end = Date.now();
    try {
      await this.session?.send('Page.stopScreencast').catch(() => undefined);
      await Promise.all(this.writes);
      if (this.frames.length === 0) throw new Error('the browser sent no frames to record');
      await encode(this.frames, end, size, out, ffmpeg);
      return end - this.frames[0]!.at;
    } finally {
      await rm(this.dir, { recursive: true, force: true });
    }
  }
}
