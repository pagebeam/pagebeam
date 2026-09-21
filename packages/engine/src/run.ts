import path from 'node:path';
import { stat } from 'node:fs/promises';
import { Ignores, type Finding, type PagebeamConfig } from '@pagebeam/core';
import { discover, parseAll, type DocPage } from '@pagebeam/docs';
import { configKeys, links, openapi } from '@pagebeam/checks';
import { loadConfig, loadIgnores } from './load.js';

export interface RunResult {
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
): Promise<links.RouteSet> {
  const publicDir = config.docs.publicDir ? path.resolve(cwd, config.docs.publicDir) : undefined;
  const declared = config.docs.buildDir ? path.resolve(cwd, config.docs.buildDir) : null;
  const candidates = declared ? [declared] : [path.join(cwd, 'dist'), path.join(cwd, 'build')];

  for (const dir of candidates) {
    if (!(await exists(dir))) continue;
    const routes = await links.routesFromBuild(dir);
    if (routes.size > 0) return { routes, source: 'build', ...(publicDir ? { publicDir } : {}) };
  }
  return { routes: links.routesOf(pages), source: 'content', ...(publicDir ? { publicDir } : {}) };
}

async function runLinks(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
): Promise<Finding[]> {
  if (config.checks.links === false) return [];
  const set = await routeSet(pages, cwd, config);
  return links.checkLinks(pages, set, { external: config.checks.links.external });
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
  for (const app of withSpec) {
    const spec = app.openapi!.spec;
    const file = path.resolve(cwd, spec);
    const ops = await openapi.readSpec(file);
    const shown = path.isAbsolute(spec) ? path.basename(spec) : spec;
    findings.push(
      ...openapi.checkCitations(cited, ops, app.name),
      ...openapi.checkCoverage(pages, ops, shown, app.name),
    );
  }
  return findings;
}

export async function run(cwd: string): Promise<RunResult> {
  const { config, from } = await loadConfig(cwd);
  const ignores = new Ignores(await loadIgnores(cwd));
  const docsRoot = path.resolve(cwd, config.docs.root);
  const files = await discover(docsRoot, config.docs.include, config.docs.exclude);
  const pages = await parseAll(docsRoot, files);
  const skipped: string[] = [];
  const ran: string[] = [];
  if (config.checks.links !== false) ran.push('links');
  if (config.checks.configKeys !== false) ran.push('config-keys');
  if (config.checks.openapi !== false) ran.push('openapi');

  const findings = (
    await Promise.all([
      runLinks(pages, cwd, config),
      runConfigKeys(pages, cwd, config, skipped),
      runOpenapi(pages, cwd, config, skipped),
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
    configFrom: from,
    pages: pages.length,
    apps: config.apps.map((a) => a.name),
    findings: deduped,
    ran: ran.filter((r) => !skippedNames.has(r)),
    skipped,
  };
}
