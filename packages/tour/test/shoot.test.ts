import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '@pagebeam/core';
import { unavailable } from '@pagebeam/app';
import { shoot, TourFailure } from '../dist/index.js';
import { notesApp, pngSize } from './fixture.ts';

function toursFor(url: string, tours: Record<string, unknown>) {
  return parseConfig({
    docs: { root: '.' },
    tours: { targets: { local: { url } }, timeoutMs: 3000, ...tours },
  }).tours!;
}

const FORM = { url: '/login', username: '#username', password: '#password', submit: '#submit' };

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'pagebeam-tour-'));
}

test('a journey is followed signed in, and each shot is placed in the manifest', async (t) => {
  const app = await notesApp();
  const cwd = await workspace();
  process.env.NOTES_USER = 'ada';
  process.env.NOTES_PASSWORD = 'pw-ada';
  try {
    const tours = toursFor(app.url, {
      accounts: {
        writer: {
          purpose: 'a user with notes',
          login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: FORM },
          confirm: '#signout',
          requires: [{ goto: '/notes', count: { selector: 'li.note', min: 3 } }, { request: '/api/me' }],
        },
      },
      journeys: {
        write: {
          account: 'writer',
          viewports: [{ name: 'desktop', width: 800, height: 600 }],
          steps: [
            { goto: '/notes' },
            { expect: { selector: 'li.note', text: 'Second note' } },
            { shot: { name: 'list', caption: 'Your notes', focus: ['#new'] } },
            { click: '#new' },
            { wait: '#dialog' },
            { fill: { selector: '#title', value: 'Groceries' } },
            { select: { selector: '#kind', value: 'todo' } },
            { shot: { name: 'dialog', focus: ['#title'], fullPage: true } },
          ],
        },
      },
    });
    const result = await shoot({ cwd, tours });
    if (unavailable(result)) {
      t.skip(`no browser to drive: ${result.reason}`);
      return;
    }
    const dir = path.join(cwd, '.pagebeam/shots/local/write');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, result.manifests[0]!.manifest);
    assert.deepEqual(
      manifest.shots.map((s: { file: string }) => s.file),
      ['01-list.desktop.png', '02-dialog.desktop.png'],
    );

    const list = manifest.shots[0]!;
    const dialog = manifest.shots[1]!;
    assert.equal(list.step, 2);
    assert.equal(list.caption, 'Your notes');
    assert.equal(list.account, 'writer');
    assert.equal(list.url, `${app.url}/notes`);
    assert.deepEqual(list.viewport, { name: 'desktop', width: 800, height: 600, scale: 2 });
    assert.deepEqual(list.focus, [{ selector: '#new', x: 200, y: 100, width: 400, height: 80 }]);
    assert.equal(dialog.step, 7);
    assert.equal(dialog.focus[0]!.selector, '#title');

    const png = await readFile(path.join(dir, list.file));
    assert.deepEqual(pngSize(png), { width: 1600, height: 1200 }, 'pixels at scale 2');
  } finally {
    delete process.env.NOTES_USER;
    delete process.env.NOTES_PASSWORD;
    await app.stop();
  }
});

test('a password the app rejects is reported, not photographed', async (t) => {
  const app = await notesApp();
  process.env.NOTES_USER = 'ada';
  process.env.NOTES_PASSWORD = 'wrong';
  try {
    const tours = toursFor(app.url, {
      accounts: {
        writer: {
          purpose: 'a user with notes',
          login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: FORM },
          confirm: '#signout',
        },
      },
      journeys: { write: { account: 'writer', steps: [{ shot: { name: 'home' } }] } },
    });
    const outcome = await shoot({ cwd: await workspace(), tours }).catch((e: unknown) => e as Error);
    if (!(outcome instanceof Error) && unavailable(outcome)) {
      t.skip(`no browser to drive: ${outcome.reason}`);
      return;
    }
    assert.ok(outcome instanceof TourFailure);
    assert.match(outcome.message, /account "writer" did not sign in on target "local": #signout never appeared/);
  } finally {
    delete process.env.NOTES_USER;
    delete process.env.NOTES_PASSWORD;
    await app.stop();
  }
});

test('an account without the data its journeys need stops the run and names the seed', async (t) => {
  const app = await notesApp();
  process.env.NOTES_USER = 'bo';
  process.env.NOTES_PASSWORD = 'pw-bo';
  try {
    const tours = toursFor(app.url, {
      accounts: {
        writer: {
          purpose: 'a user with notes',
          login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: FORM },
          confirm: '#signout',
          seed: { command: 'npm run seed:notes' },
          requires: [{ goto: '/notes', count: { selector: 'li.note', min: 3 } }],
        },
      },
      journeys: { write: { account: 'writer', steps: [{ shot: { name: 'home' } }] } },
    });
    const outcome = await shoot({ cwd: await workspace(), tours }).catch((e: unknown) => e as Error);
    if (!(outcome instanceof Error) && unavailable(outcome)) {
      t.skip(`no browser to drive: ${outcome.reason}`);
      return;
    }
    assert.ok(outcome instanceof TourFailure);
    assert.equal(
      outcome.message,
      'account "writer" is not ready on target "local": requirement 1 ' +
        '(at least 3 of li.note at /notes) failed, found 0. Run the seed: npm run seed:notes',
    );
  } finally {
    delete process.env.NOTES_USER;
    delete process.env.NOTES_PASSWORD;
    await app.stop();
  }
});

const SEED = `
const response = await fetch(process.env.PAGEBEAM_TARGET_URL + '/signup', { method: 'POST' });
console.log('making a new user on ' + process.env.PAGEBEAM_TARGET);
console.log(JSON.stringify(await response.json()));
`;

test('a fresh account is a new user made by the seed for this run', async (t) => {
  const app = await notesApp();
  const cwd = await workspace();
  await writeFile(path.join(cwd, 'seed.mjs'), SEED);
  try {
    const tours = toursFor(app.url, {
      accounts: {
        newcomer: {
          purpose: 'somebody signing in for the first time',
          login: { form: FORM },
          confirm: '#signout',
          fresh: true,
          seed: { command: 'node seed.mjs' },
          requires: [{ goto: '/notes', text: 'Nothing here yet' }],
        },
      },
      journeys: {
        onboarding: {
          account: 'newcomer',
          steps: [{ goto: '/empty' }, { shot: { name: 'empty' } }],
        },
      },
    });
    const result = await shoot({ cwd, tours, out: 'shots' });
    if (unavailable(result)) {
      t.skip(`no browser to drive: ${result.reason}`);
      return;
    }
    const manifest = JSON.parse(
      await readFile(path.join(cwd, 'shots/local/onboarding/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.shots.length, 1);
    assert.equal(manifest.shots[0].account, 'newcomer');
    assert.equal(manifest.shots[0].url, `${app.url}/empty`);
    const png = await readFile(path.join(cwd, 'shots/local/onboarding', manifest.shots[0].file));
    assert.deepEqual(pngSize(png), { width: 2880, height: 1800 }, 'the default desktop at scale 2');
  } finally {
    await app.stop();
  }
});

test('a seed does not run on a target it is not listed for', async (t) => {
  const app = await notesApp();
  try {
    const tours = parseConfig({
      docs: { root: '.' },
      tours: {
        targets: { local: { url: app.url }, staging: { url: app.url } },
        accounts: {
          newcomer: {
            purpose: 'somebody new',
            login: { form: FORM },
            confirm: '#signout',
            fresh: true,
            seed: { command: 'node seed.mjs', targets: ['local'] },
          },
        },
        journeys: { onboarding: { account: 'newcomer', steps: [{ shot: { name: 'home' } }] } },
      },
    }).tours!;
    const outcome = await shoot({ cwd: await workspace(), tours, target: 'staging' }).catch(
      (e: unknown) => e as Error,
    );
    if (!(outcome instanceof Error) && unavailable(outcome)) {
      t.skip(`no browser to drive: ${outcome.reason}`);
      return;
    }
    assert.ok(outcome instanceof TourFailure);
    assert.match(outcome.message, /may not run on target "staging"/);
  } finally {
    await app.stop();
  }
});

test('a variable a journey needs is asked for before a browser starts', async () => {
  const tours = toursFor('http://127.0.0.1:1', {
    accounts: {
      writer: {
        purpose: 'a user with notes',
        login: { usernameEnv: 'NOTES_UNSET_USER', passwordEnv: 'NOTES_UNSET_PASSWORD', form: FORM },
        confirm: '#signout',
      },
    },
    journeys: { write: { account: 'writer', steps: [{ shot: { name: 'home' } }] } },
  });
  await assert.rejects(shoot({ cwd: await workspace(), tours }), /not set: NOTES_UNSET_USER, NOTES_UNSET_PASSWORD/);
});

test('an unknown target is refused and the known ones are named', async () => {
  const tours = toursFor('http://127.0.0.1:1', {
    accounts: {},
    journeys: {},
  });
  await assert.rejects(shoot({ cwd: await workspace(), tours, target: 'prod' }), /no target is named prod. Targets: local/);
});
