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
import { envReads, history, screensOf, snapshot } from '@pagebeam/app';
import { buildSite, OUTPUTS, siteOf, type Site } from './site.js';
import picomatch from 'picomatch';
import { discover, parseAll, type DocPage } from '@pagebeam/docs';
import { configKeys, links, moved, openapi, strings, undocumented } from '@pagebeam/checks';
import { compose, draft, withheld, type Target } from '@pagebeam/model';
import { loadConfig, loadIgnores, NoConfig } from './load.js';
import { PAGE_LIMIT, publishedPaths } from './published.js';
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
  recheckAt?: (docsRoot: string) => Promise<Finding[]>;
  build?: ({ dir: string; command: string } | { failed: string; command: string | null } | { skipped: string }) & {
    framework: string | null;
  };
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
    for (const key of await envReads(root, app.exclude)) defined.add(key);
    searched.push(app.name);
  }
  return configKeys.compare(configKeys.documentedKeys(pages), defined, searched);
}

async function exists(dir: string): Promise<boolean> {
  return stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

const sites = new Map<string, Promise<Site | null>>();

// A `docs.format` written in the config says where the pages are, whatever
// the detection found.
async function siteFor(docsRoot: string, config: PagebeamConfig): Promise<Site | null> {
  if (!sites.has(docsRoot)) sites.set(docsRoot, siteOf(docsRoot));
  const site = await sites.get(docsRoot)!;
  if (site === null) return null;
  const format = config.docs.format;
  if (format === 'starlight') return { ...site, content: path.join(site.dir, 'src/content/docs') };
  if (format === 'astro') return { ...site, content: path.join(site.dir, 'src/pages') };
  return site;
}

// The folder a build asked for in this run wrote, by the docs it was for.
const justBuilt = new Map<string, string>();

function buildCandidates(cwd: string, config: PagebeamConfig, site: Site | null, docsRoot: string): { dirs: string[]; declared: boolean } {
  if (config.docs.buildDir) return { dirs: [path.resolve(cwd, config.docs.buildDir)], declared: true };
  const fresh = justBuilt.get(docsRoot);
  const near = [cwd, ...(site === null ? [] : [site.dir])];
  const output = site === null ? [] : [...(site.output ? [site.output] : []), ...OUTPUTS].map((o) => path.join(site.dir, o));
  return {
    dirs: [...new Set([...(fresh === undefined ? [] : [fresh]), ...output, ...near.flatMap((d) => [path.join(d, 'dist'), path.join(d, 'build')])])],
    declared: false,
  };
}

// The build the link check validated, so both checks read one site.
async function builtSite(pages: DocPage[], cwd: string, config: PagebeamConfig, docsRoot: string): Promise<string | null> {
  const set = await routeSet(pages, cwd, config, docsRoot, false);
  return set.source === 'build' ? (set.builtDir ?? null) : null;
}

// Routes the source pages publish. A framework that keeps its pages in a
// content folder serves them from the site root, so the folder is not part of
// the address, whether the configured root holds that folder or sits in it.
function sourceRoutes(pages: DocPage[], config: PagebeamConfig, docsRoot: string, site: Site | null): Set<string> {
  const prefix = config.docs.routeBase.replace(/\/+$/, '');
  const content = site?.content ?? null;
  if (content !== null) {
    const down = path.relative(docsRoot, content);
    if (down === '' || (!down.startsWith('..') && !path.isAbsolute(down))) {
      return links.routesOf(pages, down.split(path.sep).join('/'), prefix);
    }
    const up = path.relative(content, docsRoot);
    if (!up.startsWith('..') && !path.isAbsolute(up)) {
      return links.routesOf(pages, '', `${prefix}/${up.split(path.sep).join('/')}`);
    }
  }
  return links.routesOf(pages, links.baseFromPatterns(config.docs.include), prefix);
}

async function routeSet(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  docsRoot: string,
  earlier: boolean,
): Promise<links.RouteSet> {
  const site = await siteFor(docsRoot, config);
  const publicDir = config.docs.publicDir
    ? path.resolve(cwd, config.docs.publicDir)
    : site !== null && (await exists(path.join(site.dir, 'public')))
      ? path.join(site.dir, 'public')
      : undefined;
  const { dirs: candidates, declared } = buildCandidates(cwd, config, site, docsRoot);

  const prefix = config.docs.routeBase.replace(/\/+$/, '');
  let fromSource = sourceRoutes(pages, config, docsRoot, site);

  for (const dir of candidates) {
    if (!(await exists(dir))) continue;
    const routes = await links.routesFromBuild(dir);
    if (routes.size === 0) continue;

    // Where the source does not say how a path becomes an address, the build
    // does. The same folder is dropped at every revision, so an earlier pass
    // learns it here too.
    const shared = (from: Set<string>) => [...from].filter((r) => routes.has(r)).length / Math.max(from.size, 1);
    if (shared(fromSource) < 0.5) {
      const base = links.learnedBase(pages, routes, prefix);
      if (base !== null) fromSource = links.routesOf(pages, base, prefix);
    }

    // The build on disk is today's. Comparing yesterday's pages against it
    // would let a route deleted today make an old link look like it was
    // always broken.
    if (earlier) break;

    // A build guessed at rather than declared has to be shown to belong to
    // this documentation: most of what the source publishes must be in it.
    if (!declared && (fromSource.size === 0 || shared(fromSource) < 0.5)) continue;
    return { routes, source: 'build', builtDir: dir, docsRoot, ...(publicDir ? { publicDir } : {}) };
  }
  return { routes: fromSource, source: 'content', docsRoot, ...(publicDir ? { publicDir } : {}) };
}

export interface RouteModels {
  now: 'build' | 'content' | null;
  then: 'build' | 'content' | null;
}

// One reacher per run, shared by the rechecks of a proposal: an address is
// asked once, and only a link a proposal adds costs a new request.
const reachers = new WeakMap<PagebeamConfig, (href: string) => Promise<links.Verdict>>();
function reacherFor(
  config: PagebeamConfig,
  options: { timeoutMs: number; concurrency: number; allowlist: string[] },
): (href: string) => Promise<links.Verdict> {
  let reach = reachers.get(config);
  if (reach === undefined) {
    reach = reacher({ timeoutMs: options.timeoutMs, concurrency: options.concurrency, allowlist: options.allowlist });
    reachers.set(config, reach);
  }
  return reach;
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
  if (options.external && !earlier) set.reach = reacherFor(config, options);
  const outcome = await links.checkLinks(pages, set, { external: options.external });
  if (outcome.unaddressed !== undefined) {
    skipped.push(
      `links: ${outcome.unaddressed.missed} of ${outcome.unaddressed.total} links to site addresses match no page worked out from the source files, so the addresses are what is wrong, not the links. They were not checked. Build the site, or set docs.buildDir to where it is built`,
    );
  }
  if (outcome.external.unknown > 0) {
    skipped.push(
      `links: ${outcome.external.unknown} external address(es) could not be reached either way, so they are unchecked rather than sound`,
    );
  }
  return outcome.findings;
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
  for (const snapshot of evidence?.now ?? []) {
    const unread = snapshot.unparsed[0];
    if (unread !== undefined) {
      const more = snapshot.unparsed.length > 1 ? ` and ${snapshot.unparsed.length - 1} more` : '';
      skipped.push(`undocumented: ${snapshot.app} has files whose controls could not be read: ${unread.file} (${unread.reason})${more}`);
    }
  }
  if (evidence === null || evidence.now.every((s) => s.labels.length === 0)) {
    skipped.push('undocumented: no application has controls that could be read');
    return [];
  }
  for (const snapshot of evidence.now) {
    const why = screensOf(snapshot.files, snapshot.routeConfig ?? []).incomplete;
    if (why !== undefined) skipped.push(`undocumented: ${snapshot.app} may have screens it did not find: ${why}`);
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
  const built = await builtSite(pages, cwd, config, docsRoot);
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
    const published = built === null ? null : await publishedPaths(built, operations);
    if (published !== null && !published.complete) {
      skipped.push(
        `openapi: the built site has more than ${PAGE_LIMIT} pages, so it was not read in full and ${shown} coverage was not counted`,
      );
      continue;
    }
    findings.push(...openapi.checkCoverage(pages, operations, shown, app.name, published?.found ?? null));
  }

  // What a component renders is not known from its attributes, so an
  // operation named only there is held against the specification once the
  // built site shows it to a reader.
  const attributed = cited.filter((c) => c.attribute === true);
  const shownOnSite =
    built === null || attributed.length === 0
      ? new Set<string>()
      : (await publishedPaths(built, attributed)).found;
  const held = cited.filter((c) => c.attribute !== true || shownOnSite.has(`${c.method.toUpperCase()} ${c.path}`));
  if (held.length < cited.length) {
    skipped.push(
      `openapi: ${cited.length - held.length} operation(s) named only in component attributes were not checked against the specification, because the built site ${built === null ? 'was not found' : 'does not show them'}`,
    );
  }
  findings.push(...openapi.checkCitations(held, every, withSpec.map((a) => a.name)));
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
  const left: string[] = [];
  let spent = 0;
  for (const snapshot of snapshots) {
    if (finding.app !== undefined && snapshot.app !== finding.app) continue;
    for (const file of snapshot.files) {
      if (!wanted.has(file.path)) continue;
      if (spent + file.text.length > SOURCE_BUDGET) {
        left.push(file.path);
        continue;
      }
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
  if (left.length > 0) {
    told.push(`model: ${left.length} source file(s) did not fit and were not sent: ${left.join(', ')}`);
  }
  return sending;
}

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

  // A draft replaces the whole page, so drafts for one page run in order, each
  // from the page with every earlier change in it, or they undo each other.
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

  // Findings are sorted by severity before they are written, which can put an
  // earlier draft of a page after a later one. Each carries the page's final
  // text, so the order they are written in cannot matter.
  for (const [finding, kept] of answers) {
    const change = kept.fix?.changes[0];
    const last = change === undefined ? undefined : current.get(change.path);
    if (change === undefined || last === undefined) continue;
    answers.set(finding, { ...kept, fix: { ...kept.fix!, changes: [{ ...change, contents: last }] } });
  }
  return findings.map((finding) => answers.get(finding) ?? finding);
}

// Spans from the last backwards, so an edit never moves the one after it.
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
  // `always` builds whatever site the docs belong to. `auto` builds only a
  // site of their own that a framework is recognised in, and says why not
  // otherwise. Either way a build that was started and failed degrades the run.
  build?: 'always' | 'auto' | undefined;
}

export async function run(cwd: string, asking: Asking = {}): Promise<RunResult> {
  try {
    return await attempt(cwd, asking.proposing === true, asking.build);
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

async function attempt(cwd: string, proposing: boolean, building: Asking['build']): Promise<RunResult> {
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

  let build: RunResult['build'];
  if (building !== undefined) {
    const site = await siteFor(docsRoot, config);
    const isApp = site !== null && config.apps.some((a) => path.resolve(cwd, a.path) === site.dir);
    const framework = site?.framework?.name ?? null;
    if (building === 'auto' && (site === null || site.framework === null || isApp)) {
      build = {
        skipped:
          site === null || site.framework === null
            ? 'no site generator was recognised for the docs'
            : `the docs are part of ${path.relative(cwd, site.dir) || 'this application'}, not a site of their own`,
        framework,
      };
    } else if (site === null) {
      build = { failed: `no documentation site was found at or above ${docsRoot}`, command: null, framework };
    } else {
      const done = await buildSite(site);
      if ('dir' in done) justBuilt.set(docsRoot, done.dir);
      build = { ...done, framework };
    }
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
          (await checkAll(candidate, cwd, config, docsRoot, evidence, untouched, false, { now: null, then: null }))
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
    ...(build !== undefined && 'failed' in build ? ['building the docs site'] : []),
  ];
  return {
    problem: null,
    degraded,
    ...(build === undefined ? {} : { build }),
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
      const again = await checkAll(found, cwd, config, root, evidence, untouched, false, {
        now: null,
        then: null,
      });
      return again.findings.filter((f) => !ignores.silences(f));
    },
  };
}
