import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const here = import.meta.dirname;
const fixture = async (name: string): Promise<any> => JSON.parse(await readFile(`${here}/fixtures/github/${name}.json`, 'utf8'));
const workflow = parse(await readFile(`${here}/../../../.github/workflows/report-capture.yml`, 'utf8'));
const script = workflow.jobs.report.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
const execute = new AsyncFunction('github', 'context', 'process', 'core', script);

async function scenario() {
  const [artifact, run, pull, comments] = await Promise.all(['artifact', 'run', 'pull', 'comments'].map(fixture));
  const writes: { method: string; args: any }[] = [];
  const github = {
    rest: {
      actions: { getArtifact: async () => ({ data: artifact }), getWorkflowRun: async () => ({ data: run }) },
      pulls: { get: async () => ({ data: pull }) },
      issues: {
        listComments: Symbol('listComments'),
        updateComment: async (args: any) => writes.push({ method: 'update', args }),
        createComment: async (args: any) => writes.push({ method: 'create', args }),
      },
    },
    paginate: async () => comments,
  };
  const context = { repo: { owner: pull.base.repo.owner.login, repo: pull.base.repo.name }, serverUrl: new URL(run.html_url).origin };
  const env = { CAPTURE_ARTIFACT_ID: String(artifact.id), CAPTURE_RUN_ID: String(run.id), CAPTURE_PR: String(pull.number), CAPTURE_SHA: artifact.workflow_run.head_sha, CAPTURE_STATUS: 'failure' };
  return { artifact, run, pull, comments, writes, env, async report() { await execute(github, context, { env }, { notice() {} }); } };
}

test('the reusable reporter updates the real gallery comment without executing PR code', async () => {
  const current = await scenario();
  current.pull.head.sha = current.env.CAPTURE_SHA;
  await current.report();
  assert.equal(current.writes.length, 1);
  assert.equal(current.writes[0]!.method, 'update');
  assert.equal(current.writes[0]!.args.comment_id, current.comments[0].id);
  assert.ok(current.writes[0]!.args.body.includes(`/artifacts/${current.artifact.id}`));
  assert.ok(current.writes[0]!.args.body.includes('**failure**'));
  assert.ok(!workflow.jobs.report.steps.some((step: any) => step.run || step.uses?.startsWith('actions/checkout')));
});

test('a newer PR revision keeps its existing gallery report', async () => {
  const current = await scenario();
  current.pull.head.sha = 'a'.repeat(40);
  await current.report();
  assert.equal(current.writes.length, 0);
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
