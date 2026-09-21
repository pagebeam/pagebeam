import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates, compare, normalise, type StringIndex } from '../src/strings.ts';
import type { DocPage } from '@pagebeam/docs';

function doc(value: string, before = 'Click the ', after = ' button.'): DocPage {
  return {
    path: 'guide.md',
    format: 'markdown',
    raw: '',
    prose: '',
    links: [],
    codeSpans: [],
    codeBlocks: [],
    emphasised: [{ value, line: 7, marker: 'strong', before, after }],
    directives: [],
  };
}

function app(...sources: string[]): StringIndex {
  return { app: 'dashboard', haystack: sources.map(normalise), files: sources.length };
}

test('a renamed control is reported', () => {
  const f = compare(candidates([doc('Create a report')]), [app('<button>Compose a report</button>')], 0.4);
  assert.equal(f.length, 1);
  assert.match(f[0]!.title, /Create a report/);
  assert.equal(f[0]!.doc.line, 7);
});

test('a control that still exists is silent', () => {
  const f = compare(candidates([doc('Create a report')]), [app('<button>Create a report</button>')], 0.4);
  assert.deepEqual(f, []);
});

test('an escaped ampersand in the source still matches', () => {
  const f = compare(candidates([doc('Connect & continue')]), [app('<span>Connect &amp; continue</span>')], 0.4);
  assert.deepEqual(f, []);
});

test('a label assembled from interpolation still matches', () => {
  const source = "{{ n }} {{ n === 1 ? 'connection' : 'connections' }} to look at";
  const f = compare(candidates([doc('N connections to look at')]), [app(source)], 0.4);
  assert.deepEqual(f, []);
});

test('a navigation path matches when each part exists', () => {
  const f = compare(candidates([doc('Model → Keys')]), [app('<a>Model</a>', '<a>Keys</a>')], 0.4);
  assert.deepEqual(f, []);
});

test('a leading icon glyph is not part of the label', () => {
  const f = compare(candidates([doc('+ Add')]), [app('<button>Add</button>')], 0.4);
  assert.deepEqual(f, []);
});

test('prose describing a control is not a candidate', () => {
  assert.deepEqual(candidates([doc('share-shaped icon')]), []);
});

test('emphasis with no control context is not a candidate', () => {
  assert.deepEqual(candidates([doc('worth understanding', 'This is ', ' because it matters.')]), []);
});

test('a control named by the noun after it is a candidate', () => {
  assert.equal(candidates([doc('Save', 'Then the ', ' button commits.')]).length, 1);
});
