import path from 'node:path';

// A screen is somewhere a reader can go, which is a route. A directory is not
// a screen: grouping by one invents "components" and "utils" as places nobody
// can visit, splits a real screen across several, and counts a helper nobody
// sees as something the documentation owes an explanation for.
//
// What a screen offers is everything the route reaches: itself, what it
// imports, and what it uses by name where a framework resolves that for you.
const COMPONENT = /\.(vue|svelte|astro|[jt]sx?)$/i;

// Anything that is not part of a name may come before it: a newline in a
// module, a closing tag in a component written on one line.
const IMPORT = /(?:^|[^\w\$])import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const LAZY = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
// `<SystemCanvas>` with no import beside it. A framework that resolves a
// component by its name is the common case, not an exception.
const USED = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
// `useSoftwareSystems()` with no import either. Where the labels of a
// catalogue live, so missing it loses controls that are genuinely on a screen.
const CALLED = /\b(use[A-Z][A-Za-z0-9]*)\s*\(/g;
// Whether a component runs on one side or the other is not part of its name.
const SIDE = /\.(client|server|lazy)$/;
// What wraps a page rather than being one. Its controls are on screen
// wherever it is used, so the navigation and the way out are part of every
// route that wears it, and part of no route that does not.
const LAYOUTS = /(^|\/)layouts\//;
const WEARS = /\blayout\s*:\s*['"]([\w-]+)['"]/;

function capitalised(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function withoutExtension(file: string): string {
  return file.replace(/\.[^./]+$/, '');
}

// Where a specifier points, tried against what is actually there rather than
// assumed from its shape.
function resolve(from: string, specifier: string, have: Set<string>): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(from), specifier);
  else if (/^[~@]\//.test(specifier)) base = specifier.slice(2);
  else if (specifier.startsWith('~') || specifier.startsWith('@/')) base = specifier.replace(/^[~@]\/?/, '');
  else return null;

  base = base.replace(/^\/+/, '');
  for (const candidate of [
    base,
    ...['.vue', '.svelte', '.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs'].flatMap((e) => [
      base + e,
      `${base}/index${e}`,
    ]),
  ]) {
    if (have.has(candidate)) return candidate;
  }
  return null;
}

// Each framework decides which files are routes, what their addresses are and
// what wraps them. The conventions in use are worked out once per application
// from its whole file list, so a file never changes classification between
// one step and the next.
export interface ScreenRoute {
  addresses: string[];
  // Files rendered around this route: layouts, templates, parent routes.
  wrappers: string[];
}

export interface RouteModel {
  routeOf(file: string): ScreenRoute | null;
  // False where routes come from configuration pagebeam cannot evaluate.
  complete: boolean;
  reason?: string;
}

const NEXT_APP_PAGE = /^(?:(.*)\/)?app\/(?:(.*)\/)?page\.(?:[jt]sx?|mdx)$/;
const NEXT_APP_FILE = /^(?:.*\/)?app\//;
const SVELTEKIT_PAGE = /^(?:(.*)\/)?routes\/(?:(.*)\/)?\+page\.svelte$/;
const REMIX_ROUTE = /^(?:(.*)\/)?app\/routes\/([^/]+?)(?:\/route)?\.[jt]sx?$/;
const PAGES = /^(?:(.*)\/)?pages\/(.+)\.(?:vue|astro|mdx?|[jt]sx?)$/;
const FOLDERS = /^(?:(.*)\/)?(?:routes|views|screens)\/(.+)\.(?:vue|svelte|astro|[jt]sx)$/;
const REMIX_CONFIG = /(^|\/)(remix|vite)\.config\.[cm]?[jt]s$/;
const CODE = ['tsx', 'jsx', 'ts', 'js'];

// `[id]` is a parameter, `[...slug]` catches the rest, `[[...slug]]` may be
// empty. A group `(name)` or a slot `@name` is not part of the address.
function segment(part: string): string | null {
  if (/^\(.*\)$/.test(part) || part.startsWith('@')) return null;
  const optional = part.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
  if (optional) return `:${optional[1]}*?`;
  const rest = part.match(/^\[\.\.\.([^\]]+)\]$/);
  if (rest) return `:${rest[1]}*`;
  return part.replace(/\[([^\]]+)\]/g, ':$1');
}

function addressFrom(parts: (string | null)[]): string {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return `/${kept.join('/')}`;
}

function join(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p !== undefined && p !== '').join('/');
}

function ancestors(prefix: string, dirs: string[], names: string[], have: Set<string>): string[] {
  const found: string[] = [];
  for (let depth = 0; depth <= dirs.length; depth++) {
    const at = join(prefix, ...dirs.slice(0, depth));
    for (const name of names) {
      const file = join(at, name);
      if (have.has(file)) found.push(file);
    }
  }
  return found;
}

const NEXT_WRAPPERS = ['layout', 'template'].flatMap((n) => CODE.map((e) => `${n}.${e}`));

// Remix flat routes: dots separate segments, `$id` is a parameter, `$` the
// rest, `_index` the parent's own page, a leading `_` a layout without an
// address, a trailing `_` a segment that does not nest, `(x)` optional.
function remixRoute(prefix: string, id: string, have: Set<string>): ScreenRoute {
  const parts = id.split('.');
  let addresses: string[][] = [[]];
  for (const part of parts) {
    if (part === '_index' || (part.startsWith('_') && part !== '_')) continue;
    const optional = part.match(/^\((.+)\)$/);
    const bare = (optional ? optional[1]! : part).replace(/_$/, '');
    const piece = bare === '$' ? ':*' : bare.startsWith('$') ? `:${bare.slice(1)}` : bare;
    addresses = optional
      ? addresses.flatMap((a) => [a, [...a, piece]])
      : addresses.map((a) => [...a, piece]);
  }
  const routesDir = join(prefix, 'app', 'routes');
  const moduleOf = (name: string): string | undefined =>
    CODE.flatMap((e) => [`${routesDir}/${name}.${e}`, `${routesDir}/${name}/route.${e}`]).find((f) => have.has(f));
  const parents = parts
    .slice(0, -1)
    .map((_, i) => moduleOf(parts.slice(0, i + 1).join('.')))
    .filter((f): f is string => f !== undefined);
  const root = CODE.map((e) => join(prefix, 'app', `root.${e}`)).find((f) => have.has(f));
  return {
    addresses: [...new Set(addresses.map((a) => addressFrom(a)))],
    wrappers: [...(root === undefined ? [] : [root]), ...parents],
  };
}

export function routeModel(files: Iterable<string | { path: string; text?: string }>): RouteModel {
  const list = [...files].map((f) => (typeof f === 'string' ? { path: f, text: undefined } : f));
  const have = new Set(list.map((f) => f.path));
  const svelteKit = list.some((f) => f.path.endsWith('+page.svelte'));
  const configured = list.find(
    (f) => REMIX_CONFIG.test(f.path) && /\broutes\s*[(:]|flatRoutes|defineRoutes/.test(f.text ?? ''),
  );

  const classify = (file: string): ScreenRoute | null => {
    const nextPage = file.match(NEXT_APP_PAGE);
    if (nextPage && !file.includes('/routes/')) {
      const dirs = (nextPage[2] ?? '').split('/').filter((p) => p !== '');
      if (dirs.some((d) => d.startsWith('_'))) return null;
      const appDir = join(nextPage[1], 'app');
      return { addresses: [addressFrom(dirs.map(segment))], wrappers: ancestors(appDir, dirs, NEXT_WRAPPERS, have) };
    }

    const kit = file.match(SVELTEKIT_PAGE);
    if (kit) {
      const dirs = (kit[2] ?? '').split('/').filter((p) => p !== '');
      const routesDir = join(kit[1], 'routes');
      return { addresses: [addressFrom(dirs.map(segment))], wrappers: ancestors(routesDir, dirs, ['+layout.svelte'], have) };
    }

    const remix = file.match(REMIX_ROUTE);
    if (remix) return remixRoute(remix[1] ?? '', remix[2] ?? '', have);

    // Other files in a Next.js app directory, such as layouts, loading states
    // and colocated components, are not places a reader can go.
    if (NEXT_APP_FILE.test(file) && !file.includes('/routes/') && !/^(?:.*\/)?app\/(?:pages|views|screens)\//.test(file)) {
      return null;
    }

    // In SvelteKit only `+page.svelte` is a route; any other `.svelte` file
    // under `routes/` is a component. In Sapper every one was a route.
    if (svelteKit && file.endsWith('.svelte')) return null;

    const pages = file.match(PAGES) ?? file.match(FOLDERS);
    if (pages) {
      const parts = (pages[2] ?? '').split('/');
      if (parts[0] === 'api' || parts.some((p) => p.startsWith('_') || p.startsWith('+'))) return null;
      if (parts[parts.length - 1] === 'index') parts.pop();
      return { addresses: [addressFrom(parts.map(segment))], wrappers: [] };
    }
    return null;
  };

  const known = new Map<string, ScreenRoute | null>();
  return {
    routeOf(file) {
      if (!known.has(file)) known.set(file, classify(file));
      return known.get(file)!;
    },
    complete: configured === undefined,
    ...(configured === undefined
      ? {}
      : { reason: `routes are configured in ${configured.path}, which pagebeam does not evaluate` }),
  };
}

export interface Screens {
  // The address a reader arrives at, and every file that makes up what they
  // find there.
  reaches: Map<string, Set<string>>;
  // Files no route reaches. Nobody meets them, so nothing is owed for them.
  unreached: Set<string>;
  // Why the routes above may not be all of them, where that is known.
  incomplete?: string;
}

export function screensOf(files: { path: string; text: string }[]): Screens {
  const have = new Set(files.map((f) => f.path));
  const text = new Map(files.map((f) => [f.path, f.text]));
  const model = routeModel(files);

  // A component resolved by its name, wherever a framework keeps them. The
  // name is built the way frameworks build it: a component in a directory
  // carries that directory in front of it, so `lens/ClaimsView.vue` is what
  // `<LensClaimsView>` means, and which side it runs on is not part of it.
  const byName = new Map<string, string>();
  const remember = (name: string, at: string): void => {
    if (name !== '' && !byName.has(name)) byName.set(name, at);
  };
  for (const file of files) {
    if (!COMPONENT.test(file.path) || model.routeOf(file.path) !== null) continue;
    const parts = withoutExtension(file.path).replace(SIDE, '').split('/');
    const own = parts[parts.length - 1] ?? '';
    remember(own, file.path);
    remember(parts.slice(1).map(capitalised).join(''), file.path);
    remember(parts.slice(2).map(capitalised).join(''), file.path);
  }

  const from = (file: string): string[] => {
    const source = text.get(file) ?? '';
    const found: string[] = [];
    for (const pattern of [IMPORT, LAZY]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const at = resolve(file, match[1] ?? '', have);
        if (at !== null) found.push(at);
      }
    }
    for (const pattern of [USED, CALLED]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const at = byName.get(match[1] ?? '');
        if (at !== undefined) found.push(at);
      }
    }
    return found;
  };

  const layouts = new Map<string, string>();
  for (const file of files) {
    if (!LAYOUTS.test(file.path)) continue;
    layouts.set(path.posix.basename(withoutExtension(file.path)), file.path);
  }

  const reaches = new Map<string, Set<string>>();
  const reached = new Set<string>();

  for (const file of files) {
    const route = model.routeOf(file.path);
    if (route === null) continue;
    const worn = (text.get(file.path) ?? '').match(WEARS)?.[1] ?? 'default';
    const wrapping = layouts.get(worn);
    const seen = new Set<string>([
      file.path,
      ...(wrapping === undefined ? [] : [wrapping]),
      ...route.wrappers,
    ]);
    const queue = [...seen];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const next of from(at)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    for (const address of route.addresses) {
      reaches.set(address, new Set([...(reaches.get(address) ?? []), ...seen]));
    }
    for (const one of seen) reached.add(one);
  }

  return {
    reaches,
    unreached: new Set(files.map((f) => f.path).filter((f) => !reached.has(f))),
    ...(model.reason === undefined ? {} : { incomplete: model.reason }),
  };
}
