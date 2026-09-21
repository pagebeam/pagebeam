import { stat } from 'node:fs/promises';
import path from 'node:path';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocPage } from '@pagebeam/docs';

export interface RouteSet {
  routes: Set<string>;
  publicDir?: string;
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
        severity: 'error',
        confidence: 1,
        doc: { path: page.path, line: link.line, offset: link.offset },
        title: `${target} does not resolve`,
        detail: `This page links to ${target}. No page and no public asset answers to it.`,
        evidence: [{ kind: 'linked-from', detail: `${page.path}:${link.line}` }],
      });
    }
  }
  return findings;
}
