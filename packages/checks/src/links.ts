import { stat } from 'node:fs/promises';
import path from 'node:path';
import { findingId, findingRevision, type Finding } from '@pagebeam/core';
import type { DocLink, DocPage } from '@pagebeam/docs';

export type Verdict = 'alive' | 'dead' | 'unknown' | 'skipped';

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
    // A page may name its own address instead of taking it from its path.
    // The address is still inside the section the site publishes it under:
    // Docusaurus appends a doc's slug to the plugin's route base, so a leading
    // slash makes it relative to that base, not to the site root.
    if (typeof page.slug === 'string' && page.slug.trim() !== '') {
      routes.add(normalise(`${prefix}/${page.slug.trim().replace(/^\/+/, '')}`));
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

// The folder a site drops from a page's path to make its address, learned
// from what it built: `src/content/docs/agent/overview.md` published at
// `/agent/overview` drops `src/content/docs`. Nothing here knows which site
// generator did that. Null when no single folder explains most pages.
export function learnedBase(pages: DocPage[], built: Set<string>, prefix = ''): string | null {
  const bare = prefix.replace(/\/+$/, '');
  const served = new Set(
    [...built].map((r) => (bare !== '' && (r === bare || r.startsWith(`${bare}/`)) ? normalise(r.slice(bare.length)) : r)),
  );
  const votes = new Map<string, number>();
  let counted = 0;
  for (const route of routesOf(pages.filter((p) => !(typeof p.slug === 'string' && p.slug.trim() !== '')))) {
    if (route === '/') continue;
    counted += 1;
    const parts = route.slice(1).split('/');
    for (let drop = 0; drop < parts.length; drop++) {
      const rest = normalise(`/${parts.slice(drop).join('/')}`);
      if (rest !== '/' && served.has(rest)) {
        const base = parts.slice(0, drop).join('/');
        votes.set(base, (votes.get(base) ?? 0) + 1);
        break;
      }
    }
  }
  const [best, count] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return counted > 0 && count / counted >= 0.5 ? best : null;
}

async function isFile(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((s) => s.isFile())
    .catch(() => false);
}

export interface LinkOutcome {
  findings: Finding[];
  external: { alive: number; dead: number; unknown: number; skipped: number };
  // Links to site addresses left unchecked because the addresses worked out
  // from source matched too few of them to be trusted.
  unaddressed?: { missed: number; total: number };
}

// Below this many site links, a mismatch says little about the addresses.
const ADDRESSES_WORTH_JUDGING = 3;

export async function checkLinks(
  pages: DocPage[],
  set: RouteSet,
  options: { external: boolean },
): Promise<LinkOutcome> {
  const findings: Finding[] = [];
  const external: { page: DocPage; link: DocLink; href: string }[] = [];
  const missed: Finding[] = [];
  let addressed = 0;

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
      addressed += 1;
      if (set.routes.has(target)) continue;
      if (set.publicDir && (await isFile(path.join(set.publicDir, pathname)))) continue;

      missed.push(
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

  // Addresses worked out from source files are a guess at how the site maps
  // a path to a URL. When most links miss them, the guess is what is wrong,
  // and reporting every link as broken would say the opposite.
  let unaddressed: LinkOutcome['unaddressed'];
  if (set.source === 'content' && missed.length >= ADDRESSES_WORTH_JUDGING && missed.length / addressed > 0.5) {
    unaddressed = { missed: missed.length, total: addressed };
  } else {
    findings.push(...missed);
  }

  const counted = { alive: 0, dead: 0, unknown: 0, skipped: 0 };
  if (external.length > 0 && set.reach !== undefined) {
    const unique = [...new Set(external.map((e) => e.href))];
    const verdicts = new Map(
      await Promise.all(unique.map(async (href) => [href, await set.reach!(href)] as const)),
    );
    for (const verdict of verdicts.values()) counted[verdict] += 1;
    for (const { page, link, href } of external) {
      if (verdicts.get(href) !== 'dead') continue;
      findings.push(
        finding('links', page, link, href, `${href} could not be reached.`, set, 'external'),
      );
    }
  }
  return { findings, external: counted, ...(unaddressed === undefined ? {} : { unaddressed }) };
}

export async function routesFromBuild(buildDir: string): Promise<Set<string>> {
  const { glob } = await import('tinyglobby');
  const pages = await glob(['**/*.html'], {
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
