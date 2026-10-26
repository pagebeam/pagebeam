import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import picomatch from 'picomatch';
import { filesAt, readAt } from './git.js';
import { screensOf, ROUTE_CONFIG } from './screens.js';

export interface ImpactSource { path: string; text: string }
export interface RouteImpact { route: string; files: string[]; presence: 'existing' | 'added' | 'removed' }
export interface ImpactAnalysis { routes: RouteImpact[]; ignored: string[]; unknown: string[]; reasons: string[] }
export interface ImpactOptions { ignore?: string[]; global?: string[]; routes?: Record<string, string[]> }
export interface ImpactRequest extends ImpactOptions { head: ImpactSource[]; base?: ImpactSource[]; changed: string[] }
export interface ImpactAnalyzer { analyze(request: ImpactRequest): ImpactAnalysis | Promise<ImpactAnalysis> }

const IGNORED = ['docs/**', '**/.github/**', '**/.pagebeam/**', '**/pagebeam.config.*', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/README*', '**/LICENSE*', '**/CHANGELOG*', '**/CONTRIBUTING*'];
const GLOBAL = ['app.vue', 'src/app.vue', '**/styles/**', '**/assets/**', '**/public/**', '**/static/**', '**/plugins/**', '**/middleware/**', '**/*.{css,scss,sass,less}', 'package.json', '*lock*', '*.{config,config.*}', 'tsconfig*.json'];
const TEXT = /\.(vue|svelte|astro|[cm]?[jt]sx?|css|scss|sass|less|html|mdx?|json)$/i;
const EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/.nuxt/**', '**/.output/**', '**/.next/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.pagebeam/**'];

export async function impactSources(root: string, revision?: string): Promise<ImpactSource[]> {
  const names = revision ? await filesAt(root, revision) : await glob(['**/*'], { cwd: root, dot: true, ignore: EXCLUDE });
  const files = names.filter(file => !picomatch.isMatch(file, EXCLUDE, { dot: true }));
  const result: ImpactSource[] = [];
  for (let start = 0; start < files.length; start += 32) {
    const batch = await Promise.all(files.slice(start, start + 32).map(async file => ({
      path: file,
      text: !TEXT.test(file) ? '' : revision ? await readAt(root, revision, file) : await readFile(path.join(root, file), 'utf8'),
    })));
    for (const file of batch) if (file.text !== null) result.push({ path: file.path, text: file.text });
  }
  return result;
}

export function routeMatches(pattern: string, pathname: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const expression = escaped.replace(/:[A-Za-z0-9_]+\*/g, '.+').replace(/:[A-Za-z0-9_]+/g, '[^/]+').replace(/\*/g, '.*');
  return new RegExp(`^${expression.replace(/\/$/, '') || '/'}$`).test(pathname.replace(/\/$/, '') || '/');
}

export const staticImpactAnalyzer: ImpactAnalyzer = {
  analyze(request) {
    const graph = (files: ImpactSource[]) => {
      const result = screensOf(files, files.filter(file => ROUTE_CONFIG.test(file.path)));
      for (const [route, patterns] of Object.entries(request.routes ?? {})) {
        const sources = files.filter(file => picomatch.isMatch(file.path, patterns, { dot: true })).map(file => file.path);
        if (sources.length) result.reaches.set(route, new Set([...(result.reaches.get(route) ?? []), ...sources]));
      }
      const unresolved = files.filter(file => /(^|\/)nuxt\.config\./.test(file.path) && /\b(?:extends|srcDir|alias|hooks|router)\s*:|pages:extend|extendRoutes/.test(file.text));
      if (unresolved.length) result.incomplete = [result.incomplete, ...unresolved.map(file => `Runtime routes or source resolution in ${file.path} cannot be established statically`)].filter(Boolean).join('; ');
      return result;
    };
    const head = graph(request.head);
    const base = request.base ? graph(request.base) : head;
    const allRoutes = [...new Set([...head.reaches.keys(), ...base.reaches.keys()])].sort();
    const affected = new Map<string, Set<string>>();
    const ignored: string[] = [], unknown: string[] = [], reasons: string[] = [];
    const add = (route: string, file: string) => { const files = affected.get(route) ?? new Set<string>(); files.add(file); affected.set(route, files); };
    for (const file of [...new Set(request.changed)].sort()) {
      const routes = allRoutes.filter(route => head.reaches.get(route)?.has(file) || base.reaches.get(route)?.has(file));
      if (routes.length) for (const route of routes) add(route, file);
      else if (picomatch.isMatch(file, [...IGNORED, ...(request.ignore ?? [])], { dot: true })) ignored.push(file);
      else if (allRoutes.length && picomatch.isMatch(file, [...GLOBAL, ...(request.global ?? [])], { dot: true })) for (const route of allRoutes) add(route, file);
      else unknown.push(file);
    }
    if (affected.size || unknown.length) {
      for (const message of [head.incomplete, base.incomplete]) if (message && !reasons.includes(message)) reasons.push(message);
    }
    return {
      routes: [...affected].sort(([a], [b]) => a.localeCompare(b)).map(([route, files]) => ({
        route, files: [...files].sort(), presence: !base.reaches.has(route) ? 'added' : !head.reaches.has(route) ? 'removed' : 'existing',
      })), ignored, unknown, reasons,
    };
  },
};
