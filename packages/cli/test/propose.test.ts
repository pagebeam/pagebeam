import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../dist/main.js');

async function host(): Promise<{ url: string; seen: string[]; stop: () => Promise<void> }> {
  const seen: string[] = [];
  let pr: unknown = null;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const at = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && at.includes('/pulls?state=open')) {
        return res.end(JSON.stringify(pr === null ? [] : [pr]));
      }
      if (req.method === 'POST' && at.endsWith('/pulls')) {
        seen.push('create');
        const sent = JSON.parse(body) as { head: string; body: string };
        pr = { number: 1, html_url: 'https://host/pull/1', body: sent.body, head: { ref: sent.head } };
        return res.end(JSON.stringify(pr));
      }
      if (req.method === 'PATCH') seen.push('update');
      res.end(JSON.stringify(pr ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  const port = typeof a === 'object' && a !== null ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Two controls named on one page, both renamed in the application. Their spans
// are worked out against the page as it was, so applying one moves the other.
const PAGE = 'Open **Create a report**, then press **Show related items** to finish.\n';
const BEFORE = '<template><button>Create a report</button><button>Show related items</button></template>\n';
const AFTER = '<template><button>Create a report summary</button><button>Show related items now</button></template>\n';

async function estate(): Promise<{ work: string; origin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-cli-e2e-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', origin]);

  await mkdir(path.join(work, 'docs'), { recursive: true });
  await mkdir(path.join(work, 'app'), { recursive: true });
  await writeFile(path.join(work, 'docs/guide.md'), PAGE);
  await writeFile(path.join(work, 'app/ReportForm.vue'), BEFORE);
  await writeFile(
    path.join(work, 'pagebeam.config.yaml'),
    'docs:\n  root: docs\nhistory:\n  sinceDays: 3650\n' +
      'checks:\n  strings:\n    minConfidence: 0.3\n' +
      "apps:\n  - name: dashboard\n    path: app\n    include: ['**/*.vue']\n",
  );
  const commit = (m: string) => {
    execFileSync('git', ['-C', work, 'add', '-A']);
    execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m]);
  };
  commit('first');
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
  await writeFile(path.join(work, 'app/ReportForm.vue'), AFTER);
  commit('rename both controls');
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
  return { work, origin };
}

test('two renames on one page reach the remote correctly', async () => {
  const { work, origin } = await estate();
  const api = await host();
  try {
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'acme/docs',
        GITHUB_TOKEN: 'x',
        GITHUB_API_URL: api.url,
      },
    });
    assert.match(stdout, /create/);

    const proposed = execFileSync('git', ['-C', origin, 'show', 'pagebeam/drift:docs/guide.md']).toString();
    assert.equal(
      proposed,
      'Open **Create a report summary**, then press **Show related items now** to finish.\n',
      'both spans replaced, neither shifted by the other',
    );

    const subjects = execFileSync('git', ['-C', origin, 'log', '--format=%s', 'main..pagebeam/drift'])
      .toString()
      .trim()
      .split('\n');
    assert.equal(subjects.length, 2, 'one commit per finding');
  } finally {
    await api.stop();
  }
});

test('running again with nothing changed proposes nothing', async () => {
  const { work } = await estate();
  const api = await host();
  try {
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: 'acme/docs',
      GITHUB_TOKEN: 'x',
      GITHUB_API_URL: api.url,
    };
    await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], { env });
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], { env });
    assert.match(stdout, /noop/);
    assert.deepEqual(api.seen, ['create'], 'it looked, and did nothing else');
  } finally {
    await api.stop();
  }
});
