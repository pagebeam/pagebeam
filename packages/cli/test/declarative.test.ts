import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { notesApp } from '../../tour/test/fixture.ts';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../dist/main.js');
const fixtures = await mkdtemp(path.join(tmpdir(), 'pagebeam-config-suite-'));
async function workspace() {
  const cwd = await mkdtemp(path.join(fixtures, 'app-'));
  const config = {
    tours: {
      targets: { local: { url: 'http://127.0.0.1:1' } },
      accounts: { reader: { purpose: 'fixture reader', login: { script: 'never-run.mjs' }, confirm: '#signed-in' } },
      journeys: { notes: { account: 'reader', steps: [{ goto: '/notes' }, { shot: { name: 'notes' } }] } },
    },
  };
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify(config));
  return { cwd, config };
}
async function failure(cwd: string, name: string, env = process.env) {
  return exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--config', name, '--all', '--plan'], { env })
    .then(() => { throw new Error('configuration must be rejected'); }, error => error as {code: number; stderr: string});
}

test('CLI config inheritance merges objects, replaces arrays and resolves environment values after overrides', async () => {
  const { cwd, config } = await workspace();
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({ ...config, capture: { environments: { local: { backend: { kind: 'url', url: { $env: 'PAGEBEAM_UNUSED_REQUIRED_VALUE' }, revision: 'base' } } } } }));
  await mkdir(path.join(cwd, 'profiles'));
  await writeFile(path.join(cwd, 'profiles/ci.yaml'), `extends: ../pagebeam.config.json
capture:
  environments:
    local:
      backend:
        url: http://127.0.0.1:1
        revision: 'notes-\${env:PAGEBEAM_FIXTURE_REVISION}'
tours:
  journeys:
    notes:
      steps:
        - goto: /notes
        - shot: { name: replaced }
`);
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--config', 'profiles/ci.yaml', '--all', '--plan'], { env: { ...process.env, PAGEBEAM_FIXTURE_REVISION: 'v1' } });
  assert.equal(JSON.parse(stdout).journeys[0].name, 'notes');
});

test('missing variables, cycles and invalid parents fail before starting services without exposing values', async () => {
  const { cwd } = await workspace();
  await writeFile(path.join(cwd, 'missing.yaml'), `extends: pagebeam.config.json
tours:
  targets:
    local:
      url: \${env:PAGEBEAM_REQUIRED_FIXTURE_URL}
`);
  const missing = await failure(cwd, 'missing.yaml');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Set PAGEBEAM_REQUIRED_FIXTURE_URL/);
  await writeFile(path.join(cwd, 'a.yaml'), 'extends: b.yaml');
  await writeFile(path.join(cwd, 'b.yaml'), 'extends: a.yaml');
  assert.match((await failure(cwd, 'a.yaml')).stderr, /cyclic/);
  await writeFile(path.join(cwd, 'bad.yaml'), 'extends: [17]');
  assert.match((await failure(cwd, 'bad.yaml')).stderr, /extends must name/);
});

test('a declarative profile seeds through HTTP with native argv and cwd, infers the screenshot route and skips only fixed delays', async () => {
  const app = await notesApp();
  const { cwd, config } = await workspace();
  const backend = path.join(cwd, 'backend with spaces');
  const argument = 'a value; $(touch should-not-exist)';
  await mkdir(backend);
  await writeFile(path.join(backend, 'seed.mjs'), `import assert from 'node:assert/strict';
assert.equal(process.argv[2], ${JSON.stringify(argument)});
const response = await fetch(process.env.PAGEBEAM_TARGET_URL + '/signup', {method: 'POST'});
console.log(JSON.stringify(await response.json()));`);
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({
    ...config,
    tours: {
      ...config.tours, timeoutMs: 10000, targets: { local: { url: app.url } },
      accounts: { reader: {
        purpose: 'fresh notes reader', fresh: true,
        login: { form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } },
        confirm: '#signout', seed: { command: ['must-not-run'] },
      } },
      journeys: { notes: { account: 'reader', steps: [{ goto: '/wrong' }] } },
    },
  }));
  await writeFile(path.join(cwd, 'ci.yaml'), `extends: pagebeam.config.json
capture:
  skipDelays: true
  environments:
    local:
      backend: { kind: url, url: '\${env:PAGEBEAM_FIXTURE_URL}', revision: notes-v1 }
      timeoutMs: 15000
tours:
  accounts:
    reader:
      seed:
        command: ${JSON.stringify([process.execPath, 'seed.mjs', argument])}
        cwd: { $env: PAGEBEAM_FIXTURE_BACKEND }
        targets: [local]
  journeys:
    notes:
      steps:
        - goto: /notes
        - wait: 60000
        - wait: '#signout'
        - expect: { selector: body, text: Nothing here yet }
        - shot: { name: notes }
`);
  try {
    const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--config', 'ci.yaml', '--all', '--json'], {
      env: { ...process.env, PAGEBEAM_FIXTURE_URL: app.url, PAGEBEAM_FIXTURE_BACKEND: backend }, timeout: 30000,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.results[0].steps[1].skipped, 'configured delay skip');
    assert.equal(result.report.results[0].steps[2].status, 'passed');
    assert.equal(result.report.results[0].steps[4].route, '/notes');
    assert.equal(result.outcome.captures.length, 1);
    await assert.rejects(access(path.join(backend, 'should-not-exist')));
    assert.ok((await readFile(result.markdown, 'utf8')).includes('| Screen | Before | After |'));
    const profile = await readFile(path.join(cwd, 'ci.yaml'), 'utf8');
    await writeFile(path.join(cwd, 'ci.yaml'), profile.replace('- shot: { name: notes }', "- click: '#signout'\n        - shot: { name: notes }"));
    const redirected = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--config', 'ci.yaml', '--all', '--json'], {
      env: { ...process.env, PAGEBEAM_FIXTURE_URL: app.url, PAGEBEAM_FIXTURE_BACKEND: backend }, timeout: 30000,
    }).then(() => { throw new Error('navigation without a matching checkpoint must fail'); }, error => error as {code: number; stdout: string});
    assert.equal(redirected.code, 1);
    assert.match(JSON.parse(redirected.stdout).report.results[0].error, /expected route \/notes, reached \/login/);
  } finally { await app.stop(); }
});


test('the public loader supports ordered overlays, defaults and literal environment data', async () => {
  const { loadConfig } = await import('../dist/index.js');
  const { cwd, config } = await workspace();
  await writeFile(path.join(cwd, 'base.json'), JSON.stringify(config));
  await writeFile(path.join(cwd, 'middle.yaml'), 'tours:\n  timeoutMs: 1234\n');
  await writeFile(path.join(cwd, 'pagebeam.config.json'), JSON.stringify({
    extends: ['base.json', 'middle.yaml'],
    tours: { targets: { local: { url: { $env: 'PAGEBEAM_CONFIG_MISSING_URL', default: 'http://127.0.0.1:1' } } } },
    capture: { environments: {}, skipDelays: { $env: 'PAGEBEAM_CONFIG_MISSING_FLAG', default: false } },
  }));
  const loaded = await loadConfig(cwd);
  assert.equal(loaded.config.tours!.timeoutMs, 1234);
  assert.equal(loaded.config.tours!.targets.local!.url, 'http://127.0.0.1:1');
  assert.equal(loaded.config.capture!.skipDelays, false);
  await writeFile(path.join(cwd, 'literal.yaml'), `extends: base.json
tours:
  accounts:
    reader:
      purpose: '\${env:PAGEBEAM_LITERAL_DATA}'
`);
  process.env.PAGEBEAM_LITERAL_DATA = '${env:DO_NOT_EXPAND}';
  try {
    const literal = await loadConfig(cwd, 'literal.yaml');
    assert.equal(literal.config.tours!.accounts.reader!.purpose, '${env:DO_NOT_EXPAND}');
  } finally { delete process.env.PAGEBEAM_LITERAL_DATA; }
});
