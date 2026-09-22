import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../dist/run.js';

// The label is built from pieces, so it appears in no file as written.
const APP_SOURCE = 'parts = ["Save", "changes"]\nlabel = " ".join(parts)\n';
const PAGE = `<!doctype html><html><body><script>
  document.body.innerHTML = '<button>' + ['Save','changes'].join(' ') + '</button>';
</script></body></html>`;

async function serve(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  const port = typeof a === 'object' && a !== null ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function site(url: string | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-render-'));
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app/ui.py'), APP_SOURCE);
  await writeFile(path.join(root, 'docs/a.md'), 'Click the **Save changes** button.\n');
  await writeFile(
    path.join(root, 'pagebeam.config.yaml'),
    'docs:\n  root: docs\nchecks:\n  strings:\n    minConfidence: 0.2\napps:\n  - name: api\n    path: app\n' +
      "    include: ['**/*.py']\n" +
      (url === null ? '' : `    url: ${url}\n    routes: ['/']\n`),
  );
  return root;
}

test('reading files alone reports a control that is really there', async () => {
  const result = await run(await site(null));
  const missing = result.findings.filter((f) => f.check === 'strings');
  assert.equal(missing.length, 1, 'the label is assembled, so no file contains it');
  assert.match(missing[0]!.title, /Save changes/);
});

test('opening the application finds what no file contains', async (t) => {
  const app = await serve();
  try {
    const result = await run(await site(app.url));
    if (result.findings.some((f) => f.check === 'strings')) {
      const grade = result.grade;
      if (grade?.source !== 'rendered') {
        t.skip('no browser to drive, so nothing was opened');
        return;
      }
    }
    assert.deepEqual(
      result.findings.filter((f) => f.check === 'strings'),
      [],
      'the running application shows the control, so nothing has drifted',
    );
    assert.equal(result.grade?.source, 'rendered');
    assert.equal(result.grade?.whole, false, 'only the pages it was told to open were seen');
  } finally {
    await app.stop();
  }
});
