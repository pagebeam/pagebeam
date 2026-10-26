import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

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
