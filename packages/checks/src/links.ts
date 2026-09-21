import { stat } from 'node:fs/promises';
import path from 'node:path';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocLink, DocPage } from '@pagebeam/docs';

export type Verdict = 'alive' | 'dead' | 'unknown';

export interface RouteSet {
  routes: Set<string>;
  publicDir?: string;
  docsRoot: string;
  source: 'build' | 'content';
  reach?: ((href: string) => Promise<Verdict>) | undefined;
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
    standing: set.source === 'build' && kind === 'internal' ? 'proven' : 'review',
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

// The literal directory a glob starts with is scaffolding, not a URL segment:
// 'src/pages/**/*.md' publishes src/pages/guide.md at /guide. Anything the
// pattern does not name stays in the route, because it is part of the address.
export function baseFromPatterns(patterns: string[]): string {
  const literal = (pattern: string): string => {
    const parts: string[] = [];
    for (const part of pattern.split('/')) {
      if (/[*?[\]{}]/.test(part)) break;
      parts.push(part);
    }
    return parts.join('/');
  };
  const bases = patterns.map(literal);
  const first = bases[0] ?? '';
  return bases.every((b) => b === first) ? first : '';
}

export function routesOf(pages: DocPage[], base = '', prefix = ''): Set<string> {
  const routes = new Set<string>();
  for (const page of pages) {
    // A page that declares its own address is published there, whatever its
    // path says. Docusaurus and Starlight both allow this.
    if (typeof page.slug === 'string' && page.slug.trim() !== '') {
      routes.add(normalise(page.slug.startsWith('/') ? page.slug : `${prefix}/${page.slug}`));
      continue;
    }
    const relative =
      base !== '' && page.path.startsWith(`${base}/`) ? page.path.slice(base.length + 1) : page.path;
    const withoutExt = relative.replace(/\.(md|mdx|markdown|astro)$/i, '');
    const withoutIndex = withoutExt.replace(/(^|\/)index$/i, '');
    routes.add(normalise(`${prefix}/${withoutIndex}`));
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
  const external: { page: DocPage; link: DocLink; href: string }[] = [];

  for (const page of pages) {
    for (const link of page.links) {
      const href = link.href.trim();
      if (href === '' || href.startsWith('#')) continue;
      if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        if (options.external && /^https?:/i.test(href)) external.push({ page, link, href });
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
            : `This page links to ${target}. No source page answers to it. Routes were read from source files, so pages a framework generates are invisible; build the site, or set docs.routeBase if the site serves these pages under a prefix.`,
          set,
          'internal',
        ),
      );
    }
  }

  if (external.length > 0 && set.reach !== undefined) {
    const unique = [...new Set(external.map((e) => e.href))];
    const verdicts = new Map(
      await Promise.all(unique.map(async (href) => [href, await set.reach!(href)] as const)),
    );
    for (const { page, link, href } of external) {
      if (verdicts.get(href) !== 'dead') continue;
      findings.push(
        finding('links', page, link, href, `${href} could not be reached.`, set, 'external'),
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
