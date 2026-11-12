import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { launchBrowser, unavailable } from '@pagebeam/app';
import { parseConfig } from '@pagebeam/core';
import { CaptureSession, shoot } from '../dist/index.js';
import { settleShot } from '../dist/settle.js';
import { notesApp } from './fixture.ts';

const { PNG } = createRequire(import.meta.url)('pngjs') as { PNG: { sync: { read(data: Buffer): { width: number; height: number; data: Buffer } } } };

for (const engine of ['shoot', 'session'] as const) {
  for (const fullPage of [false, true]) {
    test(`${engine}: ${fullPage ? 'full page shots reveal growing content' : 'viewport shots do not scroll'}`, async (t) => {
      const app = await notesApp();
      t.after(() => app.stop());
      const cwd = await mkdtemp(path.join(tmpdir(), 'pagebeam-settle-'));
      const tours = parseConfig({ docs: { root: '.' }, tours: {
        targets: { local: { url: app.url + '/scroll-reveal' } }, timeoutMs: 5000,
        accounts: { visitor: { purpose: 'Read page', login: { anonymous: true }, confirm: '#status' } },
        journeys: { reveal: { account: 'visitor', viewports: [{ name: 'desktop', width: 800, height: 600, scale: 1 }], steps: [
          { shot: { name: 'page', fullPage } },
          { expect: { selector: '#status', text: fullPage ? 'Loaded section 2' : 'Not scrolled' } },
          ...(fullPage ? [{ expect: { selector: 'section:last-of-type', text: 'Revealed section 2' } }] : [{ expect: { selector: 'body:not([data-scrolled])' } }]),
        ] } },
      } }).tours!;
      let session: CaptureSession | undefined;
      try {
        let file: string;
        if (engine === 'shoot') {
          const result = await shoot({ cwd, tours });
          assert.ok(!unavailable(result), JSON.stringify(result));
          file = path.join(cwd, '.pagebeam/shots/local/reveal', result.manifests[0]!.manifest.shots[0]!.file);
        } else {
          const journey = tours.journeys.reveal!;
          session = new CaptureSession({ cwd, tours, journey, name: 'reveal', target: 'local', viewport: journey.viewports[0]!, out: cwd,
            mode: 'saved', purpose: 'capture', disposable: false, mask: [], signal: new AbortController().signal, env: {},
            redact: value => value, registerSecret: () => {}, onStep: async () => {},
          });
          await session.start();
          const result = await session.step(journey.steps[0]);
          assert.equal(result.status, 'passed', result.error);
          file = path.join(cwd, result.file!);
          for (const step of journey.steps.slice(1)) {
            const checked = await session.step(step);
            assert.equal(checked.status, 'passed', checked.error);
          }
        }
        if (fullPage) {
          const image = PNG.sync.read(await readFile(file));
          assert.ok(image.height >= 2100);
          const offset = (1600 * image.width + 50) * 4;
          assert.deepEqual([...image.data.subarray(offset, offset + 3)], [255, 0, 0]);
        }
      } finally {
        await session?.close();
      }
    });
  }
}

test('an endlessly growing page settles within the timeout and returns to top', async () => {
  const app = await notesApp();
  const browser = await launchBrowser();
  assert.ok(!unavailable(browser), JSON.stringify(browser));
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(app.url + '/growing');
    const start = performance.now();
    await settleShot(page, { timeout: 1200, fullPage: true });
    assert.ok(performance.now() - start < 1800);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.equal(await page.locator('body').getAttribute('data-scrolled'), 'yes');
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight) > 1800);
    await page.close();
    await assert.doesNotReject(settleShot(page, { timeout: 100, fullPage: true }));
    const empty = await browser.newPage();
    await assert.doesNotReject(settleShot(empty, { timeout: 500, fullPage: true }));
  } finally {
    await browser.close();
    await app.stop();
  }
});
