import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsx } from '../dist/jsx.js';
import { vue } from '../dist/vue.js';

const labels = (template: string): { text: string; kind: string }[] =>
  vue.extract(`<template>${template}</template>`, 'a.vue').map((l) => ({ text: l.text, kind: l.kind }));

test('a component that stands in while a request is out offers nothing', () => {
  const found = labels('<UiLoadingState label="Fetching recent activity" /><button>Refresh</button>');
  assert.deepEqual(found.map((l) => l.text), ['Refresh']);
});

test('a component shown in place of an empty list offers nothing', () => {
  const found = labels('<UiEmpty title="No open pull requests" /><button>Open one</button>');
  assert.deepEqual(found.map((l) => l.text), ['Open one']);
});

test('a heading in a branch about failure is the message, not a landmark', () => {
  const found = labels('<div v-else-if="loadError"><h2>Could not load your systems</h2></div>');
  assert.deepEqual(found, []);
});

test('a heading in a branch about nothing being there is the same', () => {
  const found = labels('<div v-else-if="report && learned === 0"><h2>Nothing learned here yet</h2></div>');
  assert.deepEqual(found, []);
});

test('what a reader can act on inside that branch is still a control', () => {
  const found = labels('<div v-if="hasError"><h2>We could not read it</h2><button>Try again</button></div>');
  assert.deepEqual(found.map((l) => l.text), ['Try again']);
});

test('a branch that follows one about nothing is about nothing too', () => {
  const found = labels('<div v-if="items.length === 0"><h2>Nothing yet</h2></div><div v-else><h2>Also nothing</h2></div>');
  assert.deepEqual(found, []);
});

test('an ordinary heading is a landmark and is read', () => {
  const found = labels('<div v-if="ready"><h2>Your systems</h2></div>');
  assert.deepEqual(found.map((l) => l.text), ['Your systems']);
});

test('a heading outside any branch is read', () => {
  assert.deepEqual(labels('<h1>Dashboard</h1>').map((l) => l.text), ['Dashboard']);
});

// The same rules, in a language that writes its conditions as expressions
// rather than as directives.
const react = (source: string): { text: string; kind: string }[] =>
  jsx.extract(`export const P = () => (<div>${source}</div>);`, 'a.tsx')
    .map((l) => ({ text: l.text, kind: l.kind }));

test('a component standing in for a request is skipped in react too', () => {
  assert.deepEqual(
    react('<><LoadingState label="Fetching activity" /><button>Refresh</button></>').map((l) => l.text),
    ['Refresh'],
  );
});

test('a heading guarded on failure is the message in react too', () => {
  assert.deepEqual(react('{loadError && <h2>Could not load your systems</h2>}'), []);
});

test('a heading guarded on nothing being there is the same', () => {
  assert.deepEqual(react('{items.length === 0 && <h2>Nothing yet</h2>}'), []);
});

test('both sides of a question about emptiness are about it', () => {
  assert.deepEqual(react('{isEmpty ? <h2>Nothing yet</h2> : <h2>Also nothing</h2>}'), []);
});

test('what a reader can act on inside that branch is still a control', () => {
  assert.deepEqual(
    react('{hasError && <><h2>We could not read it</h2><button>Try again</button></>}').map((l) => l.text),
    ['Try again'],
  );
});

test('an ordinary condition leaves a heading alone', () => {
  assert.deepEqual(react('{ready && <h2>Your systems</h2>}').map((l) => l.text), ['Your systems']);
});
