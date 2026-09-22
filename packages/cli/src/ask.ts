import { cancel, confirm, intro, isCancel, note, outro, select, text } from '@clack/prompts';
import path from 'node:path';
import { configFor, discover, type Found } from '@pagebeam/engine';

// Somebody trying this has not read anything yet. What it worked out is
// offered as an answer to correct, not as a form to fill in, and every
// question has a default that is usually right.
function stop(): never {
  cancel('Nothing was written.');
  process.exit(2);
}

function answered<T>(value: T | symbol): T {
  if (isCancel(value)) stop();
  return value as T;
}

async function whereTheDocsAre(found: Found): Promise<string> {
  if (found.docs !== null) {
    const right = answered(
      await confirm({
        message: `Documentation at ${found.docs.root}, ${found.docs.pages} page(s). Right?`,
      }),
    );
    if (right) return found.docs.root;
  }

  const said = answered<string>(
    await text({
      message: 'Where is the documentation, relative to here?',
      placeholder: 'docs',
      defaultValue: 'docs',
      validate: (value) =>
        value !== undefined && path.isAbsolute(value)
          ? 'A path from here, not from the root of the disk.'
          : undefined,
    }),
  );
  return said.trim() === '' ? 'docs' : said.trim();
}

async function whatItDescribes(found: Found, cwd: string): Promise<{ name: string; path: string }[]> {
  const here = path.basename(cwd);
  const options = [
    ...found.apps.map((app) => ({
      value: app.path,
      label: `${app.name} at ${app.path}`,
      hint: `${app.routes} route(s)`,
    })),
    { value: '.', label: `this repository (${here})`, hint: 'the product is here' },
    { value: '', label: 'somewhere else', hint: 'a path you will type' },
    { value: 'none', label: 'nothing yet', hint: 'only the documentation is checked' },
  ];
  const seen = new Set<string>();
  const offered = options.filter((o) => !seen.has(o.value) && seen.add(o.value));

  const chosen = answered<string>(
    await select({
      message: 'Which application does this documentation describe?',
      options: offered,
      initialValue: offered[0]?.value ?? '.',
    }),
  );

  if (chosen === 'none') return [];
  if (chosen !== '') {
    const named = found.apps.find((app) => app.path === chosen);
    return [{ name: named?.name ?? here, path: chosen }];
  }

  const where = answered<string>(
    await text({
      message: 'Where is it? A path from here, checked out beside this if it is another repository.',
      placeholder: '../dashboard',
      validate: (value) =>
        value === undefined || value.trim() === ''
          ? 'A path, or start again and choose nothing yet.'
          : undefined,
    }),
  ).trim();
  return [{ name: path.basename(path.resolve(cwd, where)), path: where }];
}

export async function askFor(cwd: string): Promise<string> {
  intro('pagebeam');
  const found = await discover(cwd);

  const docs = await whereTheDocsAre(found);
  const apps = await whatItDescribes(found, cwd);

  const written = configFor({ docs: { root: docs, pages: found.docs?.pages ?? 0 }, apps: apps.map((a) => ({ ...a, routes: 0, parts: 0 })) });
  note(written.trimEnd(), 'pagebeam.config.yaml');

  if (apps.length === 0) {
    note(
      'Without an application, only the documentation is checked against itself:\nlinks that point nowhere. Add one later and the rest begins to run.',
      'What this will and will not find',
    );
  }

  outro('Run pagebeam check');
  return written;
}
