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
        assert.equal(await input.inputValue(), env.PAGEBEAM_RUNTIME_DATA, 'the frame input receives the typed value');
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

test('environment typing follows nested shadow focus and preserves surrounding evidence', async () => {
  const app = await notesApp();
  const recording = await exec('ffmpeg', ['-version']).then(() => true, () => false);
  try {
    const cwd = await applicationWorkspace(app.url, { notes: {
      account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }],
      record: recording ? { cursor: false, typeMs: 0, moveMs: 0, holdMs: 0 } : false,
      steps: [
        { goto: '/shadow-notes' }, { click: '#shadow-title' }, { shot: { name: 'before' } },
        { type: { valueEnv: 'PAGEBEAM_RUNTIME_DATA' } }, { verify: './check.mjs' }, { shot: { name: 'after' } },
      ],
    } }, ['#shadow-title', '#shadow-echo']);
    await writeFile(path.join(cwd, 'check.mjs'), `import assert from 'node:assert/strict';
      export default async (page, { env }) => {
        const input = page.locator('#shadow-title');
        assert.equal(await input.inputValue(), env.PAGEBEAM_RUNTIME_DATA, 'the shadow input receives the typed value');
        assert.equal(await input.getAttribute('data-pagebeam-typed-private'), 'true', 'the shadow input receives the privacy marker');
        for (const selector of ['body', 'note-host', 'note-input']) {
          assert.equal(await page.locator(selector).getAttribute('data-pagebeam-typed-private'), null, 'containers remain unmarked');
        }
        if (env.EXPECT_RECORDING_MASK === 'true') {
          for (const selector of ['#shadow-title', '#shadow-echo']) {
            const opacity = await page.locator(selector).evaluate(element => getComputedStyle(element).opacity);
            assert.equal(opacity, '0', selector + ' is hidden from recordings (opacity ' + opacity + ')');
          }
        }
      };`);
    const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--all', '--json'], {
      env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada', PAGEBEAM_RUNTIME_DATA: 'shadow-runtime-value', EXPECT_RECORDING_MASK: String(recording) },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.report.status, 'passed');
    const directory = path.join(result.directory, 'notes', 'desktop');
    assert.ok((await readFile(path.join(directory, '002-before.png'))).equals(await readFile(path.join(directory, '005-after.png'))), 'typing must preserve the unmasked component content');
  } finally { await app.stop(); }
});

test('a git baseline reuses one language-neutral environment and produces paired screenshots', async () => {
  const app = await notesApp();
  const { createServer } = await import('node:net');
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address() as { port: number };
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const cwd = await workspace();
  const frontend = (label: string): string => `
    import { createServer } from 'node:http';
    import { existsSync } from 'node:fs';
    if (${JSON.stringify(label)} === 'before' && !existsSync('installed.txt')) throw new Error('baseline dependencies missing');
    createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(${JSON.stringify(app.url)} + request.url, {
        method: request.method, headers: request.headers, redirect: 'manual',
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
      });
      const body = (await upstream.text()).replace('</body>', '<p>${label}</p></body>');
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'text/html',
        ...(upstream.headers.has('location') ? { location: upstream.headers.get('location') } : {}),
        ...(upstream.headers.has('set-cookie') ? { 'set-cookie': upstream.headers.get('set-cookie') } : {})
      });
      response.end(body);
    }).listen(${address.port}, '127.0.0.1');`;
  try {
    await exec('git', ['init', '-q'], { cwd });
    await exec('git', ['config', 'user.name', 'Fixture'], { cwd });
    await exec('git', ['config', 'user.email', 'fixture@example.test'], { cwd });
    await writeFile(path.join(cwd, 'frontend.mjs'), frontend('before'));
    await exec('git', ['add', 'frontend.mjs'], { cwd });
    await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Before'], { cwd });
    const before = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await writeFile(path.join(cwd, 'frontend.mjs'), frontend('after'));
    await exec('git', ['add', 'frontend.mjs'], { cwd });
    await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'After'], { cwd });
    const after = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({
      capture: { environments: { ci: {
        backend: { kind: 'url', url: app.url, revision: 'notes-v1' },
        frontend: { path: '.', start: `${process.execPath} frontend.mjs`, ready: `http://127.0.0.1:${address.port}/login` },
        fixtures: { version: 'notes-v1' }, timeoutMs: 15000,
      } } },
      tours: {
        timeoutMs: 10000, targets: { ci: { url: `http://127.0.0.1:${address.port}` } },
        accounts: { reader: {
          purpose: 'notes reader', login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } }, confirm: '#signout',
        } },
        journeys: { notes: { account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }], steps: [{ goto: '/notes' }, { expect: { selector: 'li.note', text: 'First note' } }, { shot: { name: 'notes' } }] } },
      },
    }));
    const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--environment', 'ci', '--target', 'ci', '--compare-base', before,
      '--baseline-install', `${process.execPath} -e "require('node:fs').writeFileSync('installed.txt','baseline')"`, '--all', '--json'], {
      env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada' }, timeout: 60000,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.revision, after);
    assert.equal(result.comparison.report.base.revision, before);
    assert.equal(result.comparison.report.compatible, true);
    const shot = result.comparison.report.captures[0];
    const head = await readFile(path.join(result.directory, shot.head));
    const base = await readFile(path.join(result.comparison.directory, shot.base));
    assert.ok(!head.equals(base), 'both committed frontend versions must be captured');
    const gallery = await readFile(result.gallery, 'utf8');
    assert.ok(gallery.includes('<figcaption>Before</figcaption>'));
    assert.ok(gallery.includes('<figcaption>After</figcaption>'));
    assert.ok(gallery.includes(before));
    assert.ok(gallery.includes(after));
    assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(), after);
  } finally { await app.stop(); }
});

test('baseline install hooks require a baseline and cannot run during planning', async () => {
  const cwd = await workspace();
  const invalid = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--baseline-install', 'exit 93', '--all', '--plan'])
    .then(() => { throw new Error('the orphan install hook must be rejected'); }, error => error as { code: number; stderr: string });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /requires --compare-base/);
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--compare-base', 'not-a-revision', '--baseline-install', 'exit 93', '--all', '--plan']);
  assert.equal(JSON.parse(stdout).journeys.length, 2);
});


test('a source baseline rejects an environment without a frontend before starting services', async () => {
  const cwd = await workspace();
  const config = JSON.parse(await readFile(path.join(cwd, 'pagebeam.config.json'), 'utf8'));
  config.capture = { environments: { local: { backend: { kind: 'url', url: 'http://127.0.0.1:1', revision: 'never-started' } } } };
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify(config));
  const outcome = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--compare-base', 'HEAD', '--all', '--json'])
    .then(() => { throw new Error('the missing frontend must be rejected'); }, error => error as { code: number; stderr: string });
  assert.equal(outcome.code, 2);
  assert.match(outcome.stderr, /requires a configured frontend/);
});
