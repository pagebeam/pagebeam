import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { glob } from 'tinyglobby';

const run = promisify(execFile);

const NAME = '[A-Z][A-Z0-9_]{2,}';
const Q = `['"]`;
const S = '[[:space:]]*';
// A variable the code reads by name: `env('X')` in Laravel and django-environ,
// `getenv`, `os.Getenv`, `System.getenv`, `std::env::var`, `ENV.fetch`,
// `process.env.X`, `import.meta.env.X` and the subscripts of `process.env`,
// `ENV` and `os.environ`. POSIX classes, because git grep reads it too.
const READ = [
  `(env|getenv|os\\.Getenv|System\\.getenv|std::env::var|ENV\\.fetch|os\\.environ\\.get)\\(${S}${Q}${NAME}${Q}`,
  `(process\\.env|import\\.meta\\.env)\\.${NAME}`,
  `(process\\.env|ENV|os\\.environ)\\[${S}${Q}${NAME}${Q}`,
].join('|');
const READ_JS = new RegExp(READ.replaceAll('[[:space:]]', '\\s'), 'g');
const KEY = new RegExp(NAME, 'g');

const SOURCE = ['php', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'ex', 'exs'];
const LEFT_OUT = ['**/node_modules/**', '**/vendor/**'];

function keysIn(text: string, into: Set<string>): void {
  for (const m of text.matchAll(READ_JS)) {
    const key = [...m[0].matchAll(KEY)].pop()?.[0];
    if (key !== undefined) into.add(key);
  }
}

export async function envReads(root: string, exclude: string[], rev?: string): Promise<Set<string>> {
  const keys = new Set<string>();
  if (rev === undefined) {
    const files = await glob([`**/*.{${SOURCE.join(',')}}`], { cwd: root, ignore: [...exclude, ...LEFT_OUT] });
    for (const file of files) {
      const text = await readFile(path.join(root, file), 'utf8').catch((error: { code?: string }) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      keysIn(text, keys);
    }
    return keys;
  }
  const specs = [
    ...SOURCE.map((e) => `:(glob)**/*.${e}`),
    ...[...exclude, ...LEFT_OUT].map((p) => `:(exclude,glob)${p}`),
  ];
  const { stdout } = await run('git', ['-C', root, 'grep', '-h', '-o', '-E', '-I', READ, rev, '--', ...specs], {
    maxBuffer: 1 << 28,
  }).catch((error: { code?: number; stdout?: string }) => {
    // git grep exits 1 when nothing matches.
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  keysIn(stdout, keys);
  return keys;
}
