import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseFromPatterns, routesOf } from '../src/links.ts';
import type { DocPage } from '@pagebeam/docs';

const page = (p: string): DocPage => ({
  path: p, format: 'markdown', raw: '', prose: '', links: [], codeSpans: [],
  codeBlocks: [], emphasised: [], directives: [], slug: null,
});

test('a pattern with a literal directory names the scaffolding', () => {
  assert.equal(baseFromPatterns(['src/pages/**/*.md']), 'src/pages');
  assert.equal(baseFromPatterns(['**/*.md']), '');
  assert.equal(baseFromPatterns(['a/**/*.md', 'b/**/*.md']), '');
});

test('a directory the pattern does not name stays in the route', () => {
  const routes = routesOf([page('guides/a.md'), page('guides/b.md')]);
  assert.ok(routes.has('/guides/a'), 'guides is part of the address, not scaffolding');
});

test('scaffolding named by the pattern is stripped', () => {
  const routes = routesOf([page('src/pages/a.md')], 'src/pages');
  assert.ok(routes.has('/a'));
});

test('a declared prefix is applied to every route', () => {
  const routes = routesOf([page('guides/a.md')], '', '/docs');
  assert.ok(routes.has('/docs/guides/a'));
});

test('a page publishing itself at a declared address is found there', () => {
  const declared: DocPage = { ...page('deep/nested/file.md'), slug: 'short' };
  const routes = routesOf([declared]);
  assert.ok(routes.has('/short'), 'the frontmatter decides, not the path');
  assert.ok(!routes.has('/deep/nested/file'));
});

test('a declared address is relative to the section it is published under', () => {
  const declared: DocPage = { ...page('a.md'), slug: '/bonjour' };
  const routes = routesOf([declared], '', '/docs');
  assert.ok(routes.has('/docs/bonjour'), 'a slug is appended to the route base');
  assert.ok(!routes.has('/bonjour'), 'a leading slash does not escape to the site root');
});

test('a page with no declared address still follows its path', () => {
  assert.ok(routesOf([page('guides/a.md')]).has('/guides/a'));
});
