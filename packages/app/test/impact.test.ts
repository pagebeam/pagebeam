import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticImpactAnalyzer, routeMatches } from '../dist/impact.js';

const source = (path: string, text: string) => ({ path, text });
const pages = [source('pages/notes.vue', '<template>Notes</template>'), source('pages/wallets.vue', '<template>Wallets</template>')];

test('route matching treats literals as literals and recognizes concrete dynamic routes', () => {
  assert.equal(routeMatches('/notes/:id', '/notes/42'), true);
  assert.equal(routeMatches('/notes/:id', '/notes/42/edit'), false);
  assert.equal(routeMatches('/files/:path*', '/files/a/b'), true);
  assert.equal(routeMatches('/v1.0', '/v1x0'), false);
  assert.equal(routeMatches('/', '/'), true);
  assert.equal(routeMatches('/notes', '/notes/'), true);
});

test('a component imported by the root application affects every route', async () => {
  const result = await staticImpactAnalyzer.analyze({ head: [...pages, source('app.vue', `<script setup>import Nav from './components/Nav.vue'</script>`), source('components/Nav.vue', '<nav/>')], changed: ['components/Nav.vue'] });
  assert.deepEqual(result.routes.map(route => route.route), ['/notes', '/wallets']);
});

test('stylesheet imports narrow impact and global styles affect all routes', async () => {
  const head = [source('pages/notes.vue', `<style src="../styles/notes.css"/>`), pages[1]!, source('styles/notes.css', '.note{}'), source('assets/global.css', 'body{}')];
  const local = await staticImpactAnalyzer.analyze({ head, changed: ['styles/notes.css'] });
  assert.deepEqual(local.routes.map(route => route.route), ['/notes']);
  const global = await staticImpactAnalyzer.analyze({ head, changed: ['assets/global.css'] });
  assert.deepEqual(global.routes.map(route => route.route), ['/notes', '/wallets']);
});

test('ignore rules cannot hide a file already traced to a route', async () => {
  const result = await staticImpactAnalyzer.analyze({ head: pages, changed: ['pages/notes.vue'], ignore: ['**'] });
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.ignored, []);
});

test('dynamic dependencies, ambiguous components and unresolved imports are explicit', async () => {
  for (const head of [
    [source('pages/notes.vue', `<script>const component = import(name)</script>`)],
    [source('pages/notes.vue', `<template><component :is="selected"/></template>`)],
    [source('pages/notes.vue', `<script>import Missing from '../components/Missing.vue'</script>`)],
    [source('pages/notes.vue', `<template><Card/></template>`), source('components/a/Card.vue', '<template>A</template>'), source('components/b/Card.vue', '<template>B</template>')],
  ]) {
    const result = await staticImpactAnalyzer.analyze({ head, changed: ['pages/notes.vue'] });
    assert.ok(result.reasons.length, JSON.stringify(head));
  }
});

test('runtime route configuration cannot claim complete static coverage', async () => {
  const result = await staticImpactAnalyzer.analyze({ head: [...pages, source('nuxt.config.ts', `export default defineNuxtConfig({extends: ['remote-layer']})`)], changed: ['pages/notes.vue'] });
  assert.match(result.reasons.join(' '), /Runtime routes/);
});

test('an unresolved graph does not require browsers for an unrelated CI change', async () => {
  const result = await staticImpactAnalyzer.analyze({ head: [source('pages/notes.vue', `<script>const component = import(name)</script>`)], changed: ['.github/workflows/ci.yml'] });
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.routes, []);
  assert.deepEqual(result.ignored, ['.github/workflows/ci.yml']);
});


test('kebab-case component names and layout opt-outs retain the correct route set', async () => {
  const result = await staticImpactAnalyzer.analyze({
    head: [
      source('pages/notes.vue', `<script setup>definePageMeta({layout: false})</script><template><note-list/></template>`),
      source('pages/wallets.vue', '<template>Wallets</template>'),
      source('components/NoteList.vue', '<template>Notes</template>'),
      source('layouts/default.vue', '<template>Layout</template>'),
    ], changed: ['components/NoteList.vue', 'layouts/default.vue'],
  });
  assert.deepEqual(result.routes.map(route => [route.route, route.files]), [['/notes', ['components/NoteList.vue']], ['/wallets', ['layouts/default.vue']]]);
});
