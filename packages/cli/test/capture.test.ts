import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { notesApp } from '../../tour/test/fixture.ts';

const exec = promisify(execFile);
const cli = path.join(import.meta.dirname, '../dist/main.js');

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-capture-cli-'));
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({
    tours: {
      targets: { local: { url: 'http://127.0.0.1:1' } },
      accounts: { reader: { purpose: 'configuration tests', login: { script: 'never-run.mjs' }, confirm: '#signed-in' } },
      journeys: {
        first: { account: 'reader', paths: ['first/**'], steps: [{ goto: '/' }] },
        second: { account: 'reader', paths: ['second/**'], steps: [{ goto: '/' }] },
      },
    },
  }));
  return cwd;
}

test('capture planning accepts multiple explicit journeys and overrides changed-file mapping', async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, 'changed.json'), JSON.stringify(['first/form.vue']));
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--journey', 'second', '--journey', 'first', '--changed-files', 'changed.json', '--plan']);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.journeys.map((journey: { name: string }) => journey.name), ['second', 'first']);
  assert.equal(result.journeys[0].reasons[0], 'explicit selection');
});

test('unmapped CLI changes retain a browsable empty report without starting the app', async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, 'changed.json'), JSON.stringify(['unmapped.txt']));
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--changed-files', 'changed.json', '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.report.status, 'empty');
  assert.equal(result.report.results.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(result.directory, 'report.json'), 'utf8')).status, 'empty');
});

test('CLI capture never defaults to every journey', async () => {
  const cwd = await workspace();
  await assert.rejects(exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--json']), (error: unknown) => {
    const result = error as { code: number; stdout: string };
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).report.errors[0].stage, 'selection');
    return true;
  });
});

test('environment typing masks its input and echoed text and redacts failures', async () => {
  const app = await notesApp();
  const cwd = await workspace();
  const value = 'capture-runtime-marker';
  try {
    await writeFile(path.join(cwd, 'fail.mjs'), 'export default async (_page, { env }) => { throw new Error("Runtime failure: " + env.PAGEBEAM_RUNTIME_DATA); };');
    await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({
      capture: { environments: { local: { backend: { kind: 'url', url: app.url, revision: 'notes-v1' }, timeoutMs: 5000 } } },
      tours: {
        timeoutMs: 5000,
        targets: { local: { url: app.url } },
        accounts: { reader: {
          purpose: 'notes reader',
          login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } },
          confirm: '#signout',
        } },
        journeys: Object.fromEntries(['typed', 'filled'].map(name => [name, {
          account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }], steps: [
            { goto: '/notes' }, { click: '#new' }, { click: '#title' },
            name === 'typed' ? { type: { valueEnv: 'PAGEBEAM_RUNTIME_DATA' } } : { fill: { selector: '#title', valueEnv: 'PAGEBEAM_RUNTIME_DATA' } },
            { shot: { name: 'value' } }, { verify: './fail.mjs' },
          ],
        }])),
      },
    }));
    const outcome = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--environment', 'local', '--target', 'local', '--all', '--json'], {
      env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada', PAGEBEAM_RUNTIME_DATA: value },
    }).then(() => { throw new Error('the failing verification must fail the run'); }, error => error as { code: number; stdout: string });
    assert.equal(outcome.code, 1);
    const result = JSON.parse(outcome.stdout);
    assert.equal(result.report.results[0].steps[4].status, 'passed');
    const typed = await readFile(path.join(result.directory, 'typed', 'desktop', '004-value.png'));
    const filled = await readFile(path.join(result.directory, 'filled', 'desktop', '004-value.png'));
    assert.ok(typed.equals(filled), 'typed and filled environment values must receive the same screenshot masks');
    assert.ok(result.report.errors[0].message.includes('<REDACTED>'));
    assert.ok(!outcome.stdout.includes(value));
    assert.ok(!(await readFile(path.join(result.directory, 'report.json'), 'utf8')).includes(value));
  } finally { await app.stop(); }
});
