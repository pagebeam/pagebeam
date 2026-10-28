import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { parse } from 'yaml';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
const fixture = async (name: string): Promise<any> => JSON.parse(await readFile(`${here}/fixtures/github/${name}.json`, 'utf8'));
const workflow = parse(await readFile(`${here}/../../../.github/workflows/report-capture.yml`, 'utf8'));
const scripts = workflow.jobs.report.steps.filter((step: any) => step.with?.script).map((step: any) => step.with.script);
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
const validate = new AsyncFunction('github', 'context', 'process', 'core', scripts[0]);
const publish = new AsyncFunction('github', 'context', 'process', 'core', 'require', scripts[1]);

async function scenario() {
  const [artifact, run, pull, comments, release, asset] = await Promise.all(['artifact', 'run', 'pull', 'comments', 'release', 'release-asset'].map(fixture));
  const directory = await mkdtemp(path.join(tmpdir(), 'pagebeam-report-'));
  await cp(`${here}/fixtures/github/screenshot.png`, path.join(directory, 'screenshot.png'));
  const outcome = { schemaVersion: 1, kind: 'capture', status: 'passed', head: { revision: artifact.workflow_run.head_sha }, compatible: true, captures: [{journey: 'dashboard', viewport: 'desktop', step: 1, base: 'screenshot', head: 'screenshot'}], evidence: [{id: 'screenshot', file: 'screenshot.png', mediaType: 'image/png'}] };
  const writes: { method: string; args: any }[] = [];
  const uploads: any[] = [];
  const github = {
    rest: {
      actions: { getArtifact: async () => ({ data: artifact }), getWorkflowRun: async () => ({ data: run }) },
      pulls: { get: async () => ({ data: pull }) },
      repos: {
        getReleaseByTag: async () => ({data: release}),
        listReleaseAssets: Symbol('listReleaseAssets'),
        uploadReleaseAsset: async (args: any) => { uploads.push(args); return {data: asset}; },
      },
      issues: {
        listComments: Symbol('listComments'),
        updateComment: async (args: any) => writes.push({ method: 'update', args }),
        createComment: async (args: any) => writes.push({ method: 'create', args }),
      },
    },
    paginate: async (method: symbol) => method === github.rest.repos.listReleaseAssets ? [asset] : comments,
  };
  const context = { repo: { owner: pull.base.repo.owner.login, repo: pull.base.repo.name }, serverUrl: new URL(run.html_url).origin };
  const env = { CAPTURE_ARTIFACT_ID: String(artifact.id), CAPTURE_RUN_ID: String(run.id), CAPTURE_PR: String(pull.number), CAPTURE_SHA: artifact.workflow_run.head_sha, CAPTURE_STATUS: 'failure', CAPTURE_DIRECTORY: directory, CAPTURE_STORAGE_RELEASE: 'pagebeam-captures' };
  pull.head.sha = env.CAPTURE_SHA;
  return { artifact, run, pull, comments, release, asset, writes, uploads, outcome, env, async report() {
    let current = false;
    await validate(github, context, {env}, {notice() {}, setOutput(name: string, value: string) { if (name === 'current') current = value === 'true'; }});
    if (!current) return;
    await writeFile(path.join(directory, 'outcome.json'), JSON.stringify(outcome));
    await publish(github, context, {env}, {}, require);
  } };
}

test('the reusable reporter embeds image pairs and reuses matching release assets', async () => {
  const current = await scenario();
  await current.report();
  assert.equal(current.writes.length, 1);
  assert.equal(current.writes[0]!.method, 'update');
  assert.equal(current.writes[0]!.args.comment_id, current.comments[0].id);
  assert.ok(current.writes[0]!.args.body.includes('| Screen | Before | After |'));
  assert.ok(current.writes[0]!.args.body.includes(current.asset.browser_download_url));
  assert.ok(!current.writes[0]!.args.body.includes('Download the gallery'));
  assert.ok(current.writes[0]!.args.body.includes('**failure**'));
  assert.equal(current.uploads.length, 0);
  assert.ok(!workflow.jobs.report.steps.some((step: any) => step.run || step.uses?.startsWith('actions/checkout')));
});

test('a newer PR revision keeps its existing screenshot report', async () => {
  const current = await scenario();
  current.pull.head.sha = 'a'.repeat(40);
  await current.report();
  assert.equal(current.writes.length, 0);
  assert.equal(current.uploads.length, 0);
});

test('the reporter rejects artifacts from another run and PR', async () => {
  const wrongRun = await scenario();
  wrongRun.artifact.workflow_run.id += 1;
  await assert.rejects(wrongRun.report(), /does not match/);
  assert.equal(wrongRun.writes.length, 0);
  const wrongPull = await scenario();
  wrongPull.run.pull_requests = [];
  await assert.rejects(wrongPull.report(), /does not belong/);
  assert.equal(wrongPull.writes.length, 0);
});

test('expired artifacts and unsafe statuses never reach a comment', async () => {
  const expired = await scenario();
  expired.artifact.expired = true;
  await assert.rejects(expired.report(), /does not match/);
  const malformed = await scenario();
  malformed.env.CAPTURE_STATUS = '<script>';
  await assert.rejects(malformed.report(), /Invalid capture status/);
  assert.equal(expired.writes.length + malformed.writes.length, 0);
});

test('the publisher rejects escaping paths and unrelated releases before publishing', async () => {
  const escaped = await scenario();
  escaped.outcome.evidence[0]!.file = '../outside.png';
  await assert.rejects(escaped.report(), /Unsafe evidence path/);
  assert.equal(escaped.writes.length + escaped.uploads.length, 0);
  const unrelated = await scenario();
  unrelated.release.name = 'Product release';
  await assert.rejects(unrelated.report(), /belongs to another release/);
  assert.equal(unrelated.writes.length + unrelated.uploads.length, 0);
});


test('the reporter displays missing coverage without publishing substitute images', async () => {
  const current = await scenario();
  Object.assign(current.outcome, {
    status: 'incomplete', compatible: null, captures: [], evidence: [],
    coverage: { status: 'incomplete', routes: [{route: '/wallets', files: ['components/Wallet.vue']}], reasons: ['No screenshot checkpoint covers /wallets.'] },
  });
  await current.report();
  assert.equal(current.uploads.length, 0);
  const body = current.writes[0]!.args.body;
  assert.match(body, /UI coverage: \*\*incomplete\*\*/);
  assert.match(body, /No screenshot checkpoint covers \/wallets/);
  assert.ok(!body.includes('| Screen | Before | After |'));
});


test('the reusable reporter publishes native difference images in the same review table',async()=>{
  const current=await scenario();
  Object.assign(current.outcome.captures[0]!,{diff:'screenshot'});
  await current.report();
  assert.equal(current.writes.length,1);
  assert.ok(current.writes[0]!.args.body.includes('| Screen | Before | After | Difference |'));
  assert.ok(current.writes[0]!.args.body.includes('![Difference]'));
});


test('capture action uploads the manifest directory for nested automatic review runs',async()=>{
  const action=parse(await readFile(`${here}/../../../action.yml`,'utf8'));
  const run=action.runs.steps.find((step:any)=>step.id==='run').run as string;
  const scripts=[...run.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/g)].map(match=>match[1]!);
  const script=scripts.find(script=>script.includes('const artifactRoot'))!;
  assert.ok(script);
  const directory=await mkdtemp(path.join(tmpdir(),'pagebeam-action-review-'));
  const review=path.join(directory,'pagebeam-captures','review-run');
  await mkdir(review,{recursive:true});
  const manifest=path.join(review,'outcome.json');
  const output=path.join(directory,'outputs');
  await writeFile(path.join(directory,'said.txt'),JSON.stringify({manifest,directory:path.join(review,'head-run'),report:{id:'head-run'}}));
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,RUNNER_TEMP:directory,GITHUB_OUTPUT:output}});
  const result=await readFile(output,'utf8');
  assert.ok(result.includes(`directory=${review}\n`));
  assert.ok(result.includes(`manifest=${manifest}\n`));
  await writeFile(path.join(directory,'said.txt'),JSON.stringify({manifest:path.join(directory,'outside','outcome.json'),report:{id:'head-run'}}));
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,RUNNER_TEMP:directory,GITHUB_OUTPUT:output}}),/outside the artifact directory/);
});
