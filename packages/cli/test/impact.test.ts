import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { parse } from 'yaml';
import { notesApp } from '../../tour/test/fixture.ts';

const exec = promisify(execFile);
const cli = path.join(import.meta.dirname, '../dist/main.js');
const fixtures = await mkdtemp(path.join(tmpdir(), 'pagebeam-impact-suite-'));
async function put(cwd: string, name: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), text);
}
async function workspace() {
  const cwd = await mkdtemp(path.join(fixtures, 'app-'));
  const config = {
    tours: {
      targets: { local: { url: 'http://127.0.0.1:1' } }, timeoutMs: 3000,
      accounts: { reader: { purpose: 'impact fixture', login: { script: 'never-run.mjs' }, confirm: '#signed-in' } },
      journeys: {
        notes: { account: 'reader', steps: [{ goto: '/notes' }, { shot: { name: 'notes', route: '/notes' } }, { goto: '/wallets' }, { shot: { name: 'extra', route: '/wallets' } }] },
        wallets: { account: 'reader', steps: [{ goto: '/wallets' }, { shot: { name: 'wallets', route: '/wallets' } }] },
        dashboard: { account: 'reader', paths: ['.github/**'], steps: [{ goto: '/dashboard' }, { shot: { name: 'dashboard', route: '/dashboard' } }] },
      },
    },
    capture: { environments: { local: { backend: { kind: 'url', url: 'http://127.0.0.1:1', revision: 'unused' }, prepare: ['exit 99'] } } },
  };
  await put(cwd, 'pagebeam.config.json', JSON.stringify(config));
  await put(cwd, 'components/NoteList.vue', '<template><p>Notes</p></template>');
  await put(cwd, 'components/Nav.vue', '<template><nav>Navigation</nav></template>');
  await put(cwd, 'components/index.ts', `export { default as NoteList } from './NoteList.vue';`);
  await put(cwd, 'pages/notes.vue', `<script setup>import { NoteList } from '../components/index'; import Nav from '../components/Nav.vue';</script><template><Nav/><NoteList/></template>`);
  await put(cwd, 'pages/wallets.vue', `<script setup>import Nav from '../components/Nav.vue';</script><template><Nav/>Wallets</template>`);
  await exec('git', ['init', '-q'], { cwd });
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd });
  await exec('git', ['config', 'user.email', 'fixture@example.test'], { cwd });
  await exec('git', ['add', '.'], { cwd });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial fixture'], { cwd });
  return { cwd, config };
}
async function run(cwd: string, changed: string[], extra: string[] = [], plan = true) {
  await put(cwd, 'changed.json', JSON.stringify(changed));
  const result = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--changed-files', 'changed.json', ...(plan ? ['--plan'] : ['--json']), ...extra])
    .then(result => ({ ...result, code: 0 }), error => error as { code: number; stdout: string; stderr: string });
  return { code: result.code, value: JSON.parse(result.stdout) };
}

test('CLI traces a changed component through a barrel to its screenshot journey', async () => {
  const { cwd } = await workspace();
  const { code, value } = await run(cwd, ['components/NoteList.vue']);
  assert.equal(code, 0);
  assert.equal(value.coverage.status, 'complete');
  assert.deepEqual(value.coverage.routes.map((item: {route: string}) => item.route), ['/notes']);
  assert.deepEqual(value.journeys.map((item: {name: string}) => item.name), ['notes']);
  assert.deepEqual(value.journeys[0].viewports, ['desktop']);
});

test('shared components select all affected screens without a representative fallback', async () => {
  const { cwd } = await workspace();
  const { value } = await run(cwd, ['components/Nav.vue']);
  assert.equal(value.coverage.status, 'complete');
  assert.deepEqual(value.coverage.routes.map((item: {route: string}) => item.route), ['/notes', '/wallets']);
  assert.ok(!value.journeys.some((item: {name: string}) => item.name === 'dashboard'));
});

test('CI-only changes ignore the old dashboard mapping and never start services', async () => {
  const { cwd } = await workspace();
  const { code, value } = await run(cwd, ['.github/workflows/capture.yml', 'README.md'], [], false);
  assert.equal(code, 0);
  assert.equal(value.report.status, 'empty');
  assert.equal(value.outcome.coverage.status, 'no-ui');
  assert.deepEqual(value.report.results, []);
  assert.equal(value.report.backend, undefined);
  assert.match(await readFile(value.markdown, 'utf8'), /No UI changes detected/);
});

test('uncovered screens and unknown source changes exit incomplete without starting services', async () => {
  const { cwd } = await workspace();
  await put(cwd, 'pages/settings.vue', '<template>Settings</template>');
  for (const changed of [['pages/settings.vue'], ['components/Unknown.vue']]) {
    const { code, value } = await run(cwd, changed, [], false);
    assert.equal(code, 2);
    assert.equal(value.report.status, 'incomplete');
    assert.equal(value.report.backend, undefined);
    assert.deepEqual(value.outcome.captures, []);
    assert.match(await readFile(value.markdown, 'utf8'), /UI coverage: \*\*incomplete\*\*/);
  }
});

test('visiting a page during account preparation does not count as screenshot coverage', async () => {
  const { cwd, config } = await workspace();
  config.tours.journeys.notes.steps = [{ goto: '/notes' }];
  await put(cwd, 'pagebeam.config.json', JSON.stringify(config));
  const { code, value } = await run(cwd, ['components/NoteList.vue']);
  assert.equal(code, 2);
  assert.match(value.coverage.reasons.join(' '), /No screenshot checkpoint covers \/notes/);
});

test('explicit selections are labelled manual and do not claim affected-screen coverage', async () => {
  const { cwd } = await workspace();
  const { code, value } = await run(cwd, ['components/NoteList.vue'], ['--journey', 'dashboard']);
  assert.equal(code, 0);
  assert.equal(value.coverage.status, 'manual');
  assert.deepEqual(value.journeys.map((item: {name: string}) => item.name), ['dashboard']);
});

test('automatic capture budgets report the full affected set instead of truncating it', async () => {
  const { cwd, config } = await workspace();
  await put(cwd, 'pagebeam.config.json', JSON.stringify({ ...config, capture: { ...config.capture, impact: { maxJourneys: 1 } } }));
  const { code, value } = await run(cwd, ['components/Nav.vue']);
  assert.equal(code, 2);
  assert.equal(value.coverage.routes.length, 2);
  assert.match(value.coverage.reasons.join(' '), /exceeding the automatic budget/);
});

test('both revisions contribute dependencies, including renamed and deleted pages', async () => {
  const { cwd } = await workspace();
  await put(cwd, 'pages/notes.vue', '<template>Notes without the old component</template>');
  await exec('git', ['mv', 'pages/wallets.vue', 'pages/archive.vue'], { cwd });
  await exec('git', ['add', '.'], { cwd });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Change fixture routes'], { cwd });
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--base', 'HEAD~1', '--plan'])
    .catch(error => error as { stdout: string });
  const plan = JSON.parse(stdout);
  assert.equal(plan.coverage.status, 'incomplete');
  assert.ok(plan.coverage.routes.some((item: {route: string; presence: string}) => item.route === '/wallets' && item.presence === 'removed'));
  assert.ok(plan.coverage.routes.some((item: {route: string; presence: string}) => item.route === '/archive' && item.presence === 'added'));
  const old = await run(cwd, ['components/NoteList.vue'], ['--base', 'HEAD~1']);
  assert.ok(old.value.coverage.routes.some((item: {route: string}) => item.route === '/notes'));
});

test('unsupported routing can declare language-neutral route dependencies', async () => {
  const { cwd, config } = await workspace();
  await put(cwd, 'templates/report.html', '<h1>Report</h1>');
  await put(cwd, 'pagebeam.config.json', JSON.stringify({ ...config, capture: { ...config.capture, impact: { routes: { '/notes': ['templates/**'] } } } }));
  const { code, value } = await run(cwd, ['templates/report.html']);
  assert.equal(code, 0);
  assert.equal(value.coverage.routes[0].route, '/notes');
});

test('browser capture excludes unrelated checkpoints and rejects the wrong screen', async () => {
  const app = await notesApp();
  const { cwd, config } = await workspace();
  try {
    const settings = {
      ...config,
      capture: { environments: { local: { backend: { kind: 'url', url: app.url, revision: 'notes-v1' }, timeoutMs: 5000 } } },
      tours: {
        ...config.tours, targets: { local: { url: app.url } },
        accounts: { reader: { purpose: 'notes reader', login: { usernameEnv: 'NOTES_USER', passwordEnv: 'NOTES_PASSWORD', form: { url: '/login', username: '#username', password: '#password', submit: '#submit' } }, confirm: '#signout' } },
        journeys: { notes: { account: 'reader', steps: [
          { goto: '/notes' }, { expect: { selector: 'li.note', text: 'First note' } },
          { shot: { name: 'notes', route: '/notes' } }, { shot: { name: 'unrelated', route: '/wallets' } },
        ] } },
      },
    };
    await put(cwd, 'pagebeam.config.json', JSON.stringify(settings));
    await put(cwd, 'changed.json', JSON.stringify(['components/NoteList.vue']));
    const args = [cli, 'capture', '--cwd', cwd, '--changed-files', 'changed.json', '--json'];
    const env = { ...process.env, NOTES_USER: 'ada', NOTES_PASSWORD: 'pw-ada' };
    const { stdout } = await exec(process.execPath, args, { env });
    const result = JSON.parse(stdout);
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.results[0].steps[2].route, '/notes');
    assert.equal(result.report.results[0].steps[3].skipped, 'unaffected screen');
    assert.equal(result.outcome.captures.length, 1);
    await access(path.join(result.directory, result.outcome.captures[0].head.split('/').slice(1).join('/')));
    settings.tours.journeys.notes.steps[0] = { goto: '/login' };
    settings.tours.journeys.notes.steps.splice(1, 1);
    await put(cwd, 'pagebeam.config.json', JSON.stringify(settings));
    const failed = await exec(process.execPath, args, { env }).then(() => { throw new Error('wrong screen must fail'); }, error => error as { code: number; stdout: string });
    assert.equal(failed.code, 1);
    const failure = JSON.parse(failed.stdout);
    assert.match(failure.report.results[0].error, /expected route \/notes, reached \/login/);
    assert.deepEqual(failure.outcome.captures, []);
  } finally { await app.stop(); }
});

async function action(cwd: string, changed: string[], plan: boolean) {
  const actionRoot = path.resolve(import.meta.dirname, '../../..');
  const definition = parse(await readFile(path.join(actionRoot, 'action.yml'), 'utf8'));
  const step = definition.runs.steps.find((step: {id?: string}) => step.id === 'run');
  const temporary = await mkdtemp(path.join(fixtures, 'action-'));
  const output = path.join(temporary, 'output');
  const summary = path.join(temporary, 'summary');
  await put(cwd, 'changed.json', JSON.stringify(changed));
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.keys(step.env).map(key => [key, ''])),
    PAGEBEAM_COMMAND: 'capture', PAGEBEAM_CWD: cwd,
    GITHUB_ACTION_PATH: actionRoot, GITHUB_WORKSPACE: cwd, RUNNER_TEMP: temporary,
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
    CAPTURE_PLAN: String(plan), CAPTURE_CONFIG: '', CAPTURE_CHANGED_FILES: 'changed.json',
    CAPTURE_ENVIRONMENT: 'local', CAPTURE_TARGET: 'local', CAPTURE_MODE: 'saved', CAPTURE_PURPOSE: 'both', CAPTURE_VIEWPORTS: 'desktop',
    CAPTURE_PREPARE: `${process.execPath} -e "require('node:fs').writeFileSync('prepared.txt','prepared')"`,
    CAPTURE_INSTALL: 'exit 99', CAPTURE_BASELINE_INSTALL: 'exit 99',
  };
  const script = path.join(temporary, 'run.sh');
  await writeFile(script, step.run);
  const result = await exec('bash', [script], { env, cwd: temporary }).then(result => ({ ...result, code: 0 }), error => error as {code: number; stdout: string; stderr: string});
  await access(path.join(cwd, 'prepared.txt'));
  return { ...result, outputs: await readFile(output, 'utf8') };
}

test('action planning exposes coverage and skips installation even for selected UI journeys', async () => {
  const { cwd } = await workspace();
  const result = await action(cwd, ['components/NoteList.vue'], true);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.outputs, /coverage=complete/);
  assert.match(result.outputs, /capture-needed=true/);
  assert.ok(!result.outputs.includes('directory='));
});

test('action automatic preflight skips installation and services for non-UI and uncovered changes', async () => {
  const { cwd } = await workspace();
  const skipped = await action(cwd, ['.github/workflows/capture.yml'], false);
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.match(skipped.outputs, /coverage=no-ui/);
  assert.match(skipped.outputs, /capture-needed=false/);
  const incomplete = await action(cwd, ['components/Unknown.vue'], false);
  assert.equal(incomplete.code, 2, incomplete.stderr);
  assert.match(incomplete.outputs, /coverage=incomplete/);
  assert.match(incomplete.outputs, /capture-needed=false/);
});


test('git diffs select the right screen from a nested application checkout', async () => {
  const { cwd, config } = await workspace();
  await exec('git', ['mv', 'components', 'app-components'], { cwd });
  await mkdir(path.join(cwd, 'product'));
  await exec('git', ['mv', 'app-components', 'product/components'], { cwd });
  await exec('git', ['mv', 'pages', 'product/pages'], { cwd });
  await put(cwd, 'product/pagebeam.config.json', JSON.stringify(config));
  await exec('git', ['add', '.'], { cwd });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Nest application'], { cwd });
  await put(cwd, 'product/components/NoteList.vue', '<template>Updated notes</template>');
  await exec('git', ['add', '.'], { cwd });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Update nested component'], { cwd });
  const { stdout } = await exec(process.execPath, [cli, 'capture', '--cwd', path.join(cwd, 'product'), '--base', 'HEAD~1', '--plan']);
  const plan = JSON.parse(stdout);
  assert.equal(plan.coverage.status, 'complete');
  assert.deepEqual(plan.coverage.routes.map((route: {route: string}) => route.route), ['/notes']);
});


test('impact roots cannot escape the capture checkout', async () => {
  const { cwd, config } = await workspace();
  await put(cwd, 'pagebeam.config.json', JSON.stringify({ ...config, capture: { ...config.capture, impact: { root: '..' } } }));
  await put(cwd, 'changed.json', JSON.stringify(['components/NoteList.vue']));
  const result = await exec(process.execPath, [cli, 'capture', '--cwd', cwd, '--changed-files', 'changed.json', '--plan'])
    .then(() => { throw new Error('the parent directory must be rejected'); }, error => error as {code: number; stderr: string});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /impact root must be inside the capture checkout/);
});


test('planning infers checkpoint routes from saved navigation without route annotations', async () => {
  const { cwd, config } = await workspace();
  for (const journey of Object.values(config.tours.journeys)) for (const step of journey.steps) if ('shot' in step) delete (step.shot as {route?: string}).route;
  await put(cwd, 'pagebeam.config.json', JSON.stringify(config));
  const {code, value} = await run(cwd, ['components/NoteList.vue']);
  assert.equal(code, 0);
  assert.equal(value.coverage.status, 'complete');
  assert.deepEqual(value.coverage.routes.map((route: {route: string}) => route.route), ['/notes']);
});

test('plan-only actions retain native no-UI outcomes for the reusable reporter', async () => {
  const { cwd } = await workspace();
  const result = await action(cwd, ['.github/workflows/capture.yml'], true);
  assert.equal(result.code, 0, result.stderr);
  const manifest = /^manifest=(.+)$/m.exec(result.outputs)?.[1];
  assert.ok(manifest);
  const outcome = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(outcome.coverage.status, 'no-ui');
  assert.deepEqual(outcome.captures, []);
});


test('plan-only actions retain incomplete outcomes without running application installation', async () => {
  const { cwd } = await workspace();
  const result = await action(cwd, ['components/Unknown.vue'], true);
  assert.equal(result.code, 2, result.stderr);
  const manifest = /^manifest=(.+)$/m.exec(result.outputs)?.[1];
  assert.ok(manifest);
  const outcome = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(outcome.coverage.status, 'incomplete');
  assert.deepEqual(outcome.captures, []);
});
