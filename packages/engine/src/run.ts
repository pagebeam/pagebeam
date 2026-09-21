import path from 'node:path';
import { stat } from 'node:fs/promises';
import { Ignores, type Finding, type PagebeamConfig } from '@pagebeam/core';
import { discover, parseAll, type DocPage } from '@pagebeam/docs';
import { configKeys, links, openapi } from '@pagebeam/checks';
import { loadConfig, loadIgnores } from './load.js';

export interface RunResult {
  configFrom: string | null;
  pages: number;
  findings: Finding[];
  skipped: string[];
}

function appRootOf(cwd: string, config: PagebeamConfig): string | null {
  if (!config.app?.path) return null;
  return path.resolve(cwd, config.app.path);
}

async function runConfigKeys(
  pages: DocPage[],
  cwd: string,
  config: PagebeamConfig,
  skipped: string[],
): Promise<Finding[]> {
  if (config.checks.configKeys === false) return [];
  const appRoot = appRootOf(cwd, config);
  if (appRoot === null) {
    skipped.push('config-keys: no app.path configured');
    return [];
  }
  const documented = configKeys.documentedKeys(pages);
  const defined = await configKeys.definedKeys(appRoot, config.app?.envFiles ?? []);
  return configKeys.compare(documented, defined);
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
  const spec = config.app?.openapi?.spec;
  if (spec === undefined) {
    skipped.push('openapi: no app.openapi.spec configured');
    return [];
  }
  const file = path.resolve(cwd, spec);
  const ops = await openapi.readSpec(file);
  const shown = path.isAbsolute(spec) ? path.basename(spec) : spec;
  return [
    ...openapi.checkCitations(openapi.citations(pages), ops),
    ...openapi.checkCoverage(pages, ops, shown),
  ];
}

export async function run(cwd: string): Promise<RunResult> {
  const { config, from } = await loadConfig(cwd);
  const ignores = new Ignores(await loadIgnores(cwd));
  const docsRoot = path.resolve(cwd, config.docs.root);
  const files = await discover(docsRoot, config.docs.include, config.docs.exclude);
  const pages = await parseAll(docsRoot, files);
  const skipped: string[] = [];

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

  return { configFrom: from, pages: pages.length, findings: deduped, skipped };
}
