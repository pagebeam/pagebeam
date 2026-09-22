import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentedKeys } from '../src/config-keys.ts';
import type { DocPage } from '@pagebeam/docs';

function page(value: string, lang: string | null = 'ini'): DocPage {
  return {
    path: 'p.md',
    format: 'markdown',
    raw: value,
    prose: '',
    links: [],
    codeSpans: [],
    codeBlocks: [{ value, lang, line: 1 }],
    directives: [], emphasised: [], slug: null,
  };
}

test('reads a plain assignment', () => {
  assert.deepEqual(documentedKeys([page('APP_KEY=abc')]).map((k) => k.key), ['APP_KEY']);
});

test('reads docker inline environment flags', () => {
  const keys = documentedKeys([
    page('docker run \\\n  -e CACHE_MODE=redis \\\n  -e TLS_KEY_PATH=/x.pem', null),
  ]).map((k) => k.key);
  assert.deepEqual(keys, ['CACHE_MODE', 'TLS_KEY_PATH']);
});

test('reads export and Dockerfile ENV forms', () => {
  const keys = documentedKeys([page('export DB_HOST=localhost\nENV APP_URL=https://x', 'bash')]).map((k) => k.key);
  assert.deepEqual(keys, ['DB_HOST', 'APP_URL']);
});

test('ignores prose blocks that are not environment flavoured', () => {
  assert.deepEqual(documentedKeys([page('NOTE=this is prose', 'python')]), []);
});

test('ignores lowercase and short tokens', () => {
  assert.deepEqual(documentedKeys([page('db=1\nAB=2\nfoo_bar=3')]), []);
});

test('reports the line the key is actually on', () => {
  const block = 'FIRST=1\nSECOND=2\n  -e THIRD=3';
  const keys = documentedKeys([{ ...page(block, null), codeBlocks: [{ value: block, lang: null, line: 10 }] }]);
  assert.deepEqual(
    keys.map((k) => [k.key, k.line]),
    [['FIRST', 11], ['SECOND', 12], ['THIRD', 13]],
  );
});
