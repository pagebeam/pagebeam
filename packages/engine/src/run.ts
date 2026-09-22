import path from 'node:path';
import { stat } from 'node:fs/promises';
import {
  Ignores,
  bestSource,
  type Finding,
  type Grade,
  type PagebeamConfig,
  type Snapshot,
} from '@pagebeam/core';
import { history, snapshot } from '@pagebeam/app';
import picomatch from 'picomatch';
import { discover, parseAll, type DocPage } from '@pagebeam/docs';
import { configKeys, links, moved, openapi, strings } from '@pagebeam/checks';
import { loadConfig, loadIgnores } from './load.js';
import { reacher } from './reach.js';

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

async function routeSet(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  docsRoot: string,
  earlier: boolean,
): Promise<links.RouteSet> {
  const publicDir = config.docs.publicDir ? path.resolve(cwd, config.docs.publicDir) : undefined;
  const declared = config.docs.buildDir ? path.resolve(cwd, config.docs.buildDir) : null;
  const candidates = declared ? [declared] : [path.join(cwd, 'dist'), path.join(cwd, 'build')];

  // The build on disk is today's. Comparing yesterday's pages against it would
  // let a route deleted today make an old link look like it was always broken.
  for (const dir of earlier ? [] : candidates) {
    if (!(await exists(dir))) continue;
    const routes = await links.routesFromBuild(dir);
    if (routes.size > 0) {
      return { routes, source: 'build', docsRoot, ...(publicDir ? { publicDir } : {}) };
    }
  }
  const base = links.baseFromPatterns(config.docs.include);
  const prefix = config.docs.routeBase.replace(/\/+$/, '');
  return { routes: links.routesOf(pages, base, prefix), source: 'content', docsRoot, ...(publicDir ? { publicDir } : {}) };
}

async function runLinks(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  docsRoot: string,
  skipped: string[],
  earlier: boolean,
): Promise<Finding[]> {
  if (config.checks.links === false) return [];
  const options = config.checks.links;
  const set = await routeSet(pages, cwd, config, docsRoot, earlier);
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
        ? { baseUrl: app.url, routes: app.routes, timeoutMs: app.renderTimeoutMs }
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

async function runOpenapi(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  skipped: string[],
): Promise<Finding[]> {
  if (config.checks.openapi === false) return [];
  const withSpec = config.apps.filter((a) => a.openapi?.spec !== undefined);
  if (withSpec.length === 0) {
    skipped.push('openapi: no application declares a specification');
    return [];
  }

  const cited = openapi.citations(pages);
  const findings: Finding[] = [];
  const every: openapi.Operation[] = [];

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
    findings.push(...openapi.checkCoverage(pages, operations, shown, app.name));
  }

  const names = withSpec.map((a) => a.name).join(', ');
  findings.push(...openapi.checkCitations(cited, every, names));
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
): Promise<Pass> {
  const skipped: string[] = [];
  const ran: string[] = [];
  if (config.checks.links !== false) ran.push('links');
  if (config.checks.configKeys !== false) ran.push('config-keys');
  if (config.checks.openapi !== false) ran.push('openapi');
  if (config.checks.strings !== false) ran.push('strings');
  if (config.checks.moved !== false) ran.push('moved');

  const findings = (
    await Promise.all([
      runLinks(pages, cwd, config, docsRoot, skipped, earlier),
      runConfigKeys(pages, cwd, config, skipped, earlier ? (evidence?.now ?? []) : null),
      runOpenapi(pages, cwd, config, skipped),
      runStrings(pages, config, evidence, skipped),
      runMoved(pages, config, evidence, untouched, skipped),
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

  const top = await history.filesAt(docsRoot, rev).catch(() => [] as string[]);
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

export async function run(cwd: string): Promise<RunResult> {
  try {
    return await attempt(cwd);
  } catch (error) {
    // Something on disk refused to be read. Reporting nothing found would be a
    // lie about a file nobody looked at.
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

async function attempt(cwd: string): Promise<RunResult> {
  const { config, from, asked } = await loadConfig(cwd);
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
  const pass = await checkAll(pages, cwd, config, docsRoot, evidence, untouched);
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
    const earlier = await checkAll(then.pages, cwd, config, docsRoot, asThen, null, true);
    for (const f of earlier.findings) known.add(f.id);
  }

  const appsHaveAPast = evidence !== null && evidence.before !== null && evidence.complete;
  const comparable = (check: string): boolean => {
    if (then === null) return false;
    if (NEEDS_DOCS.has(check)) return true;
    return NEEDS_APPS.has(check) && appsHaveAPast;
  };

  const findings = pass.findings
    .map((f) => ({ ...f, introduced: comparable(f.check) ? !known.has(f.id) : null }))
    .filter((f) => !ignores.silences(f));

  const unique = new Map<string, Finding>();
  for (const f of findings) if (!unique.has(f.id)) unique.set(f.id, f);
  const deduped = [...unique.values()];

  const order = { error: 0, warn: 1, info: 2 } as const;
  deduped.sort((a, b) => order[a.severity] - order[b.severity] || a.doc.path.localeCompare(b.doc.path));

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
  const degraded = [...skippedNames].filter((name) => asked.has(configured.get(name) ?? name));
  return {
    problem: null,
    degraded,
    comparedWith,
    grade: evidence?.grade ?? null,
    configFrom: from,
    pages: pages.length,
    apps: config.apps.map((a) => a.name),
    findings: deduped,
    ran: ran.filter((r) => !skippedNames.has(r)),
    skipped,
  };
}
