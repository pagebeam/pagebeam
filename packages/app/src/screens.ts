import path from 'node:path';
import { parse } from '@babel/parser';

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
// what wraps them, with its own rules for a path segment. The conventions in
// use are worked out once per application from its file list and its
// framework configuration, so a file never changes classification between one
// step and the next.
export interface ScreenRoute {
  addresses: string[];
  // Files rendered around this route: layouts, templates, parent routes.
  wrappers: string[];
}

export interface RouteModel {
  routeOf(file: string): ScreenRoute | null;
  // The adapters that produced a route, such as `next-app` or `sveltekit`.
  frameworks: Set<string>;
  // Framework configuration read to build this model.
  read: string[];
  // False where routes depend on configuration pagebeam cannot evaluate.
  complete: boolean;
  reason?: string;
}

export interface ConfigFile {
  path: string;
  text: string;
}

// Framework configuration that decides routes. Read from the application's
// root whatever its source include says, because it is route metadata, not
// source.
export const ROUTE_CONFIG = /(^|\/)((next|vite|remix|svelte|nuxt|react-router)\.config\.[cm]?[jt]s|package\.json)$/;
const NEXT_CONFIG = /(^|\/)next\.config\./;

const SVELTEKIT_PAGE = /^(?:(.*)\/)?routes\/(?:(.*)\/)?\+page\.svelte$/;
const REMIX_ROUTE = /^(?:(.*)\/)?app\/routes\/([^/]+?)(?:\/route)?\.[jt]sx?$/;
const NUXT_PAGES = /^(?:(.*)\/)?pages\/(.+)\.(?:vue|astro|mdx?)$/;
const FOLDERS = /^(?:(.*)\/)?(?:routes|views|screens)\/(.+)\.(?:vue|svelte|astro|[jt]sx)$/;
const CODE = ['tsx', 'jsx', 'ts', 'js'];
const NEXT_DEFAULT_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];

function join(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p !== undefined && p !== '').join('/');
}

// Each segment gives the forms it can take in an address: one, or two where
// it is optional. The addresses are every combination.
function addressesFrom(segments: string[][], prefix = ''): string[] {
  let paths: string[][] = [[]];
  for (const forms of segments) paths = paths.flatMap((p) => forms.map((f) => (f === '' ? p : [...p, f])));
  return [...new Set(paths.map((p) => `${prefix}/${p.join('/')}`.replace(/\/+$/, '') || '/'))];
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

// Next.js: `(group)` and `@slot` are not in the address; `(.)x`, `(..)x`,
// `(..)(..)x` and `(...)x` intercept a route at the same level, one or two
// levels up, or from the root, counted in route segments, not folders.
function nextSegments(dirs: string[]): string[][] {
  const out: string[][] = [];
  for (const dir of dirs) {
    const intercept = dir.match(/^((?:\(\.\.\))+|\(\.\)|\(\.\.\.\))(.+)$/);
    let name = dir;
    if (intercept) {
      const marker = intercept[1]!;
      if (marker === '(...)') out.length = 0;
      else if (marker !== '(.)') out.splice(out.length - marker.length / 4, marker.length / 4);
      name = intercept[2]!;
    }
    if (/^\(.*\)$/.test(name) || name.startsWith('@')) continue;
    const optionalRest = name.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalRest) out.push(['', `:${optionalRest[1]}*`]);
    else if (/^\[\.\.\.([^\]]+)\]$/.test(name)) out.push([`:${name.slice(4, -1)}*`]);
    else out.push([name.replace(/\[([^\]]+)\]/g, ':$1')]);
  }
  return out;
}

// SvelteKit: `(group)` is not in the address, `[[x]]` is optional, `[x=matcher]`
// is the parameter `x`, `[...rest]` catches the rest.
function svelteSegments(dirs: string[]): string[][] {
  const out: string[][] = [];
  for (const dir of dirs) {
    if (/^\(.*\)$/.test(dir)) continue;
    const optional = dir.match(/^\[\[([^\]=]+)(?:=[^\]]+)?\]\]$/);
    if (optional) {
      out.push(['', `:${optional[1]}`]);
      continue;
    }
    const rest = dir.match(/^\[\.\.\.([^\]=]+)(?:=[^\]]+)?\]$/);
    if (rest) {
      out.push([`:${rest[1]}*`]);
      continue;
    }
    out.push([dir.replace(/\[([^\]=]+)(?:=[^\]]+)?\]/g, ':$1')]);
  }
  return out;
}

// Nuxt and Astro: `[x]` is a parameter, `[[x]]` optional, `[...x]` the rest.
function pageSegments(parts: string[]): string[][] {
  return parts.map((part) => {
    const optional = part.match(/^\[\[([^\]]+)\]\]$/);
    if (optional) return ['', `:${optional[1]}`];
    const rest = part.match(/^\[\.\.\.([^\]]+)\]$/);
    if (rest) return [`:${rest[1]}*`];
    return [part.replace(/\[([^\]]+)\]/g, ':$1')];
  });
}

// Remix flat routes: dots separate segments, `$id` is a parameter, `$` the
// rest, `_index` the parent's own page, a leading `_` a layout without an
// address, a trailing `_` a segment that does not nest, `(x)` optional.
function remixRoute(prefix: string, id: string, have: Set<string>): ScreenRoute {
  const parts = id.split('.');
  const segments: string[][] = [];
  for (const part of parts) {
    if (part === '_index' || (part.startsWith('_') && part !== '_')) continue;
    const optional = part.match(/^\((.+)\)$/);
    const bare = (optional ? optional[1]! : part).replace(/_$/, '');
    const piece = bare === '$' ? ':*' : bare.startsWith('$') ? `:${bare.slice(1)}` : bare;
    segments.push(optional ? ['', piece] : [piece]);
  }
  const routesDir = join(prefix, 'app', 'routes');
  const moduleOf = (name: string): string | undefined =>
    CODE.flatMap((e) => [`${routesDir}/${name}.${e}`, `${routesDir}/${name}/route.${e}`]).find((f) => have.has(f));
  const parents = parts
    .slice(0, -1)
    .map((_, i) => moduleOf(parts.slice(0, i + 1).join('.')))
    .filter((f): f is string => f !== undefined);
  const root = CODE.map((e) => join(prefix, 'app', `root.${e}`)).find((f) => have.has(f));
  return { addresses: addressesFrom(segments), wrappers: [...(root === undefined ? [] : [root]), ...parents] };
}

interface NextSettings {
  extensions: string[];
  basePath: string;
  unread: string | null;
}

function declaresNext(config: ConfigFile): boolean {
  if (!/(^|\/)package\.json$/.test(config.path)) return false;
  try {
    const manifest = JSON.parse(config.text) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((k) => manifest[k]?.next !== undefined);
  } catch {
    return false;
  }
}

function unwrapped(node: any): any {
  while (node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) {
    node = node.expression;
  }
  return node;
}

// The object the module exports, followed through a variable and through
// wrappers such as `withMDX(config)`. `object` is null when it is built by
// code, and `exported` false when the module exports nothing.
function exportedObject(program: any): { exported: boolean; object: any } {
  const declared = new Map<string, any>();
  let exported: any = null;
  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const d of statement.declarations) if (d.id?.type === 'Identifier') declared.set(d.id.name, d.init);
    } else if (statement.type === 'ExportDefaultDeclaration') {
      exported = statement.declaration;
    } else if (
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'AssignmentExpression' &&
      statement.expression.left.type === 'MemberExpression' &&
      statement.expression.left.object?.name === 'module' &&
      statement.expression.left.property?.name === 'exports'
    ) {
      exported = statement.expression.right;
    }
  }
  if (exported === null) return { exported: false, object: null };
  const seen = new Set<string>();
  let node = unwrapped(exported);
  while (node) {
    if (node.type === 'ObjectExpression') return { exported: true, object: node };
    if (node.type === 'Identifier' && !seen.has(node.name)) {
      seen.add(node.name);
      node = unwrapped(declared.get(node.name));
    } else if (node.type === 'CallExpression' && node.arguments.length > 0) {
      node = unwrapped(node.arguments[0]);
    } else {
      return { exported: true, object: null };
    }
  }
  return { exported: true, object: null };
}

function mentions(node: any, name: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => mentions(n, name));
  if ((node.type === 'Identifier' && node.name === name) || (node.type === 'StringLiteral' && node.value === name)) return true;
  return Object.entries(node).some(([k, v]) => k !== 'loc' && mentions(v, name));
}

function keyOf(property: any): string | null {
  if (property.type !== 'ObjectProperty' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return null;
}

// Only values written out literally in the exported object are read. A
// setting computed at runtime could be anything, so it makes the model
// incomplete instead of guessed.
function nextSettings(config: ConfigFile | undefined): NextSettings {
  const settings: NextSettings = { extensions: NEXT_DEFAULT_EXTENSIONS, basePath: '', unread: null };
  if (config === undefined) return settings;
  let program: any;
  try {
    program = parse(config.text, { sourceType: 'unambiguous', plugins: ['typescript'] }).program;
  } catch {
    settings.unread = `${config.path} could not be parsed`;
    return settings;
  }
  const { exported, object } = exportedObject(program);
  if (exported && object === null) {
    settings.unread = `${config.path} builds its settings in code, which pagebeam does not run`;
    return settings;
  }
  const spreads = object?.properties.some((p: any) => p.type === 'SpreadElement') ?? false;
  const property = (name: string): any =>
    object?.properties.find((p: any) => keyOf(p) === name)?.value;
  const unread: string[] = [];

  const extensions = unwrapped(property('pageExtensions'));
  if (extensions?.type === 'ArrayExpression' && extensions.elements.every((e: any) => e?.type === 'StringLiteral')) {
    const listed = extensions.elements.map((e: any) => String(e.value).replace(/^\./, ''));
    if (listed.length > 0) settings.extensions = listed;
  } else if (extensions !== undefined || spreads || mentions(program, 'pageExtensions')) {
    unread.push(`pageExtensions in ${config.path} is not a literal list`);
  }

  const base = unwrapped(property('basePath'));
  if (base?.type === 'StringLiteral') settings.basePath = String(base.value).replace(/\/+$/, '');
  else if (base?.type === 'TemplateLiteral' && base.expressions.length === 0) {
    settings.basePath = String(base.quasis[0].value.cooked).replace(/\/+$/, '');
  } else if (base !== undefined || spreads || mentions(program, 'basePath')) {
    unread.push(`basePath in ${config.path} is not a literal string`);
  }

  if (unread.length > 0) settings.unread = unread.join('; ');
  return settings;
}

function dirOf(file: string): string {
  const dir = path.posix.dirname(file);
  return dir === '.' ? '' : dir;
}

function within(dir: string, file: string): boolean {
  return dir === '' || file.startsWith(`${dir}/`);
}

// Next.js route files in the extensions each application configures, so they
// are read even where the source include leaves those extensions out.
export function routeFilePatterns(configs: ConfigFile[]): string[] {
  const roots = new Map<string, string[]>();
  for (const c of configs.filter(declaresNext)) roots.set(dirOf(c.path), NEXT_DEFAULT_EXTENSIONS);
  for (const c of configs.filter((c) => NEXT_CONFIG.test(c.path))) roots.set(dirOf(c.path), nextSettings(c).extensions);
  return [...roots].flatMap(([dir, ext]) => {
    const any = ext.length === 1 ? ext[0]! : `{${ext.join(',')}}`;
    const under = dir === '' ? '' : `${dir}/`;
    return [`${under}**/app/**/{page,layout,template}.${any}`, `${under}**/pages/**/*.${any}`];
  });
}

export function routeModel(
  files: Iterable<string | { path: string; text?: string }>,
  configs: ConfigFile[] = [],
): RouteModel {
  const list = [...files].map((f) => (typeof f === 'string' ? { path: f, text: undefined } : f));
  const have = new Set(list.map((f) => f.path));
  const allConfigs = [
    ...configs,
    ...list.filter((f): f is ConfigFile => ROUTE_CONFIG.test(f.path) && typeof f.text === 'string'),
  ];
  // In a repository of several applications each has its own Next.js
  // config, and a file follows the nearest one above it.
  const nextConfigs = allConfigs
    .filter((c) => NEXT_CONFIG.test(c.path))
    .sort((a, b) => dirOf(b.path).length - dirOf(a.path).length);
  const nextManifests = allConfigs.filter(declaresNext);
  const settingsOf = new Map(nextConfigs.map((c) => [c.path, nextSettings(c)]));
  const DEFAULTS = nextSettings(undefined);
  // Next.js needs no config file, so JSX in `pages/` is read by its rules
  // anyway. Plain `.ts`/`.js` there is an endpoint unless this is Next.js,
  // which a config file, a dependency on `next` or an App Router page shows.
  const reactPagesFile = /^(?:(.*)\/)?pages\/(.+)\.(?:[jt]sx)$/;
  const matchers = new Map<string, { appPage: RegExp; pagesFile: RegExp; anyAppPage: boolean }>();
  const matcherFor = (extensions: string[]) => {
    const key = extensions.join('|');
    let found = matchers.get(key);
    if (found === undefined) {
      const ext = extensions.map((e) => e.replace(/[.]/g, '\\.')).join('|');
      const appPage = new RegExp(`^(?:(.*)\\/)?app\\/(?:(.*)\\/)?page\\.(?:${ext})$`);
      found = {
        appPage,
        pagesFile: new RegExp(`^(?:(.*)\\/)?pages\\/(.+)\\.(?:${ext})$`),
        anyAppPage: list.some((f) => appPage.test(f.path) && !f.path.includes('/routes/')),
      };
      matchers.set(key, found);
    }
    return found;
  };
  const nextFor = (file: string) => {
    const config = nextConfigs.find((c) => within(dirOf(c.path), file));
    const settings = config === undefined ? DEFAULTS : settingsOf.get(config.path)!;
    const match = matcherFor(settings.extensions);
    const declared = config !== undefined || nextManifests.some((m) => within(dirOf(m.path), file));
    return { settings, ...match, isNext: declared || match.anyAppPage };
  };
  const svelteKit = list.some((f) => f.path.endsWith('+page.svelte'));
  const remixConfigured = allConfigs.find(
    (c) => /(^|\/)(remix|vite|react-router)\.config\./.test(c.path) && /\broutes\s*[(:]|flatRoutes|defineRoutes/.test(c.text),
  );
  const frameworks = new Set<string>();

  const classify = (file: string): ScreenRoute | null => {
    const nextHere = nextFor(file);
    const next = nextHere.settings;
    const appPage = file.match(nextHere.appPage);
    if (appPage && !file.includes('/routes/')) {
      const dirs = (appPage[2] ?? '').split('/').filter((p) => p !== '');
      if (dirs.some((d) => d.startsWith('_'))) return null;
      frameworks.add('next-app');
      const appDir = join(appPage[1], 'app');
      const wrapperNames = ['layout', 'template'].flatMap((n) => next.extensions.map((e) => `${n}.${e}`));
      return { addresses: addressesFrom(nextSegments(dirs), next.basePath), wrappers: ancestors(appDir, dirs, wrapperNames, have) };
    }

    const kit = file.match(SVELTEKIT_PAGE);
    if (kit) {
      frameworks.add('sveltekit');
      const dirs = (kit[2] ?? '').split('/').filter((p) => p !== '');
      const routesDir = join(kit[1], 'routes');
      return { addresses: addressesFrom(svelteSegments(dirs)), wrappers: ancestors(routesDir, dirs, ['+layout.svelte'], have) };
    }

    const remix = file.match(REMIX_ROUTE);
    if (remix) {
      frameworks.add('remix');
      return remixRoute(remix[1] ?? '', remix[2] ?? '', have);
    }

    // Other files in a Next.js app directory, such as layouts, loading states
    // and colocated components, are not places a reader can go.
    if (/^(?:.*\/)?app\//.test(file) && !file.includes('/routes/') && !/^(?:.*\/)?app\/(?:pages|views|screens)\//.test(file)) {
      return null;
    }

    // In SvelteKit only `+page.svelte` is a route; any other `.svelte` file
    // under `routes/` is a component. In Sapper every one was a route.
    if (svelteKit && file.endsWith('.svelte')) return null;

    const pagesFile = nextHere.isNext ? file.match(nextHere.pagesFile) : file.match(reactPagesFile);
    const nuxt = pagesFile === null ? file.match(NUXT_PAGES) : null;
    const folder = pagesFile === null && nuxt === null ? file.match(FOLDERS) : null;
    const found = pagesFile ?? nuxt ?? folder;
    if (found === null) return null;
    const parts = (found[2] ?? '').split('/');
    if (parts[0] === 'api' || parts.some((p) => p.startsWith('_') || p.startsWith('+'))) return null;
    if (parts[parts.length - 1] === 'index') parts.pop();
    if (pagesFile !== null) {
      frameworks.add('next-pages');
      return { addresses: addressesFrom(nextSegments(parts), next.basePath), wrappers: [] };
    }
    frameworks.add(nuxt !== null ? 'pages' : 'folders');
    return { addresses: addressesFrom(pageSegments(parts)), wrappers: [] };
  };

  const reasons = [
    ...(remixConfigured === undefined ? [] : [`routes are configured in ${remixConfigured.path}, which pagebeam does not evaluate`]),
    ...[...settingsOf.values()].flatMap((n) => (n.unread === null ? [] : [n.unread])),
  ];
  const known = new Map<string, ScreenRoute | null>();
  return {
    routeOf(file) {
      if (!known.has(file)) known.set(file, classify(file));
      return known.get(file)!;
    },
    frameworks,
    read: allConfigs.filter((c) => !c.path.endsWith('package.json') || nextManifests.includes(c)).map((c) => c.path),
    complete: reasons.length === 0,
    ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }),
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

export function screensOf(files: { path: string; text: string }[], configs: ConfigFile[] = []): Screens {
  const have = new Set(files.map((f) => f.path));
  const text = new Map(files.map((f) => [f.path, f.text]));
  const model = routeModel(files, configs);

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
