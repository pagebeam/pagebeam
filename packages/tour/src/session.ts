import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { launchBrowser, unavailable, routeMatches } from '@pagebeam/app';
import { stepSchema, type TourJourney, type Tours, type TourStep } from '@pagebeam/core';
import { navigationPath } from './checkpoints.js';
import { act, focusBoxes } from './shoot.js';
import { signIn, TourFailure } from './accounts.js';
import { StageFailure } from './environment.js';
import { HIDE_CURSOR, paceOf, Recorder } from './record.js';

export interface StepResult {
  step: number;
  action: string;
  status: 'passed' | 'failed';
  assertion?: 'observed' | 'script';
  file?: string;
  route?: string;
  skipped?: string;
  error?: string;
}

export interface Observation {
  url: string;
  text: string;
  controls: { selector: string; tag: string; text: string; type: string }[];
}

export interface SessionOptions {
  cwd: string;
  tours: Tours;
  journey: TourJourney;
  name: string;
  target: string;
  viewport: TourJourney['viewports'][number];
  out: string;
  mode: 'saved' | 'caller' | 'model';
  purpose: 'capture' | 'check' | 'both';
  disposable: boolean;
  mask: string[];
  captureRoutes?: string[] | undefined;
  skipDelays?: boolean | undefined;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  redact(value: string): string;
  registerSecret(value: string): void;
  onStep(result: StepResult): Promise<void>;
}

export class Incomplete extends Error {}

export class CaptureSession {
  private navigated: string | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private recorder: Recorder | undefined;
  private actions = 0;
  private started = Date.now();
  private origins = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private privateSelectors = new Set(['input[type="password"]', 'input[type="email"]', '[autocomplete="username"]']);
  private secrets = new Set<string>();
  private abort = (): void => { void this.context?.close().catch(() => undefined); };

  constructor(readonly options: SessionOptions) {}

  async start(): Promise<void> {
    const o = this.options;
    const target = o.tours.targets[o.target];
    if (!target) throw new Error(`unknown target ${o.target}`);
    const policy = o.journey.explore;
    if (o.mode !== 'saved' && !policy) throw new Error('exploration requires a configured goal and policy');
    if (o.mode !== 'saved' && policy?.allowChanges && !o.disposable) throw new Error('data-changing exploration requires disposable test data');
    this.origins = new Set([new URL(target.url).origin, ...(policy?.origins ?? []).map(value => new URL(value).origin)]);
    const loginUrl = o.tours.accounts[o.journey.account]?.login.form?.url;
    if (loginUrl) this.origins.add(new URL(loginUrl, target.url).origin);
    o.signal.throwIfAborted();
    const browser = await launchBrowser();
    if (unavailable(browser)) throw new Error(browser.reason);
    this.browser = browser;
    o.signal.addEventListener('abort', this.abort, { once: true });
    if (o.signal.aborted) { await browser.close(); o.signal.throwIfAborted(); }
    const account = o.tours.accounts[o.journey.account];
    if (!account) throw new Error(`unknown account ${o.journey.account}`);
    const signedIn = await signIn(browser, o.journey.account, account, { name: o.target, url: target.url }, {
      cwd: o.cwd, timeout: o.tours.timeoutMs, scale: o.viewport.scale, env: o.env,
      safeErrors: true,
      credentials: credentials => {
        for (const value of [credentials.username, credentials.password]) {
          o.registerSecret(value);
          if (value) this.secrets.add(value);
        }
      },
      setup: async context => {
        this.context = context;
        await context.route('**/*', route => {
          const request = route.request();
          if (request.isNavigationRequest() && !this.origins.has(new URL(request.url()).origin)) return route.abort('blockedbyclient');
          return route.continue();
        });
      },
    }).catch(error => { throw new StageFailure(error instanceof TourFailure ? error.stage : 'sign-in', error instanceof Error ? error.message : String(error)); });
    if (signedIn.credentials) {
      o.registerSecret(signedIn.credentials.username);
      o.registerSecret(signedIn.credentials.password);
      this.secrets.add(signedIn.credentials.username);
      this.secrets.add(signedIn.credentials.password);
    }
    if (account.login.form) {
      this.privateSelectors.add(account.login.form.username);
      this.privateSelectors.add(account.login.form.password);
    }
    for (const selector of o.mask) this.privateSelectors.add(selector);
    this.context = signedIn.context;
    if (o.signal.aborted) { await this.close(); o.signal.throwIfAborted(); }
    this.page = await this.context.newPage();
    await this.page.setViewportSize({ width: o.viewport.width, height: o.viewport.height });
    this.context.on('page', page => { if (page !== this.page) void page.close(); });
    if (paceOf(o.journey) !== null) await this.installRecordingMask();
    this.started = Date.now();
    if (o.mode !== 'saved') this.timer = setTimeout(this.abort, policy!.timeoutMs);
    await this.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: o.tours.timeoutMs });
    await mkdir(o.out, { recursive: true });
    const pace = paceOf(o.journey);
    if (pace !== null) {
      this.recorder = new Recorder(this.page, pace, o.viewport);
      await this.recorder.start();
    }
  }

  private available(): Page {
    const o = this.options;
    o.signal.throwIfAborted();
    if (o.mode !== 'saved' && (Date.now() - this.started >= o.journey.explore!.timeoutMs || this.actions >= o.journey.explore!.maxActions)) {
      throw new Incomplete('exploration budget exhausted');
    }
    if (!this.page || this.page.isClosed()) throw new Incomplete('browser session is closed');
    return this.page;
  }

  get remainingMs(): number {
    return Math.max(0, (this.options.journey.explore?.timeoutMs ?? 300_000) - (Date.now() - this.started));
  }

  private async installRecordingMask(): Promise<void> {
    const script = `(() => {
      const selectors = ${JSON.stringify([...this.privateSelectors])};
      const secrets = ${JSON.stringify([...this.secrets].filter(Boolean))};
      const observed = new WeakSet();
      const visit = root => {
        if (!observed.has(root)) {
          new MutationObserver(mask).observe(root, {subtree:true,childList:true,characterData:true});
          observed.add(root);
        }
        for (const selector of selectors) {
          try { root.querySelectorAll(selector).forEach(el => el.style.setProperty('opacity','0','important')); } catch {}
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) visit(el.shadowRoot);
          if (!el.children.length && secrets.some(secret => el.textContent.includes(secret))) el.style.setProperty('opacity','0','important');
        }
      };
      const mask = () => visit(document);
      mask();
    })()`;
    await this.context!.addInitScript(script);
    for (const frame of this.page!.frames()) await frame.evaluate(script);
  }

  private async markTypingTarget(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      const marked = await frame.evaluate<boolean>(`(() => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        const editable = element && element !== document.body && (
          element.isContentEditable || element.tagName === 'TEXTAREA' ||
          (element.tagName === 'INPUT' && ['text','search','email','password','tel','url','number'].includes(element.type))
        );
        if (!document.hasFocus() || !editable || element.disabled || element.readOnly) return false;
        element.setAttribute('data-pagebeam-typed-private', 'true');
        return true;
      })()`);
      if (marked) {
        this.privateSelectors.add('[data-pagebeam-typed-private]');
        return;
      }
    }
    throw new Error('environment typing requires a focused text input or editable element');
  }

  async observe(): Promise<Observation> {
    const page = this.available();
    for (const selector of this.privateSelectors) {
      await page.locator(selector).evaluateAll("nodes => nodes.forEach(node => node.setAttribute('data-pagebeam-private','true'))");
    }
    const raw = await page.evaluate<Observation>(`(() => {
      document.querySelectorAll('[data-pagebeam-control]').forEach(el => el.removeAttribute('data-pagebeam-control'));
      const controls = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"]')]
        .filter(el => !el.closest('[data-pagebeam-private]') && el.getBoundingClientRect().width && el.getBoundingClientRect().height).slice(0,100);
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('input,textarea,script,style,[data-pagebeam-private]').forEach(el => el.remove());
      for (const selector of ${JSON.stringify([...this.privateSelectors])}) {
        try { clone.querySelectorAll(selector).forEach(el => el.remove()); } catch {}
      }
      return {url: location.href, text: clone.textContent.slice(0,16000), controls: controls.map((el,i) => {
        el.setAttribute('data-pagebeam-control',String(i));
        return {selector:'[data-pagebeam-control="'+i+'"]',tag:el.tagName.toLowerCase(),text:(el.getAttribute('aria-label')||el.textContent||el.getAttribute('placeholder')||'').slice(0,300),type:el.getAttribute('type')||''};
      })};
    })()`);
    const url = new URL(raw.url);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/token|code|state|secret|password/i.test(key)) url.searchParams.delete(key);
    raw.url = url.href;
    return { ...raw, url: this.options.redact(raw.url), text: this.options.redact(raw.text),
      controls: raw.controls.map(control => ({ ...control, text: this.options.redact(control.text) })) };
  }

  async step(input: unknown): Promise<StepResult> {
    const o = this.options;
    const page = this.available();
    const step = stepSchema.parse(input);
    const kind = Object.keys(step).find(key => key !== 'note')!;
    if (o.mode !== 'saved') {
      const policy = o.journey.explore!;
      if (('fill' in step && step.fill.valueEnv !== undefined) || ('type' in step && typeof step.type !== 'string')) {
        throw new Error('exploratory actions cannot read environment variables');
      }
      if (!policy.actions.includes(kind as typeof policy.actions[number])) throw new Error(`action ${kind} is not permitted`);
      if (['click', 'fill', 'select', 'press', 'type'].includes(kind) && (!policy.allowChanges || !o.disposable)) {
        throw new Error('interactive exploration requires allowChanges and disposable test data');
      }
    }
    if ('goto' in step && !this.origins.has(new URL(step.goto, o.tours.targets[o.target]!.url).origin)) throw new Error('navigation origin is not permitted');
    const result: StepResult = { step: this.actions++, action: kind, status: 'passed' };
    const started = this.recorder?.now() ?? 0;
    try {
      if ('wait' in step && typeof step.wait === 'number' && o.skipDelays) {
        result.skipped = 'configured delay skip';
      } else if ('shot' in step) {
        const expectedRoute = step.shot.route ?? this.navigated;
        const relevant = !o.captureRoutes || Boolean(expectedRoute && o.captureRoutes.some(route => routeMatches(route, expectedRoute)));
        if (!relevant) result.skipped = 'unaffected screen';
        else {
          const target = new URL(o.tours.targets[o.target]!.url);
          const checkRoute = (): void => {
            const actual = new URL(page.url());
            result.route = actual.pathname;
            if (expectedRoute && (actual.origin !== target.origin || (actual.pathname.replace(/\/$/, '') || '/') !== (expectedRoute.replace(/\/$/, '') || '/'))) {
              throw new Error(`Screenshot ${step.shot.name} expected route ${expectedRoute}, reached ${actual.pathname}`);
            }
          };
          checkRoute();
          if (o.purpose !== 'check') {
            const name = `${String(result.step).padStart(3, '0')}-${step.shot.name}.png`;
            await focusBoxes(page, step.shot.focus, step.shot.fullPage, o.viewport.scale, o.tours.timeoutMs);
            checkRoute();
            await this.screenshot(name, step.shot.fullPage);
            checkRoute();
            result.file = name;
          }
        }
      } else {
        const envKey = 'fill' in step ? step.fill.valueEnv : 'type' in step && typeof step.type !== 'string' ? step.type.valueEnv : undefined;
        if (envKey) {
          const value = o.env[envKey];
          if (!value) throw new Error(`required variable ${envKey} is not set`);
          if ('fill' in step) this.privateSelectors.add(step.fill.selector);
          else await this.markTypingTarget(page);
          this.secrets.add(value);
          o.registerSecret(value);
          if (this.recorder) await this.installRecordingMask();
        }
        await act(page, step, o.tours.targets[o.target]!.url, o.tours.timeoutMs, this.recorder ?? null, o.env, o.cwd);
        if ('goto' in step) this.navigated = navigationPath(step.goto);
        if ('expect' in step) result.assertion = 'observed';
        if ('verify' in step) result.assertion = 'script';
      }
      if (this.recorder) this.recorder.timeline.push({ step: result.step, action: kind, at: started, until: this.recorder.now() });
    } catch (error) {
      result.status = 'failed';
      result.error = o.redact((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'browser action failed');
      if (o.purpose !== 'check') {
        const file = `failure-${result.step}.png`;
        await this.screenshot(file).then(() => { result.file = file; }).catch(() => undefined);
      }
    }
    await o.onStep(result);
    if (result.status === 'failed') {
      if (o.mode !== 'saved' && this.remainingMs === 0) throw new Incomplete('exploration budget exhausted');
      throw new Error(result.error);
    }
    return result;
  }

  private async screenshot(name: string, fullPage = false): Promise<void> {
    const o = this.options;
    const page = this.page!;
    await page.screenshot({ path: path.join(o.out, name), fullPage, animations: 'disabled', caret: 'hide', style: HIDE_CURSOR,
      mask: page.frames().flatMap(frame => [...this.privateSelectors].map(selector => frame.locator(selector)).concat([...this.secrets].filter(Boolean).map(secret => frame.getByText(secret, { exact: true })))), timeout: o.tours.timeoutMs });
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.options.signal.removeEventListener('abort', this.abort);
    try {
      if (this.recorder && this.page && !this.page.isClosed()) {
        const durationMs = await this.recorder.stop(path.join(this.options.out, 'recording.mp4'), 'ffmpeg');
        await writeFile(path.join(this.options.out, 'recording.json'), JSON.stringify({ durationMs, timeline: this.recorder.timeline }));
      }
    } finally {
      await this.recorder?.discard();
      await this.browser?.close();
    }
  }
}
