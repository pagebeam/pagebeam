import path from 'node:path';

// A screen is somewhere a reader can go, which is a route. A directory is not
// a screen: grouping by one invents "components" and "utils" as places nobody
// can visit, splits a real screen across several, and counts a helper nobody
// sees as something the documentation owes an explanation for.
//
// What a screen offers is everything the route reaches: itself, what it
// imports, and what it uses by name where a framework resolves that for you.
const ROUTES = /(^|\/)(pages|routes|views|app|screens)\//;
const PAGE = /\.(vue|svelte|astro|[jt]sx)$/i;
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

export function isRoute(file: string): boolean {
  return ROUTES.test(file) && PAGE.test(file);
}

// What a reader is shown when they arrive: `pages/dashboard/systems.vue`
// becomes `/dashboard/systems`, and an index becomes the thing it indexes.
export function addressOf(file: string): string {
  const without = withoutExtension(file).replace(ROUTES, '/');
  const cleaned = without.replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1');
  return cleaned === '' ? '/' : cleaned;
}

export interface Screens {
  // The address a reader arrives at, and every file that makes up what they
  // find there.
  reaches: Map<string, Set<string>>;
  // Files no route reaches. Nobody meets them, so nothing is owed for them.
  unreached: Set<string>;
}

export function screensOf(files: { path: string; text: string }[]): Screens {
  const have = new Set(files.map((f) => f.path));
  const text = new Map(files.map((f) => [f.path, f.text]));

  // A component resolved by its name, wherever a framework keeps them. The
  // name is built the way frameworks build it: a component in a directory
  // carries that directory in front of it, so `lens/ClaimsView.vue` is what
  // `<LensClaimsView>` means, and which side it runs on is not part of it.
  const byName = new Map<string, string>();
  const remember = (name: string, at: string): void => {
    if (name !== '' && !byName.has(name)) byName.set(name, at);
  };
  for (const file of files) {
    if (!COMPONENT.test(file.path) || isRoute(file.path)) continue;
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
    if (!isRoute(file.path)) continue;
    const worn = (text.get(file.path) ?? '').match(WEARS)?.[1] ?? 'default';
    const wrapping = layouts.get(worn);
    const seen = new Set<string>([file.path, ...(wrapping === undefined ? [] : [wrapping])]);
    const queue = [...seen];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const next of from(at)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    reaches.set(addressOf(file.path), new Set([...(reaches.get(addressOf(file.path)) ?? []), ...seen]));
    for (const one of seen) reached.add(one);
  }

  return {
    reaches,
    unreached: new Set(files.map((f) => f.path).filter((f) => !reached.has(f))),
  };
}
