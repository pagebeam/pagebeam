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

async function applicationWorkspace(url: string, journeys: Record<string, unknown>, mask: string[] = []): Promise<string> {
  const cwd = await workspace();
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({
    capture: { mask, environments: { local: { backend: { kind: 'url', url, revision: 'notes-v1' }, timeoutMs: 5000 } } },
    tours: {
      timeoutMs: 5000,
      targets: { local: { url } },
      accounts: { reader: {
        purpose: 'notes reader',
        login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } },
        confirm: '#signout',
      } },
      journeys,
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
  const values = { typed: 'capture-runtime-111', filled: 'capture-runtime-222' };
  try {
    for (const name of ['typed', 'filled']) await writeFile(path.join(cwd, `fail-${name}.mjs`), `export default async (_page, { env }) => { throw new Error("Runtime failure: " + env.PAGEBEAM_RUNTIME_DATA_${name.toUpperCase()}); };`);
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
            name === 'typed' ? { type: { valueEnv: 'PAGEBEAM_RUNTIME_DATA_TYPED' } } : { fill: { selector: '#title', valueEnv: 'PAGEBEAM_RUNTIME_DATA_FILLED' } },
            { shot: { name: 'value' } }, { verify: `./fail-${name}.mjs` },
          ],
        }])),
      },
    }));
    const outcome = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--environment', 'local', '--target', 'local', '--all', '--json'], {
      env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada', PAGEBEAM_RUNTIME_DATA_TYPED: values.typed, PAGEBEAM_RUNTIME_DATA_FILLED: values.filled },
    }).then(() => { throw new Error('the failing verification must fail the run'); }, error => error as { code: number; stdout: string });
    assert.equal(outcome.code, 1);
    const result = JSON.parse(outcome.stdout);
    assert.equal(result.report.results[0].steps[4].status, 'passed');
    const typed = await readFile(path.join(result.directory, 'typed', 'desktop', '004-value.png'));
    const filled = await readFile(path.join(result.directory, 'filled', 'desktop', '004-value.png'));
    assert.ok(typed.equals(filled), 'typed and filled environment values must receive the same screenshot masks');
    assert.ok(result.report.errors[0].message.includes('<REDACTED>'));
    for (const value of Object.values(values)) {
      assert.ok(!outcome.stdout.includes(value));
      assert.ok(!(await readFile(path.join(result.directory, 'report.json'), 'utf8')).includes(value));
    }
  } finally { await app.stop(); }
});

test('environment typing without an editable focus fails without masking the page', async () => {
  const app = await notesApp();
  try {
    const cwd = await applicationWorkspace(app.url, { notes: {
      account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }],
      steps: [{ goto: '/notes' }, { shot: { name: 'before' } }, { type: { valueEnv: 'PAGEBEAM_RUNTIME_DATA' } }],
    } });
    const outcome = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--all', '--json'], {
      env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada', PAGEBEAM_RUNTIME_DATA: 'unfocused-runtime-value' },
    }).then(() => { throw new Error('typing without an editable focus must fail'); }, error => error as { code: number; stdout: string });
    assert.equal(outcome.code, 1);
    const result = JSON.parse(outcome.stdout);
    assert.match(result.report.errors[0].message, /requires a focused text input or editable element/);
    const directory = path.join(result.directory, 'notes', 'desktop');
    assert.ok((await readFile(path.join(directory, '001-before.png'))).equals(await readFile(path.join(directory, 'failure-2.png'))), 'a missing focus must not mask the page');
  } finally { await app.stop(); }
});

test('environment typing inside a frame masks the input without hiding the frame', async () => {
  const app = await notesApp();
  try {
    const cwd = await applicationWorkspace(app.url, { notes: {
      account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }],
      steps: [
        { goto: '/framed-notes' }, { verify: './focus.mjs' }, { shot: { name: 'before' } },
        { type: { valueEnv: 'PAGEBEAM_RUNTIME_DATA' } }, { verify: './check.mjs' }, { shot: { name: 'after' } },
      ],
    } }, ['#frame-title', '#frame-echo']);
    await writeFile(path.join(cwd, 'focus.mjs'), `export default async page => {
      await page.frameLocator('#note-frame').locator('#frame-title').click();
    };`);
    await writeFile(path.join(cwd, 'check.mjs'), `import assert from 'node:assert/strict';
      export default async (page, { env }) => {
        const input = page.frameLocator('#note-frame').locator('#frame-title');
        assert.equal(await input.inputValue(), env.PAGEBEAM_RUNTIME_DATA);
        assert.equal(await input.getAttribute('data-pagebeam-typed-private'), 'true');
        assert.equal(await page.locator('body').getAttribute('data-pagebeam-typed-private'), null);
        assert.equal(await page.locator('#note-frame').getAttribute('data-pagebeam-typed-private'), null);
      };`);
    const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--all', '--json'], {
      env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada', PAGEBEAM_RUNTIME_DATA: 'framed-runtime-value' },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.report.status, 'passed');
    const directory = path.join(result.directory, 'notes', 'desktop');
    assert.ok((await readFile(path.join(directory, '002-before.png'))).equals(await readFile(path.join(directory, '005-after.png'))), 'typing must preserve the unmasked frame content');
  } finally { await app.stop(); }
});
