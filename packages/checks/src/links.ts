import { stat } from 'node:fs/promises';
import path from 'node:path';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

export interface RouteSet {
  routes: Set<string>;
  publicDir?: string;
  source: 'build' | 'content';
}

function normalise(route: string): string {
  const trimmed = route.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function routesOf(pages: DocPage[], base = ''): Set<string> {
  const routes = new Set<string>();
  for (const page of pages) {
    const withoutExt = page.path.replace(/\.(md|mdx|markdown|astro)$/i, '');
    const withoutIndex = withoutExt.replace(/(^|\/)index$/i, '');
    routes.add(normalise(`${base}/${withoutIndex}`));
  }
  return routes;
}

async function isFile(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((s) => s.isFile())
    .catch(() => false);
}

export async function checkLinks(
  pages: DocPage[],
  set: RouteSet,
  options: { external: boolean },
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const page of pages) {
    for (const link of page.links) {
      const href = link.href.trim();
      if (href === '' || href.startsWith('#')) continue;
      if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        if (!options.external) continue;
        continue;
      }
      if (!href.startsWith('/')) continue;

      const [pathname] = href.split(/[?#]/) as [string];
      const target = normalise(pathname);
      if (set.routes.has(target)) continue;

      if (set.publicDir && (await isFile(path.join(set.publicDir, pathname)))) continue;

      findings.push({
        id: findingId('links', page.path, target),
        revision: findingRevision(target),
        check: 'links',
        severity: set.source === 'build' ? 'error' : 'warn',
        confidence: set.source === 'build' ? 1 : 0.6,
        doc: { path: page.path, line: link.line, offset: link.offset },
        title: `${target} does not resolve`,
        detail:
          set.source === 'build'
            ? `This page links to ${target}. No built page and no public asset answers to it.`
            : `This page links to ${target}. No source page answers to it. Routes were read from source files, which cannot see pages a framework plugin generates, so build the site and run again to be certain.`,
        evidence: [{ kind: 'linked-from', detail: `${page.path}:${link.line}` }],
      });
    }
  }
  return findings;
}

export async function routesFromBuild(buildDir: string): Promise<Set<string>> {
  const { glob } = await import('tinyglobby');
  const pages = await glob(['**/index.html', '*.html'], {
    cwd: buildDir,
    ignore: ['**/node_modules/**'],
    absolute: false,
  });
  const routes = new Set<string>();
  for (const p of pages) {
    const route = p.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '');
    routes.add(normalise(`/${route}`));
  }
  return routes;
}
