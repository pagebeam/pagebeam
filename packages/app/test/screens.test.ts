import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressOf, isRoute, screensOf } from '../dist/screens.js';

const of = (files: Record<string, string>) =>
  screensOf(Object.entries(files).map(([path, text]) => ({ path, text })));

test('a screen is somewhere a reader can go', () => {
  assert.ok(isRoute('pages/dashboard/systems.vue'));
  assert.ok(isRoute('src/routes/billing.tsx'));
  assert.ok(!isRoute('components/Button.vue'), 'a component is not a place');
  assert.ok(!isRoute('utils/format.ts'));
});

test('an address is what a reader arrives at, not where a file sits', () => {
  assert.equal(addressOf('pages/dashboard/systems.vue'), '/dashboard/systems');
  assert.equal(addressOf('pages/index.vue'), '/');
  assert.equal(addressOf('pages/repos/[id].vue'), '/repos/:id');
});

test('what a route imports is part of that screen', () => {
  const { reaches } = of({
    'pages/billing.vue': "<script>import Card from '../components/Card.vue'</script>",
    'components/Card.vue': '<template><button>Pay</button></template>',
  });
  assert.deepEqual([...(reaches.get('/billing') ?? [])].sort(), ['components/Card.vue', 'pages/billing.vue']);
});

// A framework that resolves a component by its name is the common case.
test('what it uses by name is part of it too, with no import anywhere', () => {
  const { reaches } = of({
    'pages/billing.vue': '<template><PayNow /></template>',
    'components/PayNow.vue': '<template><button>Pay</button></template>',
  });
  assert.ok(reaches.get('/billing')?.has('components/PayNow.vue'));
});

test('a component in a directory carries that directory in its name', () => {
  const { reaches } = of({
    'pages/lens.vue': '<template><LensClaimsView /></template>',
    'components/lens/ClaimsView.vue': '<template><button>Accept</button></template>',
  });
  assert.ok(reaches.get('/lens')?.has('components/lens/ClaimsView.vue'));
});

test('which side a component runs on is not part of its name', () => {
  const { reaches } = of({
    'pages/graph.vue': '<template><D2Diagram /></template>',
    'components/D2Diagram.client.vue': '<template><button>Zoom</button></template>',
  });
  assert.ok(reaches.get('/graph')?.has('components/D2Diagram.client.vue'));
});

test('what a page calls without importing is part of it', () => {
  const { reaches } = of({
    'pages/systems.vue': '<script>const { types } = useSoftwareSystems()</script>',
    'composables/useSoftwareSystems.ts': "export const TYPES = [{ label: 'Deploys' }]",
  });
  assert.ok(reaches.get('/systems')?.has('composables/useSoftwareSystems.ts'));
});

test('a layout is on screen for the routes that wear it, and no others', () => {
  const { reaches } = of({
    'pages/dashboard.vue': "<script>definePageMeta({ layout: 'dashboard' })</script>",
    'pages/login.vue': '<template><button>Sign in</button></template>',
    'layouts/dashboard.vue': '<template><button>Sign out</button></template>',
    'layouts/default.vue': '<template><slot /></template>',
  });
  assert.ok(reaches.get('/dashboard')?.has('layouts/dashboard.vue'));
  assert.ok(!reaches.get('/login')?.has('layouts/dashboard.vue'), 'not a screen it is on');
  assert.ok(reaches.get('/login')?.has('layouts/default.vue'), 'the one it does wear');
});

test('a component on several screens is on all of them', () => {
  const { reaches } = of({
    'pages/a.vue': '<template><Shared /></template>',
    'pages/b.vue': '<template><Shared /></template>',
    'components/Shared.vue': '<template><button>Export</button></template>',
  });
  assert.ok(reaches.get('/a')?.has('components/Shared.vue'));
  assert.ok(reaches.get('/b')?.has('components/Shared.vue'));
});

test('what no route reaches is on no screen', () => {
  const { unreached } = of({
    'pages/a.vue': '<template><div /></template>',
    'components/landing/Hero.vue': '<template><button>Start</button></template>',
    'utils/format.ts': 'export const f = 1',
  });
  assert.deepEqual([...unreached].sort(), ['components/landing/Hero.vue', 'utils/format.ts']);
});

test('somewhere with no routes at all is not forced into having them', () => {
  const { reaches } = of({ 'src/Button.vue': '<template><button>Go</button></template>' });
  assert.equal(reaches.size, 0, 'a library has no screens, and saying it has one would be worse');
});
