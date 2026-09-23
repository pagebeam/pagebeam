import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeModel, screensOf } from '../dist/screens.js';

const isRoute = (file: string, all: string[] = [file]): boolean => routeModel(all).routeOf(file) !== null;
const addressOf = (file: string, all: string[] = [file]): string => routeModel(all).routeOf(file)?.addresses[0] ?? '(none)';

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

test('Next.js App Router: only page files are routes, at the address Next.js serves', () => {
  assert.equal(addressOf('app/page.tsx'), '/');
  assert.equal(addressOf('app/dashboard/page.tsx'), '/dashboard');
  assert.equal(addressOf('app/(marketing)/pricing/page.tsx'), '/pricing');
  assert.equal(addressOf('src/app/settings/page.ts'), '/settings');
  assert.equal(addressOf('app/blog/[slug]/page.js'), '/blog/:slug');
  assert.equal(addressOf('app/docs/[...slug]/page.tsx'), '/docs/:slug*');
  assert.equal(addressOf('app/shop/[[...slug]]/page.tsx'), '/shop/:slug*?');
  for (const file of ['app/layout.tsx', 'app/dashboard/loading.tsx', 'app/dashboard/Chart.tsx', 'app/_lib/page.tsx']) {
    assert.ok(!isRoute(file), file);
  }
});

test('Next.js Pages Router, SvelteKit and Remix read by their own rules', () => {
  assert.equal(addressOf('pages/blog/[id].tsx'), '/blog/:id');
  assert.ok(!isRoute('pages/_app.tsx'));
  assert.ok(!isRoute('pages/api/users.ts'));
  assert.equal(addressOf('src/pages/about.vue'), '/about');
  assert.equal(addressOf('src/routes/(auth)/login/+page.svelte'), '/login');
  assert.ok(!isRoute('src/routes/about/+layout.svelte'));
  const kit = ['src/routes/about/+page.svelte', 'src/routes/about/Card.svelte'];
  assert.ok(!isRoute('src/routes/about/Card.svelte', kit), 'a component beside a SvelteKit page');
  assert.equal(addressOf('app/routes/_index.tsx'), '/');
  assert.equal(addressOf('app/routes/users.$id.tsx'), '/users/:id');
});

test('a Next.js page wears every layout above it, and no other', () => {
  const { reaches } = screensOf([
    { path: 'app/layout.tsx', text: '<nav><button>Sign out</button></nav>' },
    { path: 'app/dashboard/layout.tsx', text: '<aside>Filters</aside>' },
    { path: 'app/dashboard/page.tsx', text: '<p>Dashboard</p>' },
    { path: 'app/settings/page.tsx', text: '<p>Settings</p>' },
  ]);
  assert.ok(reaches.get('/dashboard')?.has('app/layout.tsx'));
  assert.ok(reaches.get('/dashboard')?.has('app/dashboard/layout.tsx'));
  assert.ok(reaches.get('/settings')?.has('app/layout.tsx'));
  assert.ok(!reaches.get('/settings')?.has('app/dashboard/layout.tsx'));
  assert.ok(!reaches.has('/layout') && !reaches.has('/dashboard/page'));
});

test('a SvelteKit component under routes is part of the page that uses it', () => {
  const { reaches } = screensOf([
    { path: 'src/routes/+page.svelte', text: '<Card />' },
    { path: 'src/routes/widgets/Card.svelte', text: '<button>Save Account</button>' },
  ]);
  assert.deepEqual([...(reaches.get('/') ?? [])].sort(), ['src/routes/+page.svelte', 'src/routes/widgets/Card.svelte']);
  assert.ok(!reaches.has('/widgets/Card'));
});

test('a Remix route is wrapped by the root and every parent route', () => {
  const { reaches } = screensOf([
    { path: 'app/root.tsx', text: '<nav>Home</nav>' },
    { path: 'app/routes/concerts.tsx', text: '<Outlet />' },
    { path: 'app/routes/concerts.$city.tsx', text: '<p>City</p>' },
  ]);
  assert.deepEqual([...(reaches.get('/concerts/:city') ?? [])].sort(), [
    'app/root.tsx',
    'app/routes/concerts.$city.tsx',
    'app/routes/concerts.tsx',
  ]);
});

test('a Remix optional segment is reached both with and without it', () => {
  const route = routeModel(['app/routes/($lang).categories.tsx']).routeOf('app/routes/($lang).categories.tsx');
  assert.deepEqual(route?.addresses.sort(), ['/:lang/categories', '/categories']);
});

test('routes configured in code make the route list incomplete, and say so', () => {
  const { incomplete } = screensOf([
    { path: 'vite.config.ts', text: 'remix({ routes(defineRoutes) { return defineRoutes(() => {}) } })' },
    { path: 'app/routes/_index.tsx', text: '<p>Home</p>' },
  ]);
  assert.match(incomplete ?? '', /vite\.config\.ts/);
});
