import { stat } from 'node:fs/promises';
import path from 'node:path';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

export interface RouteSet {
  routes: Set<string>;
  publicDir?: string;
  docsRoot: string;
  source: 'build' | 'content';
  reach?: ((href: string) => Promise<boolean>) | undefined;
}

function finding(
  check: string,
  page: DocPage,
  link: { line: number; offset: [number, number] },
  target: string,
  detail: string,
  set: RouteSet,
  kind: string,
): Finding {
  return {
    id: findingId(check, page.path, target),
    revision: findingRevision(target),
    check,
    severity: set.source === 'build' || kind !== 'internal' ? 'error' : 'warn',
    confidence: set.source === 'build' || kind !== 'internal' ? 1 : 0.6,
    doc: { path: page.path, line: link.line, offset: link.offset },
    title: `${target} does not resolve`,
    detail,
    evidence: [{ kind: 'linked-from', detail: `${page.path}:${link.line}` }],
  };
}

function normalise(route: string): string {
  const trimmed = route.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

// Every page sitting under src/pages means src/pages is the site root, not a
// path segment. Without this a nested docs root makes every link look broken.
export function sharedPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0] ?? [];
  let shared = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < shared && i < parts.length && parts[i] === first[i]) i++;
    shared = i;
  }
  return first.slice(0, shared).join('/');
}

export function routesOf(pages: DocPage[], base = ''): Set<string> {
  const prefix = sharedPrefix(pages.map((p) => p.path));
  const routes = new Set<string>();
  for (const page of pages) {
    const relative = prefix === '' ? page.path : page.path.slice(prefix.length + 1);
    const withoutExt = relative.replace(/\.(md|mdx|markdown|astro)$/i, '');
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
        const reachable = await set.reach?.(href);
        if (reachable !== false) continue;
        findings.push(
          finding('links', page, link, href, `${href} could not be reached.`, set, 'external'),
        );
        continue;
      }

      const [pathname] = href.split(/[?#]/) as [string];
      if (pathname === '') continue;

      if (!pathname.startsWith('/')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page.path), pathname));
        if (await isFile(path.join(set.docsRoot, resolved))) continue;
        if (set.routes.has(normalise(`/${resolved.replace(/\.(md|mdx|markdown|astro)$/i, '')}`))) continue;
        findings.push(
          finding('links', page, link, resolved, `This page links to ${pathname}, which is not a file beside it and not a page.`, set, 'relative'),
        );
        continue;
      }

      const target = normalise(pathname);
      if (set.routes.has(target)) continue;
      if (set.publicDir && (await isFile(path.join(set.publicDir, pathname)))) continue;

      findings.push(
        finding(
          'links',
          page,
          link,
          target,
          set.source === 'build'
            ? `This page links to ${target}. No built page and no public asset answers to it.`
            : `This page links to ${target}. No source page answers to it. Routes were read from source files, which cannot see pages a framework plugin generates, so build the site and run again to be certain.`,
          set,
          'internal',
        ),
      );
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
