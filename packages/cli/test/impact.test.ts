import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, unlink } from 'node:fs/promises';
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


test('automatic discovery creates capture journeys without saved screen lists', async () => {
  const {cwd, config} = await workspace();
  await put(cwd, 'pagebeam.config.json', JSON.stringify({...config, tours:{...config.tours, journeys:{}}, capture:{...config.capture, discovery:{}}}));
  const {code,value} = await run(cwd, ['components/NoteList.vue']);
  assert.equal(code,0);
  assert.equal(value.coverage.status,'complete');
  assert.equal(value.journeys.length,1);
  assert.deepEqual(value.generated[value.journeys[0].name].steps.map((step: any) => step.goto ?? step.shot?.route), ['/notes','/notes']);
});

test('automatic discovery reports missing dynamic parameters and ambiguous accounts', async () => {
  const {cwd,config} = await workspace();
  await put(cwd,'pages/document/[id].vue','<template>Document</template>');
  const settings = {...config,tours:{...config.tours,journeys:{}},capture:{...config.capture,discovery:{}}};
  await put(cwd,'pagebeam.config.json',JSON.stringify(settings));
  const missing = await run(cwd,['pages/document/[id].vue']);
  assert.equal(missing.code,2);
  assert.match(missing.value.coverage.reasons.join(' '),/concrete discovery parameters/);
  await put(cwd,'pagebeam.config.json',JSON.stringify({...settings,capture:{...settings.capture,discovery:{parameters:{id:'fixture/one'}}}}));
  const bound = await run(cwd,['pages/document/[id].vue']);
  assert.equal(bound.code,0);
  assert.equal(Object.values(bound.value.generated).map((journey: any) => journey.steps[0].goto)[0],'/document/fixture%2Fone');
  await put(cwd,'pagebeam.config.json',JSON.stringify({...settings,tours:{...settings.tours,accounts:{...settings.tours.accounts,other:settings.tours.accounts.reader}}}));
  const ambiguous = await run(cwd,['components/NoteList.vue']);
  assert.equal(ambiguous.code,2);
  assert.match(ambiguous.value.coverage.reasons.join(' '),/discovery account/);
});

test('ignored duplicate checkouts and deleted files do not pollute automatic discovery', async () => {
  const {cwd,config} = await workspace();
  await put(cwd,'.gitignore','.cache/\nignored-copy/\n');
  await unlink(path.join(cwd,'pages/wallets.vue'));
  await put(cwd,'.cache/base/pages/phantom.vue','<template>Phantom</template>');
  await put(cwd,'ignored-copy/pages/phantom.vue',`<script>import Missing from './absent.vue'</script>`);
  await put(cwd,'pagebeam.config.json',JSON.stringify({...config,capture:{...config.capture,discovery:{}}}));
  const {code,value} = await run(cwd,['components/NoteList.vue']);
  assert.equal(code,0);
  assert.deepEqual(value.coverage.routes.map((route: any) => route.route),['/notes']);
  assert.deepEqual(value.coverage.reasons,[]);
});

test('generated journeys capture authenticated screens and compare real before and after images', async () => {
  const app = await notesApp();
  const {cwd,config} = await workspace();
  try {
    await put(cwd,'pagebeam.config.json',JSON.stringify({
      ...config,
      tours:{...config.tours,targets:{local:{url:app.url}},journeys:{},accounts:{reader:{purpose:'notes reader',login:{usernameEnv:'NOTES_USER',passwordEnv:'NOTES_PASSWORD',form:{url:'/login',username:'#username',password:'#password',submit:'#submit'}},confirm:'#signout'}}},
      capture:{discovery:{ready:'li.note'},environments:{local:{backend:{kind:'url',url:app.url,revision:'notes-v1'},frontendRevision:'notes-ui-v1',fixtures:{version:'notes-fixture-v1'}},base:{backend:{kind:'url',url:app.url,revision:'notes-v1'},frontendRevision:'notes-ui-v1',fixtures:{version:'notes-fixture-v1'}}}},
    }));
    await put(cwd,'changed.json',JSON.stringify(['components/NoteList.vue']));
    const {stdout} = await exec(process.execPath,[cli,'capture','--cwd',cwd,'--changed-files','changed.json','--compare-environment','base','--compare-target','local','--json'],{env:{...process.env,NOTES_USER:'ada',NOTES_PASSWORD:'pw-ada'}});
    const value = JSON.parse(stdout);
    assert.equal(value.report.status,'passed');
    assert.equal(value.report.selection.coverage.status,'complete');
    assert.equal(value.comparison.report.compatible,true);
    assert.equal(value.outcome.captures.length,1);
    assert.equal(value.report.results[0].steps.at(-1).route,'/notes');
    assert.ok(value.outcome.captures[0].base);
    assert.ok(value.outcome.captures[0].head);
  } finally { await app.stop(); }
});


test('discovery opens expandable controls automatically and replays the same actions on the baseline', async () => {
  const app = await notesApp();
  const {cwd,config} = await workspace();
  try {
    await put(cwd,'pages/disclosure-notes.vue','<template><h1>Notes</h1><details><summary>Formatting</summary></details></template>');
    await put(cwd,'pagebeam.config.json',JSON.stringify({
      ...config,
      tours:{...config.tours,targets:{local:{url:app.url}},journeys:{},accounts:{reader:{purpose:'notes reader',login:{usernameEnv:'NOTES_USER',passwordEnv:'NOTES_PASSWORD',form:{url:'/login',username:'#username',password:'#password',submit:'#submit'}},confirm:'#signout'}}},
      capture:{discovery:{ready:'h1'},environments:Object.fromEntries(['local','base'].map(name => [name,{backend:{kind:'url',url:app.url,revision:'notes-v1'},frontendRevision:'notes-ui-v1',fixtures:{version:'notes-fixture-v1'},disposable:true}]))},
    }));
    await put(cwd,'changed.json',JSON.stringify(['pages/disclosure-notes.vue']));
    const {stdout} = await exec(process.execPath,[cli,'capture','--cwd',cwd,'--changed-files','changed.json','--compare-environment','base','--compare-target','local','--json'],{env:{...process.env,NOTES_USER:'ada',NOTES_PASSWORD:'pw-ada'}});
    const value = JSON.parse(stdout);
    assert.equal(value.report.status,'passed');
    assert.equal(value.comparison.report.compatible,true);
    assert.equal(value.outcome.captures.length,2);
    const artifact = path.dirname(value.manifest);
    assert.notDeepEqual(await readFile(path.join(artifact,value.outcome.captures[0].head)),await readFile(path.join(artifact,value.outcome.captures[1].head)));
    const generated: any = Object.values(value.report.selection.generated)[0];
    assert.ok(generated.steps.some((step: any) => step.click === '#formatting'));
    assert.deepEqual(value.report.results[0].steps.map((step: any) => step.action), ['goto','wait','shot','goto','wait','click','shot']);
    const before = JSON.parse(await readFile(path.join(value.comparison.directory,'report.json'),'utf8'));
    assert.deepEqual(before.results[0].steps.map((step: any) => step.action),value.report.results[0].steps.map((step: any) => step.action));
    const protectedSettings = JSON.parse(await readFile(path.join(cwd,'pagebeam.config.json'),'utf8'));
    for (const environment of Object.values(protectedSettings.capture.environments) as any[]) environment.disposable = false;
    await put(cwd,'pagebeam.config.json',JSON.stringify(protectedSettings));
    const initialOnly = await exec(process.execPath,[cli,'capture','--cwd',cwd,'--changed-files','changed.json','--compare-environment','base','--compare-target','local','--json'],{env:{...process.env,NOTES_USER:'ada',NOTES_PASSWORD:'pw-ada'}});
    const protectedResult = JSON.parse(initialOnly.stdout);
    assert.equal(protectedResult.outcome.captures.length,1);
    assert.ok(!protectedResult.report.results[0].steps.some((step: any) => step.action === 'click'));

  } finally { await app.stop(); }
});


test('automatic review preflight requests judgment without starting the app for uncovered states',async()=>{
  const {cwd,config}=await workspace();
  await put(cwd,'pagebeam.config.json',JSON.stringify({...config,model:{baseUrl:'https://example.test/v1',name:'unused',sendSource:true},tours:{...config.tours,journeys:{}},capture:{...config.capture,discovery:{}}}));
  const {code,value}=await run(cwd,['components/NoteList.vue'],['--mode','auto']);
  assert.equal(code,0);assert.equal(value.review.required,true);
  const quiet=await run(cwd,['.github/workflows/ci.yml'],['--mode','auto']);
  assert.equal(quiet.code,0);assert.equal(quiet.value.review.required,false);assert.equal(quiet.value.coverage.status,'no-ui');
});


test('automatic mode retains static discovery without a source-enabled model',async()=>{
  const {cwd,config}=await workspace();
  await put(cwd,'pagebeam.config.json',JSON.stringify({...config,tours:{...config.tours,journeys:{}},capture:{...config.capture,discovery:{}}}));
  const {code,value}=await run(cwd,['components/NoteList.vue'],['--mode','auto']);
  assert.equal(code,0);assert.equal(value.coverage.status,'complete');
  assert.equal(value.review,undefined);assert.equal(value.journeys.length,1);
  await put(cwd,'pagebeam.config.json',JSON.stringify({...config,model:{baseUrl:'https://example.test/v1',name:'unused',sendSource:false},tours:{...config.tours,journeys:{}},capture:{...config.capture,discovery:{}}}));
  const privateSource=await run(cwd,['components/NoteList.vue'],['--mode','auto']);
  assert.equal(privateSource.code,0);assert.equal(privateSource.value.review,undefined);assert.equal(privateSource.value.coverage.status,'complete');
});


test('explicit journeys retain manual coverage when automatic review is configured',async()=>{
  const {cwd,config}=await workspace();
  await put(cwd,'pagebeam.config.json',JSON.stringify({...config,model:{baseUrl:'https://example.test/v1',name:'unused'},capture:{...config.capture,discovery:{}}}));
  const {code,value}=await run(cwd,['components/NoteList.vue'],['--mode','auto','--journey','notes']);
  assert.equal(code,0);assert.equal(value.coverage.status,'manual');
  assert.equal(value.review,undefined);assert.deepEqual(value.journeys.map((journey:any)=>journey.name),['notes']);
});
