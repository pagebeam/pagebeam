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
  say?: string;
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
          { goto: '/notes' },
          { say: 'Here are your notes' },
          { click: '#new' },
          { wait: '#dialog' },
          { fill: { selector: '#title', value: 'Groceries' } },
          { shot: { name: 'dialog', focus: ['#title'] } },
          { say: { text: 'That is it', ms: 600 } },
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
      ['goto /notes', 'say', 'click #new', 'wait #dialog', 'fill #title', 'say'],
    );
    for (const [i, moment] of timeline.entries()) {
      assert.ok(moment.until >= moment.at, `moment ${i} ends after it starts`);
      if (i > 0) assert.ok(moment.at >= timeline[i - 1]!.at, `moment ${i} starts in order`);
    }

    const [, first, click, , fill, last] = timeline;
    assert.equal(first!.say, 'Here are your notes');
    assert.equal(first!.until - first!.at, 1600, 'four words, unmeasured, take 400 ms each');
    assert.ok(click!.at < first!.until, 'what is done carries on while a line is said');
    assert.deepEqual(click!.box, { x: 100, y: 50, width: 200, height: 40 });
    assert.ok(fill!.until - fill!.at >= 'Groceries'.length * QUICK.typeMs, 'typed a letter at a time');
    assert.ok(last!.at >= first!.until, 'a line waits for the one before it');
    assert.equal(last!.until - last!.at, 600);
    assert.ok(recording.durationMs >= last!.until, 'the video runs until the last line is said');
  } finally {
    await app.stop();
  }
});

test('measured narration sets how long each line holds the recording', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-record-'));
  try {
    const tours = toursFor(app.url, {
      intro: {
        account: 'writer',
        record: { ...QUICK, cursor: false },
        viewports: [{ name: 'phone', width: 390, height: 600 }],
        steps: [{ goto: '/notes' }, { say: 'One' }, { say: { text: 'Two', ms: 5000 } }],
      },
    });
    const result = await signedIn(() => shoot({ cwd, tours, narration: { intro: [900, 300] } }));
    if (unavailable(result)) {
      t.skip(`nothing to record with: ${result.reason}`);
      return;
    }
    const timeline: Moment[] = result.manifests[0]!.manifest.recordings[0]!.timeline;
    const [, one, two] = timeline;
    assert.equal(one!.until - one!.at, 900);
    assert.equal(two!.until - two!.at, 300, 'a measured length wins over the one in the config');
    assert.ok(two!.at >= one!.until);
  } finally {
    await app.stop();
  }
});

test('narration that does not match the lines a journey says is refused before a browser starts', async () => {
  const tours = toursFor('http://127.0.0.1:1', {
    intro: { account: 'writer', record: true, steps: [{ say: 'One' }, { say: 'Two' }] },
  });
  await signedIn(async () => {
    await assert.rejects(
      shoot({ cwd: tmpdir(), tours, narration: { intro: [900] } }),
      /the narration gives 1 length\(s\) for journey "intro", which says 2 line\(s\)/,
    );
    await assert.rejects(shoot({ cwd: tmpdir(), tours, narration: { outro: [900] } }), /no journey called outro/);
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
