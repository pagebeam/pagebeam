import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { launchBrowser, unavailable } from '../dist/browser.js';

process.env.PLAYWRIGHT_BROWSERS_PATH = await mkdtemp(path.join(tmpdir(), 'pagebeam-browsers-'));

test('a missing Firefox is installed when the run allows it', async (t) => {
  t.after(() => delete process.env.PAGEBEAM_INSTALL_BROWSERS);
  process.env.PAGEBEAM_INSTALL_BROWSERS = '1';
  let installs = 0;
  const result = await launchBrowser(undefined, 'firefox', async () => {
    installs += 1;
  });
  assert.equal(installs, 1);
  assert.ok(unavailable(result));
  assert.match(result.reason, /no Playwright Firefox was found/);
});

test('a missing Firefox is reported without installing by default', async () => {
  let installs = 0;
  const result = await launchBrowser(undefined, 'firefox', async () => {
    installs += 1;
  });
  assert.equal(installs, 0);
  assert.ok(unavailable(result));
  assert.match(result.reason, /no Playwright Firefox was found/);
});

test('an explicit Firefox path is never replaced by an install', async (t) => {
  t.after(() => delete process.env.PAGEBEAM_INSTALL_BROWSERS);
  process.env.PAGEBEAM_INSTALL_BROWSERS = '1';
  let installs = 0;
  const result = await launchBrowser('/nonexistent/firefox', 'firefox', async () => {
    installs += 1;
  });
  assert.equal(installs, 0);
  assert.ok(unavailable(result));
});

test('a failed install is reported', async (t) => {
  t.after(() => delete process.env.PAGEBEAM_INSTALL_BROWSERS);
  process.env.PAGEBEAM_INSTALL_BROWSERS = '1';
  const result = await launchBrowser(undefined, 'firefox', async () => {
    throw new Error('download refused');
  });
  assert.ok(unavailable(result));
  assert.match(result.reason, /could not be installed: download refused/);
});
