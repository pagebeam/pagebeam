import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
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
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--journey', 'second', '--journey', 'first', '--changed-files', 'changed.json', '--plan', '--diff-images']);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.journeys.map((journey: { name: string }) => journey.name), ['second', 'first']);
  assert.equal(result.journeys[0].reasons[0], 'explicit selection');
});

test('non-UI CLI changes retain an empty report without starting the app', async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, 'changed.json'), JSON.stringify(['README.md']));
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
      const body = (await upstream.text()).replace('</body>', request.url === '/notes' ? '<div style="width:100px;height:100px;background:${label === 'before' ? 'black' : 'red'}"></div></body>' : '</body>');
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
      capture: { impact: { routes: { '/notes': ['frontend.mjs'] } }, environments: { ci: {
        backend: { kind: 'url', url: app.url, revision: 'notes-v1' },
        frontend: { path: '.', start: `${process.execPath} frontend.mjs`, ready: `http://127.0.0.1:${address.port}/login` },
        fixtures: { version: 'notes-v1' }, timeoutMs: 15000,
      } } },
      tours: {
        timeoutMs: 10000, targets: { ci: { url: `http://127.0.0.1:${address.port}` } },
        accounts: { reader: {
          purpose: 'notes reader', login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } }, confirm: '#signout',
        } },
        journeys: { notes: { account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }], steps: [{ goto: '/notes' }, { expect: { selector: 'li.note', text: 'First note' } }, { shot: { name: 'notes', route: '/notes' } }, { goto: '/login' }, { shot: { name: 'unchanged', route: '/login' } }] } },
      },
    }));
    for (const mode of ['off', 'flag', 'config']) {
      const configPath = path.join(cwd, 'pagebeam.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.capture.diffImages = mode === 'config';
      await writeFile(configPath, JSON.stringify(config));
      const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--environment', 'ci', '--target', 'ci', '--compare-base', 'HEAD~1', '--all', '--viewport', 'all', ...(mode === 'flag' ? ['--diff-images'] : []),
        '--baseline-install', `${process.execPath} -e "require('node:fs').writeFileSync('installed.txt','baseline')"`, '--html', '--json'], {
        env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada' }, timeout: 60000,
      });
      const result = JSON.parse(stdout);
      assert.equal(result.report.status, 'passed');
      assert.equal(result.report.revision, after);
      assert.equal(result.outcome.coverage.status, 'manual');
      assert.equal(result.comparison.report.base.revision, before);
      assert.equal(result.comparison.report.compatible, true);
      const outcome = JSON.parse(await readFile(result.manifest, 'utf8'));
      assert.deepEqual(result.outcome, outcome);
      assert.equal(outcome.captures.length, 2);
      const [changed, unchanged] = outcome.captures;
      assert.ok(changed.pixels > 0);
      assert.ok(changed.percent > 0);
      assert.ok(changed.region);
      assert.equal(unchanged.pixels, 0);
      assert.equal(unchanged.percent, 0);
      assert.equal(unchanged.region, null);
      const diffImages = mode !== 'off';
      assert.equal(outcome.diffImages, diffImages);
      for (const capture of outcome.captures) {
        assert.equal(Boolean(capture.diff), diffImages && capture.pixels > 0);
        if (capture.diff) {
          assert.ok(await readFile(path.join(path.dirname(result.manifest), capture.diff)));
          assert.ok(outcome.evidence.some((item: {file: string; mediaType: string}) => item.file === capture.diff && item.mediaType === 'image/png'));
        }
      }
      assert.equal((await readdir(path.dirname(result.manifest))).filter(file => file.endsWith('-diff.png')).length, diffImages ? 1 : 0);
      assert.equal(outcome.evidence.filter((item: {mediaType: string}) => item.mediaType === 'image/png').length, diffImages ? 5 : 4);
      const shot = result.comparison.report.captures[0];
      const head = await readFile(path.join(result.directory, shot.head));
      const base = await readFile(path.join(result.comparison.directory, shot.base));
      assert.ok(!head.equals(base), 'both committed frontend versions must be captured');
      const gallery = await readFile(result.gallery, 'utf8');
      assert.ok(gallery.includes('<th>Before</th>'));
      assert.ok(gallery.includes('<th>After</th>'));
      assert.ok(gallery.includes(before));
      assert.ok(gallery.includes(after));
      assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(), after);
    }
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

test('capture defaults to desktop and captures mobile only when requested', async () => {
  const app = await notesApp();
  try {
    const cwd = await applicationWorkspace(app.url, { notes: {
      account: 'reader',
      viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }, { name: 'phone', width: 390, height: 600, scale: 1 }],
      steps: [{ goto: '/notes' }, { shot: { name: 'notes' } }],
    } });
    for (const [args, expected] of [[[], ['desktop']], [['--viewport', 'phone'], ['phone']], [['--viewport', 'all'], ['desktop', 'phone']]] as [string[], string[]][]) {
      const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--all', '--json', ...args], {
        env: { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada' },
      });
      assert.deepEqual(JSON.parse(stdout).report.results.map((result: { viewport: string }) => result.viewport), expected);
      const result = JSON.parse(stdout);
      assert.equal(result.gallery, undefined);
      assert.ok((await readFile(result.markdown, 'utf8')).includes('| Screen | Before | After |'));
      const outcome = JSON.parse(await readFile(result.manifest, 'utf8'));
      assert.deepEqual(result.outcome, outcome);
      assert.equal(outcome.captures.length, expected.length);
      assert.equal(outcome.evidence.filter((item: {mediaType: string}) => item.mediaType === 'image/png').length, expected.length);
    }
    const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--all', '--plan']);
    assert.deepEqual(JSON.parse(stdout).journeys[0].viewports, ['desktop']);
  } finally { await app.stop(); }
});

test('cloud capture uploads real evidence, resumes, retries and preserves local reports on failure', async () => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { cloud } = await import('../../tour/dist/cloud.js');
  const { symlink } = await import('node:fs/promises');
  const app = await notesApp();
  const received = new Map<string, Buffer>();
  const attempts = new Map<string, number>();
  const requests: string[] = [];
  const token = 'test-cloud-token';
  let fail = false;
  let retried = false;
  let declared: { path: string; size: number; sha256: string; media_type: string }[] = [];
  let externalAuthorization: string | undefined;
  const external = createServer(async (req, res) => {
    externalAuthorization = req.headers.authorization;
    for await (const _chunk of req) {}
    res.end();
  });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
  const externalUrl = `http://127.0.0.1:${(external.address() as { port: number }).port}`;
  let crossOrigin = false;
  let apiUrl = '';
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (fail) { res.writeHead(503); res.end(JSON.stringify({ message: `Service unavailable ${token}` })); return; }
    if (req.method === 'POST' && req.url === '/v1/runs') {
      assert.equal(req.headers['idempotency-key'], '123-1');
      const body = JSON.parse(bytes.toString());
      assert.equal(body.repository, 'fixture/notes');
      assert.equal(body.pull_request, 42);
      assert.equal(body.head_sha, 'a'.repeat(40));
      assert.equal(body.base_sha, 'b'.repeat(40));
      assert.equal(body.branch, 'feature');
      declared = body.files;
      assert.deepEqual(declared.map(file => file.path), body.outcome.evidence.map((item: { file: string }) => item.file));
      res.end(JSON.stringify({ data: { id: 'run', review_url: `${apiUrl}/review`, uploads: declared.filter(file => crossOrigin || !received.has(file.path)).map(file => ({ path: file.path, url: crossOrigin ? `${externalUrl}/upload` : `${apiUrl}/upload/${encodeURIComponent(file.path)}`, headers: { 'Content-Type': file.media_type } })) } }));
    } else if (req.method === 'PUT') {
      const name = decodeURIComponent(req.url!.slice('/upload/'.length));
      attempts.set(name, (attempts.get(name) ?? 0) + 1);
      if (!retried) { retried = true; res.writeHead(500); res.end(JSON.stringify({ message: 'Try again' })); return; }
      const file = declared.find(file => file.path === name)!;
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      assert.equal(req.headers['content-type'], file.media_type);
      assert.ok(!received.has(name));
      received.set(name, bytes);
      res.end('{}');
    } else {
      assert.equal(req.url, '/v1/runs/run/complete');
      assert.ok(crossOrigin || declared.every(file => received.has(file.path)));
      res.end(JSON.stringify({ data: { id: 'run', status: 'ready', review_url: `${apiUrl}/review` } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cwd = await applicationWorkspace(app.url, { notes: {
      account: 'reader', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }],
      steps: [{ goto: '/notes' }, { shot: { name: 'notes' } }],
    } });
    const eventPath = path.join(cwd, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } } }));
    const env = { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada', PAGEBEAM_TOKEN: token, PAGEBEAM_API_URL: apiUrl,
      GITHUB_REPOSITORY: 'fixture/notes', GITHUB_EVENT_PATH: eventPath, GITHUB_HEAD_REF: 'feature', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
    const args = [cli, 'capture', '--cwd', cwd, '--all', '--json'];
    const { stdout } = await exec(process.execPath, args, { env });
    const result = JSON.parse(stdout);
    assert.equal(result.outcome.cloud.url, `${apiUrl}/review`);
    assert.ok((await readFile(result.markdown, 'utf8')).startsWith(`Review every changed screen: <${apiUrl}/review>`));
    assert.ok((await readFile(result.markdown, 'utf8')).includes(`![After](<${result.outcome.captures[0].head}>)`));
    assert.ok(declared.some(file => file.media_type === 'image/png'));
    assert.ok(declared.some(file => file.media_type === 'application/json'));
    assert.equal(received.size, declared.length);
    assert.equal([...attempts.values()].filter(count => count === 2).length, 1);
    const publisher = cloud({ token, apiUrl, repository: 'fixture/notes', pullRequest: 42, branch: 'feature', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), idempotencyKey: '123-1' });
    const context = { directory: path.dirname(result.manifest), namespace: 'test' };
    const puts = [...attempts.values()].reduce((a, b) => a + b, 0);
    assert.deepEqual(await publisher.publish(result.outcome, context), { url: `${apiUrl}/review`, urls: {} });
    assert.equal([...attempts.values()].reduce((a, b) => a + b, 0), puts);
    for (const file of ['../outside.png', '/outside.png']) {
      const count = requests.length;
      await assert.rejects(publisher.publish({ ...result.outcome, evidence: [{ ...result.outcome.evidence[0], file }] }, context), /outside the outcome directory/);
      assert.equal(requests.length, count);
    }
    await symlink(eventPath, path.join(context.directory, 'escape.json'));
    const count = requests.length;
    await assert.rejects(publisher.publish({ ...result.outcome, evidence: [{ id: 'escape', file: 'escape.json', mediaType: 'application/json' }] }, context), /outside the outcome directory/);
    assert.equal(requests.length, count);
    crossOrigin = true;
    await publisher.publish(result.outcome, context);
    assert.equal(externalAuthorization, undefined);
    fail = true;
    const failed = await exec(process.execPath, args, { env });
    const local = JSON.parse(failed.stdout);
    assert.match(failed.stderr, /Service unavailable <REDACTED>/);
    assert.ok(!failed.stderr.includes(token));
    assert.match(local.outcome.cloud.error, /Service unavailable/);
    assert.ok(!JSON.stringify(local).includes(token));
    assert.deepEqual(JSON.parse(await readFile(local.manifest, 'utf8')), local.outcome);
    assert.match(await readFile(local.markdown, 'utf8'), /Screen \| Before \| After/);
    const failedCapture = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--json'], { env })
      .then(() => { throw new Error('an unselected capture must fail'); }, error => error as { code: number; stdout: string });
    assert.equal(failedCapture.code, 1);
    const unselected = JSON.parse(failedCapture.stdout);
    assert.match(unselected.outcome.cloud.error, /Service unavailable/);
    assert.ok(await readFile(unselected.markdown, 'utf8'));

  } finally {
    await app.stop();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => external.close(() => resolve()))]);
  }
});
