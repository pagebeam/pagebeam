import path from 'node:path';
import { stat } from 'node:fs/promises';
import { Ignores, type Finding, type PagebeamConfig } from '@pagebeam/core';
import { discover, parseAll, type DocPage } from '@pagebeam/docs';
import { configKeys, links, openapi, strings } from '@pagebeam/checks';
import { loadConfig, loadIgnores } from './load.js';
import { reacher } from './reach.js';

export interface RunResult {
  problem: string | null;
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
): Promise<Finding[]> {
  if (config.checks.configKeys === false) return [];
  const usable = config.apps.filter((a) => a.path !== undefined);
  if (usable.length === 0) {
    skipped.push('config-keys: no application declares a local path');
    return [];
  }

  const defined = new Set<string>();
  const searched: string[] = [];
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
): Promise<links.RouteSet> {
  const publicDir = config.docs.publicDir ? path.resolve(cwd, config.docs.publicDir) : undefined;
  const declared = config.docs.buildDir ? path.resolve(cwd, config.docs.buildDir) : null;
  const candidates = declared ? [declared] : [path.join(cwd, 'dist'), path.join(cwd, 'build')];

  for (const dir of candidates) {
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
): Promise<Finding[]> {
  if (config.checks.links === false) return [];
  const options = config.checks.links;
  const set = await routeSet(pages, cwd, config, docsRoot);
  if (options.external) {
    set.reach = reacher({
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      allowlist: options.allowlist,
    });
  }
  return links.checkLinks(pages, set, { external: options.external });
}

async function runStrings(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  skipped: string[],
): Promise<Finding[]> {
  if (config.checks.strings === false) return [];
  const usable = config.apps.filter((a) => a.path !== undefined);
  if (usable.length === 0) {
    skipped.push('strings: no application declares a local path');
    return [];
  }

  const indexes = [];
  for (const app of usable) {
    const root = rootOf(cwd, app);
    if (root === null) continue;
    indexes.push(await strings.indexApp(app.name, root, app.include, app.exclude));
  }
  return strings.compare(strings.candidates(pages), indexes, config.checks.strings.minConfidence);
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

export async function run(cwd: string): Promise<RunResult> {
  const { config, from } = await loadConfig(cwd);
  const ignores = new Ignores(await loadIgnores(cwd));
  const docsRoot = path.resolve(cwd, config.docs.root);
  const files = await discover(docsRoot, config.docs.include, config.docs.exclude);
  const pages = await parseAll(docsRoot, files);
  if (pages.length === 0) {
    return {
      problem: `No documentation was found under ${docsRoot} matching ${config.docs.include.join(', ')}.`,
      configFrom: from,
      pages: 0,
      apps: config.apps.map((a) => a.name),
      findings: [],
      ran: [],
      skipped: [],
    };
  }

  const skipped: string[] = [];
  const ran: string[] = [];
  if (config.checks.links !== false) ran.push('links');
  if (config.checks.configKeys !== false) ran.push('config-keys');
  if (config.checks.openapi !== false) ran.push('openapi');
  if (config.checks.strings !== false) ran.push('strings');

  const findings = (
    await Promise.all([
      runLinks(pages, cwd, config, docsRoot),
      runConfigKeys(pages, cwd, config, skipped),
      runOpenapi(pages, cwd, config, skipped),
      runStrings(pages, cwd, config, skipped),
    ])
  )
    .flat()
    .filter((f) => !ignores.silences(f));

  const unique = new Map<string, Finding>();
  for (const f of findings) if (!unique.has(f.id)) unique.set(f.id, f);
  const deduped = [...unique.values()];

  const order = { error: 0, warn: 1, info: 2 } as const;
  deduped.sort((a, b) => order[a.severity] - order[b.severity] || a.doc.path.localeCompare(b.doc.path));

  const skippedNames = new Set(skipped.map((s) => s.split(':')[0]));
  return {
    problem: null,
    configFrom: from,
    pages: pages.length,
    apps: config.apps.map((a) => a.name),
    findings: deduped,
    ran: ran.filter((r) => !skippedNames.has(r)),
    skipped,
  };
}
