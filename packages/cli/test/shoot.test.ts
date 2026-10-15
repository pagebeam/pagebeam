import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { notesApp } from '../../tour/test/fixture.ts';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../dist/main.js');

async function invoke(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

const config = (url: string): string => `docs:
  root: .
tours:
  timeoutMs: 3000
  targets:
    local: { url: ${url} }
  accounts:
    writer:
      purpose: a user with notes
      login:
        usernameEnv: NOTES_USER
        passwordEnv: NOTES_PASSWORD
        form: { url: /login, username: '#username', password: '#password', submit: '#submit' }
      confirm: '#signout'
      seed: { command: npm run seed:notes }
      requires:
        - goto: /notes
          count: { selector: li.note, min: 3 }
  journeys:
    notes:
      account: writer
      viewports: [{ name: desktop, width: 800, height: 600 }]
      steps:
        - goto: /notes
        - shot: { name: list, caption: Your notes, focus: ['#new'] }
`;

test('shoot writes screenshots and a manifest for each journey', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-shoot-'));
  await writeFile(path.join(cwd, 'pagebeam.config.yaml'), config(app.url));
  try {
    const { code, out, err } = await invoke(['shoot', '--cwd', cwd, '--json'], {
      NOTES_USER: 'ada',
      NOTES_PASSWORD: 'pw-ada',
    });
    if (code === 2 && /no browser|playwright-core/.test(err)) {
      t.skip(err.trim());
      return;
    }
    assert.equal(code, 0, err);
    const result = JSON.parse(out);
    assert.equal(result.target, 'local');
    const dir = path.join(cwd, '.pagebeam/shots/local/notes');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.shots[0].file, '01-list.desktop.png');
    await access(path.join(dir, '01-list.desktop.png'));
  } finally {
    await app.stop();
  }
});

test('an account that is not ready exits one and says which seed to run', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-shoot-'));
  await writeFile(path.join(cwd, 'pagebeam.config.yaml'), config(app.url));
  try {
    const { code, err } = await invoke(['shoot', '--cwd', cwd], {
      NOTES_USER: 'bo',
      NOTES_PASSWORD: 'pw-bo',
    });
    if (code === 2 && /no browser|playwright-core/.test(err)) {
      t.skip(err.trim());
      return;
    }
    assert.equal(code, 1);
    assert.match(err, /account "writer" is not ready on target "local"/);
    assert.match(err, /Run the seed: npm run seed:notes/);
  } finally {
    await app.stop();
  }
});

test('shoot without tours configured exits two', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-shoot-'));
  await writeFile(path.join(cwd, 'pagebeam.config.yaml'), 'docs:\n  root: .\n');
  const { code, err } = await invoke(['shoot', '--cwd', cwd]);
  assert.equal(code, 2);
  assert.match(err, /No tours are configured/);
});

test('an invalid tours setting is named', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-shoot-'));
  await writeFile(
    path.join(cwd, 'pagebeam.config.yaml'),
    config('http://127.0.0.1:1').replace('purpose:', 'password: x\n      purpose:'),
  );
  const { code, err } = await invoke(['shoot', '--cwd', cwd]);
  assert.equal(code, 2);
  assert.match(err, /tours\.accounts\.writer: Unrecognized key\(s\) in object: 'password'/);
});

const recorded = (url: string): string =>
  config(url).replace(
    "        - shot: { name: list, caption: Your notes, focus: ['#new'] }\n",
    "        - say: Your notes\n        - click: '#new'\n      record: { typeMs: 0, moveMs: 100, holdMs: 100 }\n",
  );

test('shoot records a journey paced by the narration it is given', async (t) => {
  const app = await notesApp();
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-shoot-'));
  await writeFile(path.join(cwd, 'pagebeam.config.yaml'), recorded(app.url));
  await writeFile(path.join(cwd, 'narration.json'), JSON.stringify({ notes: [700] }));
  try {
    const env = { NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada' };
    const { code, out, err } = await invoke(['shoot', '--cwd', cwd, '--narration', 'narration.json'], env);
    if (code === 2 && /no browser|no ffmpeg/.test(err)) {
      t.skip(err.trim());
      return;
    }
    assert.equal(code, 0, err);
    assert.match(out, /\.pagebeam\/shots\/local\/notes\/recording\.desktop\.mp4 \(\d+\.\d s\)/);
    const manifest = JSON.parse(await readFile(path.join(cwd, '.pagebeam/shots/local/notes/manifest.json'), 'utf8'));
    const line = manifest.recordings[0].timeline.find((m: { action: string }) => m.action === 'say');
    assert.equal(line.until - line.at, 700);
  } finally {
    await app.stop();
  }
});

test('shoot refuses narration that is not lengths by journey', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-shoot-'));
  await writeFile(path.join(cwd, 'pagebeam.config.yaml'), recorded('http://127.0.0.1:1'));
  await writeFile(path.join(cwd, 'narration.json'), JSON.stringify([700]));
  const { code, err } = await invoke(['shoot', '--cwd', cwd, '--narration', 'narration.json'], {
    NOTES_USER: 'ada',
    NOTES_PASSWORD: 'pw-ada',
  });
  assert.equal(code, 2);
  assert.match(err, /The narration must be \{"journey": \[ms, \.\.\.\]\}/);
});
