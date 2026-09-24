import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { frameworks as listed } from '@vercel/frameworks';

type Detector = { path?: string; matchContent?: string; matchPackage?: string };
// The part of each entry read here.
interface Framework {
  slug: string | null;
  name: string;
  experimental?: boolean;
  supersedes?: readonly string[];
  detectors?: { every?: readonly Detector[]; some?: readonly Detector[] };
  settings: { buildCommand?: unknown; outputDirectory?: unknown };
}
const frameworks = listed as unknown as readonly Framework[];

// The documentation site the pages belong to, recognised the way a hosting
// platform recognises a project it is asked to deploy: by the files and
// packages each framework is known to leave behind. The list is Vercel's,
// kept current by the people who deploy these frameworks every day.
export interface Site {
  dir: string;
  framework: { slug: string | null; name: string } | null;
  // Where its pages are written, when its framework decides that.
  content: string | null;
  // The command that builds it and the folder that build writes to, relative
  // to `dir`. Null where neither the project nor its framework says.
  build: string | null;
  output: string | null;
  install: string | null;
}

async function isFile(at: string): Promise<boolean> {
  return stat(at).then((s) => s.isFile(), () => false);
}

async function exists(at: string): Promise<boolean> {
  return stat(at).then(() => true, () => false);
}

async function matches(dir: string, framework: Framework): Promise<boolean> {
  const { every, some } = framework.detectors ?? {};
  if (every === undefined && some === undefined) return false;
  const check = async (item: Detector): Promise<boolean> => {
    const file = path.join(dir, item.path ?? 'package.json');
    if (!(await exists(file))) return false;
    const pattern =
      item.matchPackage !== undefined
        ? `"(dev)?(d|D)ependencies":\\s*{[^}]*"${item.matchPackage}":\\s*"(.+?)"[^}]*}`
        : item.matchContent;
    if (pattern === undefined) return true;
    if (!(await isFile(file))) return false;
    return new RegExp(pattern, 'm').test(await readFile(file, 'utf8'));
  };
  for (const item of every ?? []) if (!(await check(item))) return false;
  if (some !== undefined) {
    for (const item of some) if (await check(item)) return true;
    return false;
  }
  return true;
}

// As Vercel picks one: every framework that matches, less those a more
// specific match supersedes, first in the list's order.
async function frameworkIn(dir: string): Promise<Framework | null> {
  const found: (Framework | null)[] = [];
  for (const framework of frameworks) {
    found.push(!framework.experimental && (await matches(dir, framework)) ? framework : null);
  }
  const superseded = new Set<string | null>(found.flatMap((f) => f?.supersedes ?? []));
  return found.find((f) => f !== null && !superseded.has(f.slug)) ?? null;
}

// A setting is either a value or, where the framework lets the project
// choose, a placeholder such as "`public` or `publishDir` from the config".
function settingOf(setting: unknown): string | null {
  const s = setting as { value?: unknown; placeholder?: unknown } | undefined;
  if (typeof s?.value === 'string' && s.value !== 'N/A') return s.value;
  const first = typeof s?.placeholder === 'string' ? s.placeholder.match(/`([^`]+)`/) : null;
  return first?.[1] ?? null;
}

async function packageManager(dir: string): Promise<string | null> {
  for (const [lock, name] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    if (await exists(path.join(dir, lock))) return name;
  }
  return (await exists(path.join(dir, 'package.json'))) ? 'npm' : null;
}

const INSTALL: Record<string, string> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  bun: 'bun install --frozen-lockfile',
};

async function describe(dir: string, framework: Framework | null): Promise<Site> {
  const manifest = await readFile(path.join(dir, 'package.json'), 'utf8').then(
    (t) => JSON.parse(t) as { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object },
    () => null,
  );
  const manager = await packageManager(dir);
  // The project's own build script is what its authors run, so it wins over
  // the framework's generic command.
  const script = manifest?.scripts?.build !== undefined && manager !== null ? `${manager} run build` : null;
  const uses = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const content =
    framework?.slug === 'astro'
      ? path.join(dir, '@astrojs/starlight' in uses ? 'src/content/docs' : 'src/pages')
      : null;
  const install =
    manager === null
      ? null
      : manager === 'npm' && !(await exists(path.join(dir, 'package-lock.json')))
        ? 'npm install'
        : INSTALL[manager]!;
  return {
    dir,
    framework: framework === null ? null : { slug: framework.slug, name: framework.name },
    content,
    build: script ?? settingOf(framework?.settings.buildCommand),
    output: settingOf(framework?.settings.outputDirectory),
    install,
  };
}

// The nearest folder at or above the pages that a framework recognises, and
// no further than the repository they are in. Without one, the nearest
// folder with a package.json.
export async function siteOf(docsRoot: string): Promise<Site | null> {
  let manifestDir: string | null = null;
  for (let dir = docsRoot; ; dir = path.dirname(dir)) {
    const framework = await frameworkIn(dir);
    if (framework !== null) return describe(dir, framework);
    if (manifestDir === null && (await exists(path.join(dir, 'package.json')))) manifestDir = dir;
    if ((await exists(path.join(dir, '.git'))) || path.dirname(dir) === dir) break;
  }
  return manifestDir === null ? null : describe(manifestDir, null);
}

// Folders a build commonly writes to, for a framework that leaves the choice
// to the project.
export const OUTPUTS = ['dist', 'build', 'out', 'public', '_site', 'site', '.output/public'];

export async function builtOutput(site: Site): Promise<string | null> {
  for (const at of [...(site.output === null ? [] : [site.output]), ...OUTPUTS]) {
    const dir = path.join(site.dir, at);
    if (await isFile(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

export type Built = { dir: string; command: string } | { failed: string; command: string | null };

const BUILD_TIMEOUT_MS = 15 * 60_000;

function sh(command: string, cwd: string): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: BUILD_TIMEOUT_MS });
    let said = '';
    const keep = (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => resolve({ code: null, tail: error.message }));
    child.on('close', (code) => resolve({ code, tail: said }));
  });
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter((l) => l.trim() !== '').pop()?.trim() ?? 'no output';
}

// Builds the site the way its project does: dependencies from its lockfile
// when they are not installed yet, then its build. This runs the project's
// own code, so it happens only when asked for.
export async function buildSite(site: Site): Promise<Built> {
  if (site.build === null) {
    return { failed: `nothing says how to build ${site.dir}: no build script and no recognised framework`, command: null };
  }
  if (site.install !== null && !(await exists(path.join(site.dir, 'node_modules')))) {
    const installed = await sh(site.install, site.dir);
    if (installed.code !== 0) return { failed: `${site.install} failed: ${lastLine(installed.tail)}`, command: site.install };
  }
  const built = await sh(site.build, site.dir);
  if (built.code !== 0) return { failed: `${site.build} failed: ${lastLine(built.tail)}`, command: site.build };
  const dir = await builtOutput(site);
  if (dir === null) return { failed: `${site.build} finished, but no built page was found in ${site.dir}`, command: site.build };
  return { dir, command: site.build };
}
