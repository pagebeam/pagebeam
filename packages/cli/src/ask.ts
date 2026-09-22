import { cancel, confirm, intro, isCancel, multiselect, note, outro, text } from '@clack/prompts';
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

// One page often describes more than one thing: a product and the plugins that
// extend it, a dashboard and the service behind it, each in its own
// repository. The configuration has always taken a list; only the question
// took one answer, which quietly made the common case the unsupported one.
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
  ];
  const seen = new Set<string>();
  const offered = options.filter((o) => !seen.has(o.value) && seen.add(o.value));

  const chosen = answered<string[]>(
    await multiselect({
      message: 'Which applications does this documentation describe?',
      options: offered,
      // Nothing is a real answer: the documentation can still be checked
      // against itself, and an application added later starts the rest.
      required: false,
      initialValues: found.apps.length > 0 ? [found.apps[0]!.path] : [],
    }),
  );

  const apps: { name: string; path: string }[] = [];
  for (const one of chosen) {
    if (one === '') continue;
    const named = found.apps.find((app) => app.path === one);
    apps.push({ name: named?.name ?? path.basename(path.resolve(cwd, one)), path: one });
  }

  // Asked once for each, because somebody with plugins in separate
  // repositories has several to name and being asked once is being asked to
  // start again.
  if (chosen.includes('')) {
    for (;;) {
      const where = answered<string>(
        await text({
          message:
            apps.length === 0
              ? 'Where is it? A path from here, checked out beside this if it is another repository.'
              : 'Another one? A path from here, or leave it empty to stop.',
          placeholder: '../dashboard',
          defaultValue: '',
        }),
      ).trim();
      if (where === '') break;
      apps.push({ name: path.basename(path.resolve(cwd, where)), path: where });
    }
  }

  return apps;
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
