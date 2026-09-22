import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subjectFor } from '../dist/subject.js';

test('a subject is written under a type, as the convention asks', () => {
  assert.equal(
    subjectFor('utils gained 9 control(s) that nothing documents'),
    'docs: utils gained 9 control(s) that nothing documents',
  );
});

test('a description begins in lower case and carries no full stop', () => {
  assert.equal(subjectFor('Correct the guide.'), 'docs: correct the guide');
});

test('a control keeps the case somebody will look for it in', () => {
  assert.equal(
    subjectFor('"Add transaction" is now called "Record transaction"'),
    'docs: "Add transaction" is now called "Record transaction"',
  );
  assert.equal(
    subjectFor('GITHUB_TOKEN is documented but defined nowhere in the app'),
    'docs: GITHUB_TOKEN is documented but defined nowhere in the app',
  );
});

test('a repository with its own convention says so', () => {
  assert.equal(subjectFor('fix the guide', { prefix: 'chore(docs)' }), 'chore(docs): fix the guide');
  assert.equal(subjectFor('fix the guide', { prefix: '' }), 'fix the guide');
});

test('a header stays within what a linter allows', () => {
  const long = subjectFor(`describes ${'a very long control name '.repeat(8)}`);
  assert.ok(long.length <= 100, `header was ${long.length}`);
  assert.ok(long.endsWith('…'), 'and says it was cut');
  assert.ok(long.startsWith('docs: describes'), 'and still reads');
});

test('a header that already fits is left whole', () => {
  const said = subjectFor('/screenshots/gone.png does not resolve');
  assert.ok(!said.endsWith('…'));
});
