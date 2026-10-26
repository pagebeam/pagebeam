// The packages under @pagebeam are how this repository is divided, not
// something anybody installs. Shipping them separately made eight things to
// publish, eight versions to keep in step, and eight registry settings to
// maintain, for one command.
//
// They are built into the command instead. What a reader installs is one
// package, and what they get is the same code.
import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolved against this file, so it builds the same wherever it is run from.
const here = path.dirname(fileURLToPath(import.meta.url));
const own = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));

// Anything not written here stays a dependency, so a parser is still the
// parser its authors publish and is still patched by updating it.
const external = [
  ...Object.keys(own.dependencies ?? {}),
  // Loads its own pieces by name at runtime, so it cannot be built into
  // anything. It is optional besides: only a run that opens a browser wants it.
  ...Object.keys(own.optionalDependencies ?? {}),
];

for (const [entry, out] of [
  ['src/main.ts', 'dist/main.js'],
  ['src/index.ts', 'dist/index.js'],
]) {
  await build({
    entryPoints: [path.join(here, entry)],
    outfile: path.join(here, out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    logLevel: 'warning',
  });
}

const packages = path.resolve(here, '..');
for (const name of await readdir(packages)) {
  if (name === 'cli') continue;
  const from = path.join(packages, name, 'dist');
  const files = await readdir(from).catch(() => []);
  const to = path.join(here, 'dist/types', name);
  await mkdir(to, { recursive: true });
  for (const file of files.filter(file => file.endsWith('.d.ts'))) {
    const declaration = (await readFile(path.join(from, file), 'utf8'))
      .replace(/(['"])@pagebeam\/([a-z-]+)\1/g, (_match, quote, dependency) => `${quote}../${dependency}/index.js${quote}`)
      .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    await writeFile(path.join(to, file), declaration);
  }
}
const entryTypes = path.join(here, 'dist/index.d.ts');
const declarations = (await readFile(entryTypes, 'utf8'))
  .replace(/(['"])@pagebeam\/([a-z-]+)\1/g, (_match, quote, dependency) => `${quote}./types/${dependency}/index.js${quote}`)
  .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
await writeFile(entryTypes, declarations);
