import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import {
  Ignores,
  bestSource,
  type FileChange,
  type Finding,
  type Grade,
  type PagebeamConfig,
  type Snapshot,
} from '@pagebeam/core';
import { history, snapshot } from '@pagebeam/app';
import picomatch from 'picomatch';
import { discover, parseAll, type DocPage } from '@pagebeam/docs';
import { configKeys, links, moved, openapi, strings, undocumented } from '@pagebeam/checks';
import { compose, draft, withheld, type Target } from '@pagebeam/model';
import { loadConfig, loadIgnores, NoConfig } from './load.js';
import { publishedPaths } from './published.js';
import { reacher } from './reach.js';
import { settles } from './settles.js';

export interface RunResult {
  problem: string | null;
  degraded: string[];
  comparedWith: string | null;
  grade: Grade | null;
  configFrom: string | null;
  pages: number;
  apps: string[];
  findings: Finding[];
  ran: string[];
  skipped: string[];
  // Every check run again on the pages under another root, such as a checkout
  // holding a proposal, with the evidence this run gathered. Present only on a
  // run that got far enough to check anything.
  recheckAt?: (docsRoot: string) => Promise<Finding[]>;
}

function rootOf(cwd: string, app: { path?: string | undefined }): string | null {
  return app.path ? path.resolve(cwd, app.path) : null;
}

async function runConfigKeys(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  skipped: string[],
  known: Snapshot[] | null,
): Promise<Finding[]> {
  if (config.checks.configKeys === false) return [];
  const usable = config.apps.filter((a) => a.path !== undefined);
  if (usable.length === 0) {
    skipped.push('config-keys: no application declares a local path');
    return [];
  }

  const defined = new Set<string>();
  const searched: string[] = [];

  // A snapshot already holds the settings each application declared at the
  // revision it was read from, so the earlier pass never reads today's files.
  if (known !== null) {
    for (const snapshot of known) {
      for (const key of snapshot.envKeys) defined.add(key);
      searched.push(snapshot.app);
    }
    return configKeys.compare(configKeys.documentedKeys(pages), defined, searched);
  }

  for (const app of usable) {
    const root = rootOf(cwd, app);
    if (root === null) continue;
    for (const key of await configKeys.definedKeys(root, app.envFiles)) defined.add(key);
    searched.push(app.name);
  }
  return configKeys.compare(configKeys.documentedKeys(pages), defined, searched);
}

async function exists(dir: string): Promise<boolean> {
  return stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

// The same directory the link check reads, found the same way, so both are
// talking about one site rather than two.
async function builtSite(cwd: string, config: PagebeamConfig): Promise<string | null> {
  const declared = config.docs.buildDir ? path.resolve(cwd, config.docs.buildDir) : null;
  for (const dir of declared ? [declared] : [path.join(cwd, 'dist'), path.join(cwd, 'build')]) {
    if (await exists(dir)) return dir;
  }
  return null;
}

async function routeSet(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  docsRoot: string,
  earlier: boolean,
): Promise<links.RouteSet> {
  const publicDir = config.docs.publicDir ? path.resolve(cwd, config.docs.publicDir) : undefined;
  const prefix = config.docs.routeBase.replace(/\/+$/, '');
  const declared = config.docs.buildDir ? path.resolve(cwd, config.docs.buildDir) : null;
  const candidates = declared ? [declared] : [path.join(cwd, 'dist'), path.join(cwd, 'build')];

  // The build on disk is today's. Comparing yesterday's pages against it would
  // let a route deleted today make an old link look like it was always broken.
  const fromSource = links.routesOf(pages, links.baseFromPatterns(config.docs.include), prefix);

  for (const dir of earlier ? [] : candidates) {
    if (!(await exists(dir))) continue;
    const routes = await links.routesFromBuild(dir);
    if (routes.size === 0) continue;

    // A build guessed at rather than declared has to be shown to belong to
    // this documentation: most of what the source publishes must be in it.
    if (declared === null) {
      const shared = [...fromSource].filter((r) => routes.has(r)).length;
      if (fromSource.size === 0 || shared / fromSource.size < 0.5) continue;
    }
    return { routes, source: 'build', docsRoot, ...(publicDir ? { publicDir } : {}) };
  }
  return { routes: fromSource, source: 'content', docsRoot, ...(publicDir ? { publicDir } : {}) };
}

export interface RouteModels {
  now: 'build' | 'content' | null;
  then: 'build' | 'content' | null;
}

async function runLinks(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  docsRoot: string,
  skipped: string[],
  earlier: boolean,
  models: RouteModels,
): Promise<Finding[]> {
  if (config.checks.links === false) return [];
  const options = config.checks.links;
  const set = await routeSet(pages, cwd, config, docsRoot, earlier);
  models[earlier ? 'then' : 'now'] = set.source;
  if (options.external && !earlier) {
    set.reach = reacher({
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      allowlist: options.allowlist,
    });
  }
  const outcome = await links.checkLinks(pages, set, { external: options.external });
  if (outcome.external.unknown > 0) {
    skipped.push(
      `links: ${outcome.external.unknown} external address(es) could not be reached either way, so they are unchecked rather than sound`,
    );
  }
  return outcome.findings;
}

// The same config without external link requests. A draft changes one page;
// asking every external address again for each draft would repeat the same
// requests and learn nothing new.
function offline(config: PagebeamConfig): PagebeamConfig {
  if (config.checks.links === false) return config;
  return { ...config, checks: { ...config.checks, links: { ...config.checks.links, external: false } } };
}

export interface Evidence {
  now: Snapshot[];
  before: Snapshot[] | null;
  complete: boolean;
  grade: Grade;
  movement: { app: string; changed: string[] }[];
}

async function gather(cwd: string, config: PagebeamConfig): Promise<Evidence | null> {
  const usable = config.apps.filter((a) => a.path !== undefined);
  if (usable.length === 0) return null;

  const now: Snapshot[] = [];
  const before: Snapshot[] = [];
  const movement: { app: string; changed: string[] }[] = [];

  for (const app of usable) {
    const root = rootOf(cwd, app);
    if (root === null) continue;
    const request = {
      app: app.name,
      root,
      include: app.include,
      exclude: app.exclude,
      envFiles: app.envFiles,
    };
    // Only the present can be opened in a browser; an earlier revision is read
    // from the repository, so history stays a file-level comparison.
    const viewing =
      app.url !== undefined && app.routes.length > 0
        ? {
            baseUrl: app.url,
            routes: app.routes,
            timeoutMs: app.renderTimeoutMs,
            ...(app.auth ? { auth: app.auth } : {}),
          }
        : undefined;
    now.push(await snapshot({ ...request, ...(viewing ? { viewing } : {}) }));

    const earlier = (await history.isRepository(root))
      ? await history.revisionBefore(root, config.history.sinceDays)
      : null;
    if (earlier === null) continue;
    before.push(await snapshot({ ...request, rev: earlier }));
    movement.push({ app: app.name, changed: await history.changedBetween(root, earlier) });
  }

  // Every application has to be comparable before the comparison can carry the
  // claim on its own; with only some, the cautious reading still applies.
  const complete = before.length === now.length && before.length > 0;
  return {
    now,
    before: before.length > 0 ? before : null,
    complete,
    movement,
    grade: {
      source: bestSource(now.map((s) => s.source)),
      depth: complete ? 'paired' : 'single',
      whole: now.every((s) => s.whole),
    },
  };
}

async function runStrings(
  pages: DocPage[],
  config: PagebeamConfig,
  evidence: Evidence | null,
  skipped: string[],
): Promise<Finding[]> {
  if (config.checks.strings === false) return [];
  if (evidence === null) {
    skipped.push('strings: no application declares a local path');
    return [];
  }
  return strings.compare(
    strings.candidates(pages, !evidence.complete),
    evidence.now.map(strings.dictionaryOf),
    evidence.before?.map(strings.dictionaryOf) ?? null,
    evidence.grade,
  );
}

async function runMoved(
  pages: DocPage[],
  config: PagebeamConfig,
  evidence: Evidence | null,
  untouched: ((page: string) => boolean) | null,
  skipped: string[],
): Promise<Finding[]> {
  if (config.checks.moved === false) return [];
  if (evidence === null || untouched === null || evidence.movement.length === 0) {
    skipped.push('moved: needs an earlier revision of both the documentation and an application');
    return [];
  }
  return moved.checkMoved(pages, evidence.now, evidence.movement, untouched, evidence.before);
}

async function runUndocumented(
  pages: DocPage[],
  config: PagebeamConfig,
  evidence: Evidence | null,
  skipped: string[],
): Promise<Finding[]> {
  if (config.checks.undocumented === false) return [];
  if (evidence === null || evidence.now.every((s) => s.labels.length === 0)) {
    skipped.push('undocumented: no application has controls that could be read');
    return [];
  }
  return undocumented.checkUndocumented(pages, evidence.now, evidence.before);
}

async function runOpenapi(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  skipped: string[],
  docsRoot: string,
): Promise<Finding[]> {
  if (config.checks.openapi === false) return [];
  const wanted = config.checks.openapi.coverage;
  const withSpec = config.apps.filter((a) => a.openapi?.spec !== undefined);
  if (withSpec.length === 0) {
    skipped.push('openapi: no application declares a specification');
    return [];
  }

  const cited = openapi.citations(pages);
  const findings: Finding[] = [];
  const every: openapi.Operation[] = [];

  // How much of a specification the documentation covers is a question about
  // what a reader is served, not about which source files happen to name an
  // address. A site may publish its whole reference from the specification,
  // and then no source page names a single operation while every one of them
  // is documented.
  const built = await builtSite(cwd, config);
  if (wanted === 'auto' && built === null) {
    skipped.push(
      'openapi: coverage needs the built site, and none was found. Set docs.buildDir, or build before running, or set checks.openapi.coverage to always to count what the source names instead',
    );
  }
  const counting = wanted !== 'never' && (built !== null || wanted === 'always');

  for (const app of withSpec) {
    const spec = app.openapi!.spec;
    const file = path.resolve(cwd, spec);
    const { operations, unresolved } = await openapi.readSpec(file);
    const shown = path.isAbsolute(spec) ? path.basename(spec) : spec;
    if (unresolved.length > 0) {
      skipped.push(
        `openapi: ${unresolved.length} path item(s) in ${shown} point outside the document and were not read`,
      );
    }
    every.push(...operations);
    if (!counting) continue;
    const served =
      built === null ? null : await publishedPaths(built, operations.map((o) => o.path));
    findings.push(...openapi.checkCoverage(pages, operations, shown, app.name, served));
  }

  findings.push(...openapi.checkCitations(cited, every, withSpec.map((a) => a.name)));
  return findings;
}

interface Pass {
  pages: DocPage[];
  evidence: Evidence | null;
  findings: Finding[];
  ran: string[];
  skipped: string[];
}

async function checkAll(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  docsRoot: string,
  evidence: Evidence | null,
  untouched: ((page: string) => boolean) | null = null,
  earlier = false,
  models: RouteModels = { now: null, then: null },
): Promise<Pass> {
  const skipped: string[] = [];
  for (const snapshot of evidence?.now ?? []) {
    if (snapshot.refused !== undefined) {
      skipped.push(`opening ${snapshot.app}: ${snapshot.refused}`);
    }
  }
  const ran: string[] = [];
  if (config.checks.links !== false) ran.push('links');
  if (config.checks.configKeys !== false) ran.push('config-keys');
  if (config.checks.openapi !== false) ran.push('openapi');
  if (config.checks.strings !== false) ran.push('strings');
  if (config.checks.moved !== false) ran.push('moved');
  if (config.checks.undocumented !== false) ran.push('undocumented');

  const findings = (
    await Promise.all([
      runLinks(pages, cwd, config, docsRoot, skipped, earlier, models),
      runConfigKeys(pages, cwd, config, skipped, earlier ? (evidence?.now ?? []) : null),
      runOpenapi(pages, cwd, config, skipped, docsRoot),
      runStrings(pages, config, evidence, skipped),
      runMoved(pages, config, evidence, untouched, skipped),
      runUndocumented(pages, config, evidence, skipped),
    ])
  ).flat();

  const names = new Set(skipped.map((s) => s.split(':')[0] as string));
  return { pages, evidence, findings, ran: ran.filter((r) => !names.has(r)), skipped };
}

// The same documentation as it was, so a problem that predates this change can
// be told apart from one this change introduced.
async function docsAsThen(
  docsRoot: string,
  config: PagebeamConfig,
  sinceDays: number,
): Promise<{ pages: DocPage[]; rev: string } | null> {
  if (!(await history.isRepository(docsRoot))) return null;
  const rev = await history.revisionBefore(docsRoot, sinceDays);
  if (rev === null) return null;

  // A listing that fails is a broken repository, not missing history.
  const top = await history.filesAt(docsRoot, rev);
  if (top.length === 0) return null;

  const files = top.filter((f) =>
    picomatch.isMatch(f, config.docs.include, { ignore: config.docs.exclude }),
  );
  if (files.length === 0) return null;

  const pages = await parseAll(docsRoot, files, (relative) =>
    history.readAt(docsRoot, rev, relative),
  );
  return { pages, rev };
}

// A check that proves a page is wrong cannot always say what it should say
// instead. Where a router is configured it is asked, once per finding, with
// the page and the evidence already gathered. It is never asked to find
// anything: the problem was established before it was called, and a draft it
// returns is marked as its own so nothing applies it unreviewed.
// Enough of the source for a model to see what a control does, and not so
// much that the reading costs more than the page is worth.
const SOURCE_BUDGET = 120_000;

function readingFor(
  finding: Finding,
  snapshots: Snapshot[],
  told: string[],
): { path: string; text: string }[] {
  const named = finding.evidence.find((e) => e.kind === 'files')?.detail;
  if (named === undefined) return [];
  const wanted = new Set(named.split('\n').filter((f) => f !== ''));

  const found: { path: string; text: string }[] = [];
  let spent = 0;
  for (const snapshot of snapshots) {
    if (finding.app !== undefined && snapshot.app !== finding.app) continue;
    for (const file of snapshot.files) {
      if (!wanted.has(file.path) || spent + file.text.length > SOURCE_BUDGET) continue;
      found.push(file);
      spent += file.text.length;
    }
  }
  // Nothing leaves without being named, and a file that looks like it carries
  // a credential does not leave at all.
  const { sending, held } = withheld(found);
  for (const one of held) told.push(`model: ${one.path} was not sent: it looks like it holds ${one.because}`);
  if (sending.length > 0) {
    told.push(`model: sent ${sending.length} source file(s) to ${
      ''}the configured provider: ${sending.map((f) => f.path).join(', ')}`);
  }
  if (spent >= SOURCE_BUDGET) {
    told.push('model: the source did not all fit, so some of it was not sent');
  }
  return sending;
}

// A draft is a claim that the problem is gone. Nothing is proposed on the
// strength of a claim: the checks run again with the drafted page in place.
// The finding must be gone, and the page must not bring a finding the
// documentation did not already have.
export type Recheck = (pages: DocPage[]) => Promise<Finding[]>;

async function accepted(
  finding: Finding,
  drafted: Finding,
  was: string | null,
  told: string[],
  context: { pages: DocPage[]; docsRoot: string; recheck: Recheck; baseline: Set<string> },
): Promise<Finding> {
  const change = drafted.fix?.changes[0];
  const contents = change?.contents;
  if (change === undefined || typeof contents !== 'string') return finding;

  const refuse = (because: string): Finding => {
    told.push(`model: the page drafted for ${finding.doc.path} was not proposed: ${because}`);
    return finding;
  };

  const refused = await settles(drafted, was, contents);
  if (refused !== null) return refuse(refused.because);

  const [page] = await parseAll(context.docsRoot, [change.path], async () => contents);
  if (page === undefined) return refuse('the page it wrote could not be read as a page');
  const candidate = [...context.pages.filter((p) => p.path !== change.path), page];
  const after = await context.recheck(candidate);

  if (after.some((f) => f.id === finding.id)) return refuse('the checks still find what it was asked to fix');
  const added = after.find((f) => f.doc.path === change.path && !context.baseline.has(f.id));
  if (added !== undefined) return refuse(`it adds a new finding: ${added.title}`);

  return drafted;
}

async function mend(
  cwd: string,
  config: PagebeamConfig,
  pages: DocPage[],
  findings: Finding[],
  snapshots: Snapshot[],
  told: string[],
  docsRoot: string,
  recheck: Recheck,
  baseline: Set<string>,
): Promise<Finding[]> {
  const settings = config.model;
  const context = { pages, docsRoot, recheck, baseline };
  if (settings === undefined) return findings;

  // A check says whether a model is asked for what it found. Saying nothing
  // means whatever was said for all of them.
  const asking = (check: string): boolean => {
    const named: Record<string, unknown> = {
      links: config.checks.links,
      'config-keys': config.checks.configKeys,
      openapi: config.checks.openapi,
      strings: config.checks.strings,
      moved: config.checks.moved,
      undocumented: config.checks.undocumented,
    };
    const own = named[check];
    const said = own !== false && own !== undefined ? (own as { enrich?: boolean }).enrich : undefined;
    return said ?? settings.enrich;
  };
  if (!config.checks && !settings.enrich) return findings;

  const router = {
    baseUrl: settings.baseUrl,
    model: settings.name,
    timeoutMs: settings.timeoutMs,
    headers: settings.headers,
    ...(settings.apiKeyEnv ? { apiKey: process.env[settings.apiKeyEnv] } : {}),
  };
  const sourceOf = new Map(pages.map((page) => [page.path, page.raw]));
  const skills = await Promise.all(
    settings.skills.map(async (named) => {
      const at = path.resolve(cwd, named);
      try {
        return `--- ${named} ---\n${await readFile(at, 'utf8')}`;
      } catch {
        // A file the configuration names and nobody can read is the same
        // mistake as a setting that does not exist.
        throw new Error(`model.skills names ${named}, which could not be read`);
      }
    }),
  );

  // A model rewrites a whole page. Two drafts of one page, each made from the
  // page as it was, would each undo the other when both are written, and a
  // draft made without the exact edits already found for that page would undo
  // those. So drafts for one page are made one after another, each from the
  // page with every change before it in place, and different pages in
  // parallel. The page's last change then holds all of them.
  const current = new Map<string, string>();
  const baseOf = (at: string): string | undefined => {
    const now = current.get(at);
    if (now !== undefined) return now;
    const raw = sourceOf.get(at);
    if (raw === undefined) return undefined;
    const exact = findings.filter((f) => f.fix !== undefined && f.fix.author !== 'model');
    const text = withChanges(raw, exact.flatMap((f) => f.fix!.changes.filter((c) => c.path === at)));
    current.set(at, text);
    return text;
  };
  const pagesWith = (at: string, text: string): DocPage[] =>
    context.pages.map((p) => (p.path === at ? { ...p, raw: text } : p));

  const answers = new Map<Finding, Finding>();
  const queues = new Map<string, (() => Promise<void>)[]>();
  const queue = (at: string, job: () => Promise<void>) => queues.set(at, [...(queues.get(at) ?? []), job]);

  for (const finding of findings) {
    if (finding.fix !== undefined || !asking(finding.check)) continue;

    if (sourceOf.has(finding.doc.path)) {
      const at = finding.doc.path;
      queue(at, async () => {
        const page = baseOf(at)!;
        const drafted = await draft(router, finding, page, skills);
        if (drafted === null) return;
        const kept = await accepted(finding, drafted, page, told, { ...context, pages: pagesWith(at, page) });
        if (kept === finding) return;
        answers.set(finding, kept);
        const text = kept.fix?.changes[0]?.contents;
        if (typeof text === 'string') current.set(at, text);
      });
      continue;
    }

    // A screen nobody documented names no page, because the page is what is
    // missing. Where one would sit is worked out from the area it covers.
    if (finding.check !== 'undocumented') continue;
    const target = placeFor(finding, pages);
    if (target === null) continue;
    queue(target.path, async () => {
      const existing = current.get(target.path) ?? target.existing ?? null;
      const source = settings.sendSource ? readingFor(finding, snapshots, told) : [];
      const withSource: Target = {
        ...target,
        ...(existing === null ? {} : { existing }),
        ...(source.length === 0 ? {} : { source }),
      };
      const written = await compose(router, finding, withSource, skills);
      if (written === null) return;
      const kept = await accepted(finding, written, existing, told, context);
      if (kept === finding) return;
      answers.set(finding, kept);
      const text = kept.fix?.changes[0]?.contents;
      if (typeof text === 'string') current.set(target.path, text);
    });
  }

  await Promise.all(
    [...queues.values()].map(async (jobs) => {
      for (const job of jobs) await job();
    }),
  );
  return findings.map((finding) => answers.get(finding) ?? finding);
}

// A page's text with exact edits applied: spans from the last backwards, so an
// edit never moves the one after it, and a whole replacement taken as it is.
function withChanges(text: string, changes: FileChange[]): string {
  const whole = changes
    .map((c) => (c.splice === undefined ? c.contents : undefined))
    .filter((t): t is string => typeof t === 'string');
  if (whole.length > 0) return whole[whole.length - 1]!;
  let out = text;
  for (const c of [...changes].filter((c) => c.splice !== undefined).sort((a, b) => b.splice!.start - a.splice!.start)) {
    out = out.slice(0, c.splice!.start) + c.splice!.text + out.slice(c.splice!.end);
  }
  return out;
}

// Where a page covering this area would go, and something to model it on. The
// name is taken from the area rather than invented, so the same area proposes
// the same page every run instead of a new one.
function placeFor(finding: Finding, pages: DocPage[]): Target | null {
  const example = pages.find((page) => page.raw.trim() !== '');
  if (example === undefined) return null;

  const extension = path.extname(example.path) || '.md';
  const directory = path.dirname(example.path);
  // Named after the area, with the shape of a source tree taken off it: a
  // reader looks for "dashboard", not for the file extension it happens to
  // have been written in.
  const named = (finding.doc.path.split('/').pop() ?? finding.doc.path)
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  if (named === '') return null;

  const at = path.posix.join(directory === '.' ? '' : directory, `${named}${extension}`);
  const already = pages.find((page) => page.path === at);

  return already === undefined
    ? { path: at, example: { path: example.path, text: example.raw } }
    : { path: at, existing: already.raw };
}

export interface Asking {
  // Whether anything will be done with a change if one is drafted. Reporting
  // does not propose, so a run that only reports has no reason to put a
  // finding to a model, and no reason to spend anything doing it.
  proposing?: boolean | undefined;
}

export async function run(cwd: string, asking: Asking = {}): Promise<RunResult> {
  try {
    return await attempt(cwd, asking.proposing === true);
  } catch (error) {
    // A file that could not be read is not a file with nothing in it.
    return {
      problem: (error as Error).message,
      degraded: [],
      comparedWith: null,
      grade: null,
      configFrom: null,
      pages: 0,
      apps: [],
      findings: [],
      ran: [],
      skipped: [],
    };
  }
}

async function attempt(cwd: string, proposing: boolean): Promise<RunResult> {
  const { config, from, asked } = await loadConfig(cwd);
  // Without one, the only thing to check documentation against is a guess at
  // where it is, and a clean answer from a guess is worse than no answer.
  if (from === null) throw new NoConfig(cwd);
  const ignores = new Ignores(await loadIgnores(cwd));
  const docsRoot = path.resolve(cwd, config.docs.root);
  const files = await discover(docsRoot, config.docs.include, config.docs.exclude);
  const pages = await parseAll(docsRoot, files);
  if (pages.length === 0) {
    return {
      problem: `No documentation was found under ${docsRoot} matching ${config.docs.include.join(', ')}.`,
      degraded: [],
      comparedWith: null,
      grade: null,
      configFrom: from,
      pages: 0,
      apps: config.apps.map((a) => a.name),
      findings: [],
      ran: [],
      skipped: [],
    };
  }

  const evidence = await gather(cwd, config);

  // The baseline is how things stood on both sides. Using today's applications
  // with yesterday's documentation would mean a control renamed in the product
  // could never count as a problem this change introduced.
  const then = await docsAsThen(docsRoot, config, config.history.sinceDays);
  const editedPages =
    then === null ? null : new Set(await history.changedBetween(docsRoot, then.rev));
  const untouched =
    editedPages === null ? null : (page: string) => ![...editedPages].some((f) => f.endsWith(page));
  const models: RouteModels = { now: null, then: null };
  const pass = await checkAll(pages, cwd, config, docsRoot, evidence, untouched, false, models);
  const { ran, skipped } = pass;

  // Only the label and movement checks are fed a genuine earlier state. The
  // others would be comparing yesterday's documentation with today's build,
  // specification and example files, so their age is not known and is not
  // guessed at.
  // A check may only be told apart by age when its earlier pass was fed
  // genuinely earlier inputs. Documentation alone is enough for links; the
  // others also need every application to have a past.
  const NEEDS_DOCS = new Set(['links']);
  const NEEDS_APPS = new Set(['strings', 'moved', 'config-keys']);
  const known = new Set<string>();
  if (then !== null) {
    const asThen: Evidence | null =
      evidence === null
        ? null
        : {
            now: evidence.before ?? evidence.now,
            before: null,
            complete: false,
            movement: [],
            grade: { source: evidence.grade.source, depth: 'single' },
          };
    const earlier = await checkAll(then.pages, cwd, config, docsRoot, asThen, null, true, models);
    for (const f of earlier.findings) known.add(f.id);
  }

  const appsHaveAPast = evidence !== null && evidence.before !== null && evidence.complete;
  const comparable = (check: string): boolean => {
    if (then === null) return false;
    // The earlier pass never reads today's build, so when the present one did,
    // the two are judging routes by different rules and no age follows.
    if (NEEDS_DOCS.has(check)) return models.now === models.then;
    return NEEDS_APPS.has(check) && appsHaveAPast;
  };

  const findings = pass.findings
    .map((f) => ({ ...f, introduced: comparable(f.check) ? !known.has(f.id) : null }))
    .filter((f) => !ignores.silences(f));

  const unique = new Map<string, Finding>();
  for (const f of findings) if (!unique.has(f.id)) unique.set(f.id, f);
  const deduped = [...unique.values()];

  const mended = proposing
    ? await mend(
        cwd,
        config,
        pass.pages,
        deduped,
        pass.evidence?.now ?? [],
        skipped,
        docsRoot,
        async (candidate) =>
          (await checkAll(candidate, cwd, offline(config), docsRoot, evidence, untouched, false, { now: null, then: null }))
            .findings,
        new Set(pass.findings.map((f) => f.id)),
      )
    : deduped;

  const order = { error: 0, warn: 1, info: 2 } as const;
  mended.sort((a, b) => order[a.severity] - order[b.severity] || a.doc.path.localeCompare(b.doc.path));

  const comparedWith = then?.rev ?? null;
  const skippedNames = new Set(skipped.map((s) => s.split(':')[0] as string));
  // A check nobody asked for and which has no input is not applicable. One that
  // was configured and could not run means the answer is incomplete.
  const configured = new Map([
    ['config-keys', 'configKeys'],
    ['openapi', 'openapi'],
    ['strings', 'strings'],
    ['links', 'links'],
  ]);
  // Declaring where an application runs is asking for it to be opened, so
  // failing to open it leaves the answer short of what was asked for.
  const refusedToOpen = (evidence?.now ?? [])
    .filter((s) => s.refused !== undefined)
    .map((s) => `opening ${s.app}`);
  const degraded = [
    ...[...skippedNames].filter((name) => asked.has(configured.get(name) ?? name)),
    ...refusedToOpen,
  ];
  return {
    problem: null,
    degraded,
    comparedWith,
    grade: evidence?.grade ?? null,
    configFrom: from,
    pages: pages.length,
    apps: config.apps.map((a) => a.name),
    findings: mended,
    ran: ran.filter((r) => !skippedNames.has(r)),
    skipped,
    recheckAt: async (root) => {
      const found = await parseAll(root, await discover(root, config.docs.include, config.docs.exclude));
      const again = await checkAll(found, cwd, offline(config), root, evidence, untouched, false, {
        now: null,
        then: null,
      });
      return again.findings.filter((f) => !ignores.silences(f));
    },
  };
}
