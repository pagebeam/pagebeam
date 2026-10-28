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


test('explicit Vue Router paths replace view filenames and trace scoped aliases', async () => {
  const head = [
    source('apps/editor/package.json', '{"name":"editor"}'),
    source('apps/editor/tsconfig.app.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}'),
    source('apps/editor/src/router.ts', `import {createRouter} from 'vue-router'; import Shell from './Shell.vue'; const routes = [{path:'/documents',component:Shell,children:[{path:':id/edit',component:()=>import('@/views/Editor.vue')}]},{path:'/library',component:()=>import('@/views/Library.vue')}]; export default createRouter({routes});`),
    source('apps/editor/src/Shell.vue', '<template><router-view/></template>'),
    source('apps/editor/src/views/Editor.vue', `<script setup>import Toolbar from '@/components/Toolbar.vue'</script><template><Toolbar/></template>`),
    source('apps/editor/src/views/Library.vue', '<template>Library</template>'),
    source('apps/editor/src/components/Toolbar.vue', '<template>Toolbar</template>'),
  ];
  const result = await staticImpactAnalyzer.analyze({head, changed:['apps/editor/src/components/Toolbar.vue']});
  assert.deepEqual(result.routes.map(route => route.route), ['/documents/:id/edit']);
  assert.deepEqual(result.reasons, []);
  const router = await staticImpactAnalyzer.analyze({head, changed:['apps/editor/src/router.ts']});
  assert.deepEqual(router.routes.map(route => route.route), ['/documents', '/documents/:id/edit', '/library']);
});

test('Nuxt applications resolve their own aliases, composables and layouts', async () => {
  const head = ['alpha', 'beta'].flatMap(app => [
    source(`apps/${app}/package.json`, JSON.stringify({name:app})),
    source(`apps/${app}/nuxt.config.ts`, 'export default defineNuxtConfig({})'),
    source(`apps/${app}/app/pages/${app}.vue`, `<script setup>import Card from '~/components/Card.vue'; useAuth()</script><template><Card/></template>`),
    source(`apps/${app}/app/components/Card.vue`, '<template>Card</template>'),
    source(`apps/${app}/app/composables/useAuth.ts`, 'export const useAuth = () => ({})'),
    source(`apps/${app}/app/layouts/default.vue`, '<template>Layout</template>'),
  ]);
  for (const file of ['components/Card.vue','composables/useAuth.ts','layouts/default.vue']) {
    const result = await staticImpactAnalyzer.analyze({head, changed:[`apps/alpha/app/${file}`]});
    assert.deepEqual(result.routes.map(route => route.route), ['/alpha']);
    assert.deepEqual(result.reasons, []);
  }
});

test('workspace source exports connect shared components to explicit routes', async () => {
  const head = [
    source('packages/ui/package.json', '{"name":"@sample/ui","exports":{".":{"source":"./src/index.ts","default":"./dist/index.js"}}}'),
    source('packages/ui/src/index.ts', `export {default as Toolbar} from './Toolbar.vue'`),
    source('packages/ui/src/Toolbar.vue', '<template>Toolbar</template>'),
    source('apps/editor/package.json', '{"name":"editor"}'),
    source('apps/editor/src/router.ts', `import {createRouter} from 'vue-router'; import Editor from './Editor.vue'; export default createRouter({routes:[{path:'/edit',component:Editor}]})`),
    source('apps/editor/src/Editor.vue', `<script setup>import {Toolbar} from '@sample/ui'</script><template><Toolbar/></template>`),
  ];
  const result = await staticImpactAnalyzer.analyze({head,changed:['packages/ui/src/Toolbar.vue']});
  assert.deepEqual(result.routes.map(route => route.route), ['/edit']);
  assert.deepEqual(result.reasons, []);
});

test('computed Vue Router paths remain incomplete instead of becoming filename routes', async () => {
  const result = await staticImpactAnalyzer.analyze({head:[
    source('src/router.ts', `import {createRouter} from 'vue-router'; import Editor from './views/Editor.vue'; export default createRouter({routes:[{path:location.pathname,component:Editor}]})`),
    source('src/views/Editor.vue','<template>Editor</template>'),
  ],changed:['src/views/Editor.vue']});
  assert.deepEqual(result.routes, []);
  assert.match(result.reasons.join(' '), /computed path/);
});


test('named exports exclude unused dynamic components without losing their own dependencies', async () => {
  const head = [
    source('pages/notes.vue', `<script setup>import {Toolbar} from '../components/index'</script><template><Toolbar/></template>`),
    source('components/index.ts', `import Toolbar from './Toolbar.vue'; import Dynamic from './Dynamic.vue'; export {Toolbar,Dynamic}; export default {install(app){app.component('Dynamic',Dynamic)}}`),
    source('components/Toolbar.vue','<template>Toolbar</template>'),
    source('components/Dynamic.vue',`<template><component :is="chosen"/></template>`),
  ];
  const toolbar = await staticImpactAnalyzer.analyze({head,changed:['components/Toolbar.vue']});
  assert.deepEqual(toolbar.routes.map(route => route.route),['/notes']);
  assert.deepEqual(toolbar.reasons,[]);
  const unused = await staticImpactAnalyzer.analyze({head,changed:['components/Dynamic.vue']});
  assert.deepEqual(unused.routes,[]);
  assert.deepEqual(unused.unknown,['components/Dynamic.vue']);
});

test('runtime uncertainty in another application does not block a known affected route', async () => {
  const head = [
    source('apps/alpha/package.json','{"name":"alpha"}'),
    source('apps/alpha/pages/notes.vue','<template>Notes</template>'),
    source('apps/beta/package.json','{"name":"beta"}'),
    source('apps/beta/pages/unknown.vue','<template><component :is="chosen"/></template>'),
  ];
  const result = await staticImpactAnalyzer.analyze({head,changed:['apps/alpha/pages/notes.vue']});
  assert.deepEqual(result.routes.map(route => route.route),['/notes']);
  assert.deepEqual(result.reasons,[]);
});

test('missing workspace runtime exports cannot pass as opaque external dependencies', async () => {
  const result = await staticImpactAnalyzer.analyze({head:[
    source('packages/ui/package.json','{"name":"@sample/ui","exports":{".":"./missing.js","./types":"./types.ts"}}'),
    source('packages/ui/types.ts','export interface Card {}'),
    source('pages/notes.vue',`<script setup>import {Card} from '@sample/ui'</script><template><Card/></template>`),
  ],changed:['pages/notes.vue']});
  assert.match(result.reasons.join(' '),/Cannot resolve @sample\/ui/);
});


test('component markup retains normal dialog content beyond long scripts', async () => {
  const {componentMarkup} = await import('../dist/markup.js');
  const padding = 'void "padding";'.repeat(1600);
  const dialog = '<dialog><h2>Share document</h2><button>Copy link</button><select><option>Reader</option></select></dialog>';
  const vue = `<script setup>${padding}</script><template>${dialog}</template><style>dialog{color:red}</style>`;
  assert.equal(componentMarkup('Panel.vue', vue), dialog);
  const jsx = `${padding}export const Panel = () => (${dialog});${padding}`;
  assert.equal(componentMarkup('Panel.tsx', jsx), dialog);
  assert.equal(componentMarkup('page.html', `<script>${padding}</script>${dialog}<style>dialog{color:red}</style>`), dialog);
});
