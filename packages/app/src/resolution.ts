import path from 'node:path';
import { parse } from '@babel/parser';

interface Source { path: string; text: string }
export function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== 'loc') walk(value, visit);
}
export function property(node: any, key: string): any {
  return node?.properties?.find((p: any) => !p.computed && (p.key?.name ?? p.key?.value) === key)?.value;
}
export function syntax(text: string): any {
  try { return parse(text, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }); }
  catch { return null; }
}
export function resolver(files: Source[]) {
  const have = new Set(files.map(file => file.path));
  const manifests = new Map<string, any>();
  for (const file of files.filter(file => /(^|\/)package\.json$/.test(file.path))) {
    try { manifests.set(path.posix.dirname(file.path), JSON.parse(file.text)); } catch {}
  }
  const roots = [...new Set([...manifests.keys(), ...files.filter(file => /(^|\/)(?:nuxt|vite|next|svelte)\.config\./.test(file.path)).map(file => path.posix.dirname(file.path))])].sort((a, b) => b.length - a.length);
  const within = (root: string, file: string) => root === '.' || file.startsWith(root + '/');
  const scope = (file: string) => roots.find(root => within(root, file)) ?? '.';
  const aliases = new Map<string, Map<string, string>>();
  const add = (root: string, name: string, target: string) => {
    const map = aliases.get(root) ?? new Map<string, string>();
    map.set(name, path.posix.normalize(target)); aliases.set(root, map);
  };
  for (const file of files.filter(file => /(^|\/)(?:tsconfig[^/]*\.json|(?:nuxt|vite)\.config\.[cm]?[jt]s)$/.test(file.path))) {
    const root = scope(file.path), dir = path.posix.dirname(file.path);
    const json = file.path.endsWith('.json');
    const ast = syntax(json ? `(${file.text})` : file.text);
    const literalPath = (node: any): string | null => {
      if (node?.type === 'StringLiteral') return path.posix.join(dir, node.value);
      if (node?.type === 'NewExpression' && node.callee?.name === 'URL' && node.arguments[0]?.type === 'StringLiteral') return path.posix.join(dir, node.arguments[0].value);
      if (node?.type === 'CallExpression') {
        if (['fileURLToPath'].includes(node.callee?.name)) return literalPath(node.arguments[0]);
        if (['resolve', 'join'].includes(node.callee?.name) && node.arguments[0]?.name === '__dirname' && node.arguments.slice(1).every((arg: any) => arg.type === 'StringLiteral')) return path.posix.join(dir, ...node.arguments.slice(1).map((arg: any) => arg.value));
      }
      return null;
    };
    walk(ast, node => {
      const key = node.key?.name ?? node.key?.value;
      if (node.type !== 'ObjectProperty') return;
      if (key === 'alias' && node.value.type === 'ObjectExpression') {
        for (const entry of node.value.properties) {
          const name = entry.key?.name ?? entry.key?.value, target = literalPath(entry.value);
          if (typeof name === 'string' && target !== null) add(root, name, target);
        }
      }
      if (key === 'compilerOptions') {
        const base = property(node.value, 'baseUrl')?.value ?? '.';
        for (const entry of property(node.value, 'paths')?.properties ?? []) {
          const name = entry.key?.value, target = entry.value?.elements?.[0]?.value;
          if (typeof name === 'string' && typeof target === 'string') add(root, name.replace(/\/\*$/, ''), path.posix.join(dir, base, target.replace(/\/\*$/, '')));
        }
      }
    });
    if (/(^|\/)nuxt\.config\./.test(file.path)) {
      let source = have.has(path.posix.join(dir, 'app/app.vue')) || files.some(f => f.path.startsWith(path.posix.join(dir, 'app/pages') + '/')) ? 'app' : '.';
      walk(ast, node => { if (node.type === 'ObjectProperty' && (node.key?.name ?? node.key?.value) === 'srcDir' && node.value?.type === 'StringLiteral') source = node.value.value; });
      for (const name of ['~', '@']) if (!aliases.get(root)?.has(name)) add(root, name, path.posix.join(dir, source));
      for (const name of ['~~', '@@']) add(root, name, dir);
    }
  }
  const candidate = (base: string): string | null => {
    for (const at of [base, ...['.vue', '.svelte', '.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.css', '.scss', '.sass', '.less'].flatMap(ext => [base + ext, `${base}/index${ext}`])]) if (have.has(at)) return at;
    return null;
  };
  const resolve = (from: string, specifier: string): string | null => {
    specifier = specifier.split(/[?#]/)[0]!;
    if (specifier.startsWith('.')) return candidate(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
    const root = scope(from);
    for (const [name, target] of [...(aliases.get(root) ?? [])].sort((a, b) => b[0].length - a[0].length)) {
      if (specifier === name || specifier.startsWith(name + '/')) return candidate(path.posix.join(target, specifier.slice(name.length)));
    }
    if (/^[~@]\//.test(specifier)) return candidate(path.posix.join(root, specifier.slice(2)));
    for (const [dir, manifest] of manifests) {
      if (!manifest.name || !(specifier === manifest.name || specifier.startsWith(manifest.name + '/'))) continue;
      const subpath = specifier === manifest.name ? '.' : '.' + specifier.slice(manifest.name.length);
      let entry = manifest.exports;
      if (typeof entry === 'object' && entry && Object.keys(entry).some(key => key.startsWith('.'))) entry = entry[subpath];
      const source = (value: any): string | null => {
        if (typeof value === 'string') return candidate(path.posix.join(dir, value));
        if (value && typeof value === 'object') for (const key of ['source', 'import', 'default']) { const found = source(value[key]); if (found) return found; }
        return null;
      };
      return source(entry) ?? (subpath === '.' ? source(manifest.source ?? manifest.module ?? manifest.main) : null);
    }
    return null;
  };
  const local = (from: string, specifier: string): boolean => /^(?:\.|[~@]\/)/.test(specifier)
    || [...(aliases.get(scope(from))?.keys() ?? [])].some(name => specifier === name || specifier.startsWith(name + '/'))
    || [...manifests.values()].some(manifest => typeof manifest.name === 'string' && (specifier === manifest.name || specifier.startsWith(manifest.name + '/')));
  return { resolve, scope, local };
}
