import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { writeOutcome } from '../dist/report.js';
import { markdownRenderer, htmlRenderer, type CaptureOutcome, type Outcome, type OutcomePublisher, type OutcomeRenderer } from '../dist/outcome.js';

const capture: CaptureOutcome = {
  schemaVersion: 1, kind: 'capture', status: 'passed',
  head: {id: 'after', revision: 'after', status: 'passed'}, base: {id: 'before', revision: 'before', status: 'passed'},
  compatible: true, reasons: [], unmapped: [],
  evidence: [{id: 'after.png', file: 'after.png', mediaType: 'image/png'}, {id: 'before.png', file: 'before.png', mediaType: 'image/png'}],
  captures: [{journey: 'dashboard', viewport: 'desktop', step: 1, head: 'after.png', base: 'before.png'}],
};

test('Markdown is independent of storage and HTML is an explicit additional renderer', async () => {
  const publication = {urls: {'before.png': 'https://images.example.test/before.png', 'after.png': 'https://images.example.test/after.png'}};
  const markdown = await markdownRenderer.render(capture, publication);
  assert.ok(markdown.includes('| Screen | Before | After |'));
  assert.ok(markdown.includes('![Before](<https://images.example.test/before.png>)'));
  assert.ok(markdown.includes('![After](<https://images.example.test/after.png>)'));
  const directory = await mkdtemp(path.join(tmpdir(), 'pagebeam-outcome-'));
  await writeOutcome(capture, {directory, renderers: [markdownRenderer]});
  assert.deepEqual((await readdir(directory)).sort(), ['outcome.json', 'report.md']);
  await writeOutcome(capture, {directory, renderers: [htmlRenderer]});
  assert.ok((await readFile(path.join(directory, 'index.html'), 'utf8')).includes('<th>Before</th>'));
});

test('custom outcomes, publishers and renderers share the same interface', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pagebeam-outcome-'));
  type AssertionOutcome = Outcome & { assertions: number };
  const outcome: AssertionOutcome = {schemaVersion: 1, kind: 'assertions', status: 'passed', assertions: 3, evidence: [{id: 'checks', file: 'checks.json', mediaType: 'application/json'}]};
  let published = false;
  const publisher: OutcomePublisher<AssertionOutcome> = {async publish(result, context) {
    assert.deepEqual(result, outcome);
    assert.equal(context.directory, directory);
    assert.equal(context.namespace, 'review');
    published = true;
    return {url: 'https://results.example.test/review', urls: {checks: 'https://results.example.test/checks.json'}};
  }};
  const renderer: OutcomeRenderer<AssertionOutcome> = {format: 'text', filename: 'result.txt', render(result, publication) {
    return `${result.kind}: ${result.status} (${result.assertions}). ${publication.urls.checks}`;
  }};
  const result = await writeOutcome(outcome, {directory, namespace: 'review', renderers: [renderer], publisher});
  assert.ok(published);
  assert.equal(result.publication.url, 'https://results.example.test/review');
  assert.equal(await readFile(result.outputs.text!, 'utf8'), 'assertions: passed (3). https://results.example.test/checks.json');
  assert.deepEqual(JSON.parse(await readFile(result.manifest, 'utf8')), outcome);
});

test('renderers reject credential URLs and escape untrusted table labels', async () => {
  await assert.rejects(async () => markdownRenderer.render(capture, {urls: {'before.png': 'https://token@images.example.test/a.png'}}), /without credentials/);
  const outcome = structuredClone(capture);
  outcome.captures[0]!.journey = '<script>|broken\nrow';
  const markdown = await markdownRenderer.render(outcome, {urls: {}});
  assert.ok(!markdown.includes('<script>'));
  assert.ok(markdown.includes('\\|broken row'));
  const directory = await mkdtemp(path.join(tmpdir(), 'pagebeam-outcome-'));
  await assert.rejects(writeOutcome(outcome, {directory, renderers: [{format: 'text', filename: '../outside', render: () => ''}]}), /inside the outcome directory/);
});


test('difference previews require an explicit opt-in in both report formats',async()=>{
  const outcome=structuredClone(capture);
  outcome.captures[0]!.diff='difference.png';
  for(const enabled of [undefined,false,true]){
    if(enabled!==undefined)outcome.diffImages=enabled;
    for(const renderer of [markdownRenderer,htmlRenderer]){
      const rendered=await renderer.render(outcome,{urls:{}});
      assert.equal(rendered.includes('Difference'),enabled===true);
    }
  }
});
