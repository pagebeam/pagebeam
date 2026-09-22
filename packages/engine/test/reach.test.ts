import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exempt } from '../dist/reach.js';

test('an allowlisted host is matched as a host, not as text', () => {
  assert.ok(exempt('https://example.com/a', ['example.com']));
  assert.ok(exempt('https://docs.example.com/a', ['example.com']), 'subdomains included');
  assert.ok(!exempt('https://evil.test/?q=example.com', ['example.com']), 'not anywhere in the text');
  assert.ok(!exempt('https://notexample.com/a', ['example.com']));
});

test('a wildcard names subdomains and not the domain itself', () => {
  assert.ok(exempt('https://a.example.com/x', ['*.example.com']));
  assert.ok(!exempt('https://example.com/x', ['*.example.com']), 'the star stands for something');
});

test('a full prefix matches the address', () => {
  assert.ok(exempt('https://example.com/private/x', ['https://example.com/private']));
  assert.ok(!exempt('https://example.com/public/x', ['https://example.com/private']));
});

test('something that is not an address is never exempt', () => {
  assert.ok(!exempt('not a url', ['example.com']));
});
