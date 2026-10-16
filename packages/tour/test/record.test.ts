import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseConfig } from '@pagebeam/core';
import { unavailable } from '@pagebeam/app';
import { shoot } from '../dist/index.js';
import { notesApp } from './fixture.ts';

const exec = promisify(execFile);

const FORM = { url: '/login', username: '#username', password: '#password', submit: '#submit' };

const WRITER = {
  purpose: 'a user with notes',
  login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: FORM },
  confirm: '#signout',
};

const QUICK = { typeMs: 40, moveMs: 160, holdMs: 100 };

function toursFor(url: string, journeys: Record<string, unknown>) {
  return parseConfig({
    docs: { root: '.' },
    tours: { targets: { local: { url } }, timeoutMs: 3000, accounts: { writer: WRITER }, journeys },
  }).tours!;
}

async function probe(file: string): Promise<{ width: number; height: number; seconds: number }> {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'json',
    file,
  ]);
  const found = JSON.parse(stdout);
  return { width: found.streams[0].width, height: found.streams[0].height, seconds: Number(found.format.duration) };
}

async function signedIn<T>(run: () => Promise<T>): Promise<T> {
  process.env.NOTES_USER = 'ada';
  process.env.NOTES_PASSWORD = 'pw-ada';
  try {
    return await run();
  } finally {
    delete process.env.NOTES_USER;
    delete process.env.NOTES_PASSWORD;
  }
}

interface Moment {
  step: number;
  action: string;
  at: number;
  until: number;
  box?: { x: number; y: number; width: number; height: number };
  note?: string;
}

test('a recorded journey leaves a video and a timeline of when each step happens', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-record-'));
  try {
    const tours = toursFor(app.url, {
      write: {
        account: 'writer',
        record: QUICK,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        steps: [
          { goto: '/notes', note: 'Every note in one list' },
          { click: '#new', note: 'Start a note from anywhere' },
          { wait: '#dialog' },
          { fill: { selector: '#title', value: 'Groceries' } },
          { shot: { name: 'dialog', focus: ['#title'], caption: 'A title is all it needs' }, note: 'The new note' },
        ],
      },
    });
    const result = await signedIn(() => shoot({ cwd, tours }));
    if (unavailable(result)) {
      t.skip(`nothing to record with: ${result.reason}`);
      return;
    }
    const dir = path.join(cwd, '.pagebeam/shots/local/write');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.shots.length, 1);
    assert.equal(manifest.recordings.length, 1);

    const recording = manifest.recordings[0];
    assert.equal(recording.file, 'recording.desktop.mp4');
    assert.deepEqual(recording.viewport, { name: 'desktop', width: 800, height: 600 });
    const video = await probe(path.join(dir, recording.file));
    assert.equal(video.width, 800);
    assert.equal(video.height, 600);
    assert.ok(Math.abs(video.seconds * 1000 - recording.durationMs) < 300, 'the video lasts as long as the manifest says');

    const timeline: Moment[] = recording.timeline;
    assert.deepEqual(
      timeline.map((m) => m.action),
      ['goto /notes', 'click #new', 'wait #dialog', 'fill #title'],
    );
    for (const [i, moment] of timeline.entries()) {
      assert.ok(moment.until >= moment.at, `moment ${i} ends after it starts`);
      if (i > 0) assert.ok(moment.at >= timeline[i - 1]!.at, `moment ${i} starts in order`);
    }

    const [open, click, , fill] = timeline;
    assert.equal(open!.note, 'Every note in one list');
    assert.equal(click!.note, 'Start a note from anywhere');
    assert.equal(fill!.note, undefined);
    assert.deepEqual(click!.box, { x: 100, y: 50, width: 200, height: 40 });
    assert.ok(fill!.until - fill!.at >= 'Groceries'.length * QUICK.typeMs, 'typed a letter at a time');
    assert.ok(recording.durationMs >= fill!.until, 'the video runs past the last step');
    assert.equal(manifest.shots[0].note, 'The new note');
    assert.equal(manifest.shots[0].caption, 'A title is all it needs');
  } finally {
    await app.stop();
  }
});

test('measured narration holds each step until its line is said', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-record-'));
  try {
    const tours = toursFor(app.url, {
      intro: {
        account: 'writer',
        record: { ...QUICK, cursor: false },
        viewports: [{ name: 'phone', width: 390, height: 600 }],
        steps: [{ goto: '/notes' }, { click: '#new' }, { wait: '#dialog' }],
      },
    });
    const result = await signedIn(() => shoot({ cwd, tours, narration: { intro: { '1': 1500 } } }));
    if (unavailable(result)) {
      t.skip(`nothing to record with: ${result.reason}`);
      return;
    }
    const timeline: Moment[] = result.manifests[0]!.manifest.recordings[0]!.timeline;
    const [, click, wait] = timeline;
    assert.ok(click!.until - click!.at >= 1500, 'the click holds for its line');
    assert.ok(wait!.at >= click!.at + 1500, 'the next step starts after the line');
  } finally {
    await app.stop();
  }
});

test('narration naming a step that cannot hold is refused before a browser starts', async () => {
  const tours = toursFor('http://127.0.0.1:1', {
    intro: { account: 'writer', record: true, steps: [{ goto: '/' }, { shot: { name: 'home' } }] },
  });
  await signedIn(async () => {
    await assert.rejects(
      shoot({ cwd: tmpdir(), tours, narration: { intro: { '5': 900 } } }),
      /names step 5 of journey "intro", which has steps 0 to 1/,
    );
    await assert.rejects(shoot({ cwd: tmpdir(), tours, narration: { intro: { '1': 900 } } }), /a shot/);
    await assert.rejects(shoot({ cwd: tmpdir(), tours, narration: { outro: { '0': 900 } } }), /no journey called outro/);
  });
});

test('a recording without ffmpeg to encode it is reported, not attempted', async () => {
  const tours = toursFor('http://127.0.0.1:1', {
    intro: { account: 'writer', record: true, steps: [{ goto: '/' }] },
  });
  const result = await signedIn(() => shoot({ cwd: tmpdir(), tours, ffmpeg: '/nonexistent/ffmpeg' }));
  assert.ok(unavailable(result));
  assert.match(result.reason, /no ffmpeg was found to encode recordings/);
});

test('a recorded journey that fails leaves no frames behind', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-record-'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'pagebeam-record-tmp-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    const tours = toursFor(app.url, {
      broken: {
        account: 'writer',
        record: QUICK,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        steps: [{ goto: '/notes' }, { click: '#missing' }],
      },
    });
    const outcome = await signedIn(() => shoot({ cwd, tours })).catch((e: unknown) => e as Error);
    if (!(outcome instanceof Error) && unavailable(outcome)) {
      t.skip(`nothing to record with: ${outcome.reason}`);
      return;
    }
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /step 1 \(click #missing\) failed/);
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    await app.stop();
  }
});

test('typing longer than the step timeout still finishes', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-record-'));
  const title = 'A note title long enough that typing it takes longer than the timeout';
  try {
    const tours = toursFor(app.url, {
      long: {
        account: 'writer',
        record: { ...QUICK, typeMs: 50 },
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        steps: [{ goto: '/notes' }, { click: '#new' }, { fill: { selector: '#title', value: title } }],
      },
    });
    assert.ok(title.length * 50 > 3000, 'the typing outlasts the 3 s timeout');
    const result = await signedIn(() => shoot({ cwd, tours }));
    if (unavailable(result)) {
      t.skip(`nothing to record with: ${result.reason}`);
      return;
    }
    const fill = result.manifests[0]!.manifest.recordings[0]!.timeline.find((m) => m.action === 'fill #title');
    assert.ok(fill!.until - fill!.at >= title.length * 50);
  } finally {
    await app.stop();
  }
});
