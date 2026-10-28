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
import { learnVolatility } from './pixels.js';
import type {PublicResources} from './resources.js';

export interface StepResult {
  step: number;
  action: string;
  status: 'passed' | 'failed';
  assertion?: 'observed' | 'script';
  file?: string;
  samples?: string[];
  route?: string;
  skipped?: string;
  error?: string;
}

export interface Observation {
  url: string;
  text: string;
  structure?: string;
  controls: { selector: string; tag: string; text: string; name?:string; type: string; attributes?: Record<string,string> }[];
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
  deferNavigation?: boolean | undefined;
  resources?:{store:PublicResources;scope:string}|undefined;
  calibrate?: boolean | undefined;
  clock?: string | undefined;
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
        if(o.resources)context.on('response',response=>o.resources!.store.capture(response,o.resources!.scope,new URL(target.url).origin));
        await context.route('**/*', async route => {
          const request = route.request();
          if (request.isNavigationRequest() && !this.origins.has(new URL(request.url()).origin)) return route.abort('blockedbyclient');
          if(o.resources&&await o.resources.store.fulfill(route,o.resources.scope))return;
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
    if(o.clock)await this.page.clock.setFixedTime(o.clock);
    await this.page.setViewportSize({ width: o.viewport.width, height: o.viewport.height });
    this.context.on('page', page => { if (page !== this.page) void page.close(); });
    if (paceOf(o.journey) !== null) await this.installRecordingMask();
    this.started = Date.now();
    if (o.mode !== 'saved') this.timer = setTimeout(this.abort, policy!.timeoutMs);
    if(!o.deferNavigation)await this.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: o.tours.timeoutMs });
    await this.staticStyles();
    await mkdir(o.out, { recursive: true });
    const pace = paceOf(o.journey);
    if (pace !== null) {
      this.recorder = new Recorder(this.page, pace, o.viewport);
      await this.recorder.start();
      await this.recorder.ready(o.tours.timeoutMs);
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
      const controls = [...document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="menuitem"],[role="combobox"],[role="option"],[data-u-command]')]
        .filter(el => {
          if(el.closest('[data-pagebeam-private],[inert],[aria-hidden="true"]'))return false;
          const bounds=el.getBoundingClientRect();
          if(!bounds.width||!bounds.height)return false;
          const y=Math.max(0,bounds.top)+(Math.min(bounds.bottom,innerHeight)-Math.max(0,bounds.top))/2;
          const left=Math.max(0,bounds.left),right=Math.min(bounds.right,innerWidth);
          if(right<=left||Math.min(bounds.bottom,innerHeight)<=Math.max(0,bounds.top))return false;
          const hit=document.elementFromPoint((left+right)/2,y);
          return hit&&(hit===el||el.contains(hit));
        }).slice(0,100);
      const clone = document.body.cloneNode(true);
      const originals = [...document.body.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
      for (let index=originals.length-1;index>=0;index--) {
        const element=originals[index];
        if (!element.getClientRects().length && getComputedStyle(element).display !== 'contents' || getComputedStyle(element).visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true') copies[index].remove();
      }
      clone.querySelectorAll('input,textarea,script,style,svg,[data-pagebeam-private]').forEach(el => el.remove());
      for (const selector of ${JSON.stringify([...this.privateSelectors])}) {
        try { clone.querySelectorAll(selector).forEach(el => el.remove()); } catch {}
      }
      return {url: location.href, text: clone.textContent.slice(0,16000), structure:([ ...clone.querySelectorAll('[aria-modal="true"],[role="dialog"],dialog[open]')].at(-1)?.outerHTML??clone.innerHTML).slice(0,22000), controls: controls.map((el,i) => {
        el.setAttribute('data-pagebeam-control',String(i));
        return {selector:'[data-pagebeam-control="'+i+'"]',tag:el.tagName.toLowerCase(),text:(el.innerText||'').trim().slice(0,300),name:(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||'').slice(0,300),type:el.getAttribute('type')||'',attributes:Object.fromEntries(['id','role','aria-label','title','aria-haspopup','aria-expanded','data-testid','data-u-command','href'].filter(name => el.hasAttribute(name)).map(name => [name,el.getAttribute(name)]))};
      })};
    })()`);
    const url = new URL(raw.url);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/token|code|state|secret|password/i.test(key)) url.searchParams.delete(key);
    raw.url = url.href;
    return { ...raw, url: this.options.redact(raw.url), text: this.options.redact(raw.text), ...(raw.structure ? {structure:this.options.redact(raw.structure)} : {}),
      controls: raw.controls.map(control => JSON.parse(this.options.redact(JSON.stringify(control))) as Observation['controls'][number]) };
  }

  private async staticStyles():Promise<void>{
    if(!this.options.clock||paceOf(this.options.journey)!==null)return;
    await this.available().evaluate(`(() => {
      if(document.querySelector('style[data-pagebeam-static-review]'))return;
      const style=document.createElement('style');style.dataset.pagebeamStaticReview='';
      style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
      document.head.append(style);
    })()`);
  }

  async ready(): Promise<void> {
    const page = this.available();
    await this.staticStyles();
    await page.waitForLoadState('networkidle', {timeout:Math.min(2000,this.options.tours.timeoutMs)}).catch(() => undefined);
    await page.evaluate(`(async () => {
      await Promise.race([document.fonts.ready,new Promise(resolve => setTimeout(resolve,2000))]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
  }

  async stableStep(input: unknown): Promise<TourStep> {
    let step = stepSchema.parse(input);
    const page = this.available();
    if('expect'in step&&step.expect.text&&step.expect.value===undefined){
      const field=page.locator(step.expect.selector).first();
      if(await field.count()&&await field.evaluate(element=>['INPUT','TEXTAREA'].includes(element.tagName)&&element.getAttribute('type')!=='password',undefined,{timeout:this.options.tours.timeoutMs})){
        const {text,visibleText,...expect}=step.expect;
        step={...step,expect:{...expect,value:text}};
      }
    }
    const selector = 'click' in step ? step.click : 'fill' in step ? step.fill.selector : 'select' in step ? step.select.selector : 'expect' in step ? step.expect.selector : 'wait' in step && typeof step.wait === 'string' ? step.wait : 'scroll' in step ? step.scroll.selector : undefined;
    if (!selector || !selector.includes('data-pagebeam-control') && !('click' in step)) return step;
    const target=page.locator(selector).filter({visible:true}).first();
    await target.waitFor({state:'visible',timeout:this.options.tours.timeoutMs});
    const alternatives = await target.evaluate((element,click) => {
      if(click)element=element.closest<HTMLElement|SVGElement>('button,a,summary,input,select,textarea,[role=button],[role=option],[role=menuitem],[data-u-command],[contenteditable=true]')??element;
      const tag = element.tagName.toLowerCase();
      const candidates: string[] = [];
      for (const name of ['data-u-command','data-testid','aria-label','placeholder','name','title','id','aria-controls']) {
        const value = element.getAttribute(name);
        if (!value || name==='id' && /^(?:radix-|:r[^:]*:)/.test(value))continue;
        const candidate=tag+'['+name+'='+JSON.stringify(value)+']';
        for(const attribute of ['role','aria-haspopup','type']){const value=element.getAttribute(attribute);if(value)candidates.push(candidate+'['+attribute+'='+JSON.stringify(value)+']');}
        candidates.push(candidate);
      }
      const text = element.textContent?.trim();
      if (text && text.length < 120) {
        const role=element.getAttribute('role');
        if(role)candidates.push(tag+'[role='+JSON.stringify(role)+']:has-text('+JSON.stringify(text)+')');
        candidates.push(tag + ':has-text(' + JSON.stringify(text) + ')');
      }
      const own=[...candidates];
      for(let ancestor=element.parentElement;ancestor&&ancestor!==element.ownerDocument.body;ancestor=ancestor.parentElement){
        const role=ancestor.getAttribute('role');
        if(!['row','listitem','button'].includes(role??'')&&!['ARTICLE','LI','TR'].includes(ancestor.tagName))continue;
        const labels=String(ancestor.innerText).split('\n').map(value=>value.trim()).filter(value=>value&&value.length<100);
        const scope=ancestor.tagName.toLowerCase()+(role?'[role='+JSON.stringify(role)+']':'');
        for(const label of labels.slice(0,3))for(const target of own)candidates.push(scope+':has-text('+JSON.stringify(label)+') '+target);
      }
      const parts:string[]=[];
      for(let node:Element|null=element;node&&node!==element.ownerDocument.body;node=node.parentElement){
        const siblings=[...node.parentElement!.children].filter(sibling=>sibling.tagName===node!.tagName);
        parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(node)+1)+')');
      }
      candidates.push('body > '+parts.join(' > '));
      return candidates;
    },'click' in step,{timeout:this.options.tours.timeoutMs});
    for (const candidate of alternatives) {
      if (await page.locator(candidate + ':visible').count() !== 1) continue;
      const stable = candidate + ':visible';
      if ('click' in step) return {...step,click:stable};
      if ('fill' in step) return {...step,fill:{...step.fill,selector:stable}};
      if ('select' in step) return {...step,select:{...step.select,selector:stable}};
      if ('expect' in step) return {...step,expect:{...step.expect,selector:stable}};
      if ('wait' in step) return {...step,wait:stable};
      if ('scroll' in step) return {...step,scroll:{...step.scroll,selector:stable}};
    }
    throw new Incomplete('The observed control has no unique replayable selector');
  }

  async disclosures(limit: number): Promise<{selector: string; name: string}[]> {
    const page = this.available();
    return page.evaluate(`(() => {
      const selector = element => {
        if (element.id) return '#' + CSS.escape(element.id);
        for (const attribute of ['data-testid', 'aria-label', 'aria-controls']) {
          const value = element.getAttribute(attribute);
          const candidate = element.tagName.toLowerCase() + '[' + attribute + '=' + JSON.stringify(value) + ']';
          if (value && document.querySelectorAll(candidate).length === 1) return candidate;
        }
        const parts = [];
        for (let at = element; at && at !== document.body; at = at.parentElement) {
          const siblings = [...at.parentElement.children].filter(node => node.tagName === at.tagName);
          parts.unshift(at.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(at) + 1) + ')');
        }
        return 'body > ' + parts.join(' > ');
      };
      return [...document.querySelectorAll('summary, button[aria-haspopup], [role="button"][aria-haspopup], button[aria-expanded="false"], [role="button"][aria-expanded="false"]')]
        .filter(element => !element.closest('[data-pagebeam-private]') && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('aria-haspopup') !== 'false' && element.getBoundingClientRect().width && element.getBoundingClientRect().height)
        .slice(0, ${limit})
        .map((element, index) => ({selector:selector(element), name:'control-' + (index + 1)}));
    })()`);
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
            result.samples=await this.screenshot(name, step.shot.fullPage);
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
        if ('goto' in step) {this.navigated = navigationPath(step.goto);await this.staticStyles();}
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

  private async screenshot(name: string, fullPage = false): Promise<string[]> {
    const o = this.options;
    const page = this.page!;
    await this.ready();
    const shoot=async(file:string)=>page.screenshot({ path: path.join(o.out, file), fullPage, animations: 'disabled', caret: 'hide', style: HIDE_CURSOR,
      mask: page.frames().flatMap(frame => [...this.privateSelectors].map(selector => frame.locator(selector)).concat([...this.secrets].filter(Boolean).map(secret => frame.getByText(secret, { exact: true })))), timeout: o.tours.timeoutMs });
    const samples:string[]=[];
    for(let round=0;round<3;round++){
      await shoot(name);samples.length=0;
      if(!o.calibrate||name.startsWith('failure-'))return samples;
      for(let index=1;index<=4;index++){
        await page.waitForTimeout(350);
        const file=name.replace(/\.png$/,`-sample-${index}.png`);await shoot(file);samples.push(file);
      }
      const stability=await learnVolatility(path.join(o.out,name),samples.slice(0,3).map(file=>path.join(o.out,file)),path.join(o.out,samples[3]!));
      if(stability.valid)return samples;
      await this.ready();
    }
    throw new Incomplete('Screenshot did not settle within bounded calibration attempts');
  }

  async close(): Promise<void> {
    await this.options.resources?.store.flush();
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
