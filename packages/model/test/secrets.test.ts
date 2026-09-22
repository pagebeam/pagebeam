import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeASecret, withheld } from '../dist/secrets.js';

test('a credential in the source is recognised by its shape', () => {
  assert.match(String(looksLikeASecret('const k = "AKIA1234567890ABCDEF";')), /AWS/);
  assert.match(String(looksLikeASecret('-----BEGIN RSA PRIVATE KEY-----')), /private key/);
  assert.match(String(looksLikeASecret('apiKey: "9f8a7b6c5d4e3f2a1b0c9d8e"')), /credentials/);
});

test('a placeholder is what a file is supposed to contain', () => {
  assert.equal(looksLikeASecret('api_key: "your-api-key-here"'), null);
  assert.equal(looksLikeASecret('token = process.env.GITHUB_TOKEN'), null);
  assert.equal(looksLikeASecret('const label = "Save changes";'), null);
});

test('what is held back is named, and the rest still goes', () => {
  const { sending, held } = withheld([
    { path: 'a.ts', text: 'const label = "Save";' },
    { path: 'b.ts', text: 'const k = "AKIA1234567890ABCDEF";' },
  ]);
  assert.deepEqual(sending.map((f) => f.path), ['a.ts']);
  assert.equal(held.length, 1);
  assert.equal(held[0]?.path, 'b.ts');
});
