import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { isRoute } from '@pagebeam/app';

// Working out what a repository holds, so somebody can try this without first
// writing a configuration for a tool they have not seen work.
//
// Nothing here knows the name of a framework. A directory full of prose is
// documentation, a directory holding components somebody can navigate between
// is an application, and both are true whatever built them.
const PROSE = '**/*.{md,mdx,markdown,mdoc,rst,adoc}';
const PARTS = '**/*.{vue,svelte,astro,jsx,tsx}';
const IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**',
  '**/.nuxt/**', '**/.output/**', '**/.svelte-kit/**', '**/vendor/**', '**/coverage/**',
  '**/CHANGELOG*', '**/LICENSE*', '**/CONTRIBUTING*', '**/CODE_OF_CONDUCT*',
  '**/AGENTS.md', '**/CLAUDE.md', '**/SECURITY.md', '**/.github/**',
];

// A file at the top of a repository is addressed to whoever opens the
// repository, not to whoever uses the product. A handful of them is notes, not
// a documentation site.
const LOOSE = 4;

// What a directory is called says what somebody meant it for, which beats
// counting files when both could be right.
const CALLED_DOCS = /^(docs?|documentation|content|guide|guides|handbook|manual|site|www|wiki)$/i;

// Where routes live. What comes before it is the application they belong to:
// the components and the helpers sit beside that directory, not inside it.
const ROUTE_DIR = /(^|\/)(pages|routes|views|app|screens)\//;

function appRootOf(routeFile: string): string {
  const at = routeFile.search(ROUTE_DIR);
  if (at <= 0) return '.';
  return routeFile.slice(0, at);
}

function commonRoot(files: string[]): string {
  if (files.length === 0) return '';
  const split = files.map((f) => path.posix.dirname(f).split('/'));
  const first = split[0]!;
  let shared = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < shared && i < parts.length && parts[i] === first[i]) i += 1;
    shared = i;
  }
  return first.slice(0, shared).join('/');
}

export interface Found {
  docs: { root: string; pages: number } | null;
  apps: { name: string; path: string; routes: number; parts: number }[];
}

export async function discover(cwd: string): Promise<Found> {
  const prose = await glob(PROSE, { cwd, ignore: IGNORE, dot: false });
  const parts = await glob(PARTS, { cwd, ignore: IGNORE, dot: false });

  // Where the prose actually lives, rather than wherever the deepest stray
  // file happens to be.
  // Only what is written as prose. A site whose pages are components is a
  // site this cannot recognise, and saying so is better than calling an
  // application's own routes its documentation.
  const written = prose;

  const byDirectory = new Map<string, string[]>();
  for (const file of written) {
    const at = path.posix.dirname(file).split('/')[0] ?? '.';
    byDirectory.set(at, [...(byDirectory.get(at) ?? []), file]);
  }
  const candidates = [...byDirectory.entries()].filter(
    ([at, found]) => at !== '.' || found.length > LOOSE,
  );
  const named = candidates.find(([at]) => CALLED_DOCS.test(at));
  const biggest = named ?? candidates.sort((a, b) => b[1].length - a[1].length)[0];

  const docs =
    biggest === undefined
      ? null
      : { root: commonRoot(biggest[1]) || biggest[0], pages: biggest[1].length };

  // Somewhere with routes is an application: a reader can move around in it.
  // A directory of components with nowhere to go is a library.
  const grouped = new Map<string, { routes: number; parts: number }>();
  for (const file of parts) {
    const at = isRoute(file) ? appRootOf(file) : (path.posix.dirname(file).split('/')[0] ?? '.');
    const seen = grouped.get(at) ?? { routes: 0, parts: 0 };
    seen.parts += 1;
    if (isRoute(file)) seen.routes += 1;
    grouped.set(at, seen);
  }

  // What is already the documentation is not also an application to check it
  // against.
  const isDocs = (at: string): boolean =>
    docs !== null && (at === docs.root || docs.root.startsWith(`${at}/`) || at.startsWith(`${docs.root}/`));

  const apps = [...grouped.entries()]
    .filter(([at, seen]) => seen.routes > 0 && !isDocs(at))
    .map(([at, seen]) => ({ name: at === '.' ? path.basename(cwd) : at, path: at, ...seen }))
    .sort((a, b) => b.routes - a.routes);

  // A repository that is one application, with its routes at the top. Routes
  // inside the documentation are pages of it, and a site is not an
  // application to check itself against.
  const outside = parts.filter((f) => isRoute(f) && !isDocs(f.split('/')[0] ?? '.'));
  if (apps.length === 0 && outside.length > 0) {
    apps.push({
      name: path.basename(cwd),
      path: '.',
      routes: outside.length,
      parts: parts.length,
    });
  }

  return { docs, apps };
}

export function configFor(found: Found): string {
  const lines: string[] = [];
  lines.push('docs:');
  lines.push(`  root: ${found.docs?.root ?? 'docs'}`);
  lines.push('');
  if (found.apps.length === 0) {
    lines.push('# Every application this documentation describes. Without at least one,');
    lines.push('# only the documentation can be checked against itself.');
    lines.push('apps: []');
  } else {
    lines.push('apps:');
    for (const app of found.apps) {
      lines.push(`  - name: ${app.name}`);
      lines.push(`    path: ${app.path}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function looksLikeAnApp(cwd: string): Promise<boolean> {
  const found = await glob(PARTS, { cwd, ignore: IGNORE, dot: false });
  return found.some((f) => isRoute(f));
}

export async function readIfPresent(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(() => null);
}
