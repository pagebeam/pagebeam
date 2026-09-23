import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../dist/main.js');

async function serve(
  answer: (req: { method: string; url: string; body: string }) => unknown,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer({ method: req.method ?? '', url: req.url ?? '', body })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  const port = typeof a === 'object' && a !== null ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function forge(): Promise<{ url: string; stop: () => Promise<void> }> {
  let pr: unknown = null;
  return serve(({ method, url, body }) => {
    if (method === 'GET' && url.includes('/pulls?state=open')) return pr === null ? [] : [pr];
    if (method === 'POST' && url.endsWith('/pulls')) {
      const sent = JSON.parse(body) as { head: string; body: string };
      pr = { number: 1, html_url: 'https://host/pull/1', body: sent.body, head: { ref: sent.head } };
      return pr;
    }
    return pr ?? {};
  });
}

async function model(page: string): Promise<{ url: string; stop: () => Promise<void> }> {
  return serve(() => ({ choices: [{ message: { content: page } }] }));
}

async function repository(
  files: Record<string, string>,
  changed: Record<string, string>,
): Promise<{ work: string; origin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-fixes-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', origin]);
  const put = async (all: Record<string, string>) => {
    for (const [at, text] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(work, at)), { recursive: true });
      await writeFile(path.join(work, at), text);
    }
  };
  const commit = (m: string) => {
    execFileSync('git', ['-C', work, 'add', '-A']);
    execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m]);
    execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
  };
  await put(files);
  commit('first');
  await put(changed);
  commit('change the product');
  return { work, origin };
}

const CONFIG =
  'docs:\n  root: docs\nhistory:\n  sinceDays: 3650\n' +
  'checks:\n  strings:\n    minConfidence: 0.3\n' +
  "apps:\n  - name: dashboard\n    path: app\n    include: ['**/*.vue']\n";

test('valid links with a fragment, a query or an index page do not block a proposal', async () => {
  const { work, origin } = await repository(
    {
      'pagebeam.config.yaml': CONFIG,
      'docs/index.md': '# Home\n\nRead [install](/guide#install), [quick](/guide?mode=quick) or go [home](/).\n',
      'docs/guide.md': '# Guide\n\nOpen **Create a report** to start.\n',
      'app/ReportForm.vue': '<template><button>Create a report</button></template>\n',
    },
    { 'app/ReportForm.vue': '<template><button>Create a report summary</button></template>\n' },
  );
  const api = await forge();
  try {
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], {
      env: { ...process.env, GITHUB_REPOSITORY: 'acme/docs', GITHUB_TOKEN: 'x', GITHUB_API_URL: api.url },
    });
    assert.match(stdout, /create/);
    const proposed = execFileSync('git', ['-C', origin, 'show', 'pagebeam/drift:docs/guide.md']).toString();
    assert.match(proposed, /Create a report summary/);
  } finally {
    await api.stop();
  }
});

test('a proposal reaches a docs repository kept apart from the product', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-apart-'));
  const origin = path.join(root, 'docs-origin.git');
  const docs = path.join(root, 'docs');
  const product = path.join(root, 'product');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  for (const dir of [docs, product]) execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', docs, 'remote', 'add', 'origin', origin]);
  const commit = (dir: string, m: string) => {
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m]);
  };

  await mkdir(path.join(docs, 'content'), { recursive: true });
  await writeFile(path.join(docs, 'content/index.md'), '# Home\n\nRead the [guide](/guide#start).\n');
  await writeFile(path.join(docs, 'content/guide.md'), '# Guide\n\nOpen **Create a report** to start.\n');
  commit(docs, 'docs');
  execFileSync('git', ['-C', docs, 'push', '-q', 'origin', 'main']);

  await mkdir(path.join(product, 'app'), { recursive: true });
  await writeFile(
    path.join(product, 'pagebeam.config.yaml'),
    'docs:\n  root: ../docs/content\nhistory:\n  sinceDays: 3650\n' +
      'checks:\n  strings:\n    minConfidence: 0.3\n' +
      "apps:\n  - name: dashboard\n    path: app\n    include: ['**/*.vue']\n" +
      'propose:\n  repo: ../docs\n',
  );
  await writeFile(path.join(product, 'app/ReportForm.vue'), '<template><button>Create a report</button></template>\n');
  commit(product, 'first');
  await writeFile(
    path.join(product, 'app/ReportForm.vue'),
    '<template><button>Create a report summary</button></template>\n',
  );
  commit(product, 'rename');

  const api = await forge();
  try {
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', product, '--publish'], {
      env: { ...process.env, GITHUB_REPOSITORY: 'acme/docs', GITHUB_TOKEN: 'x', GITHUB_API_URL: api.url },
    });
    assert.match(stdout, /create/);
    const proposed = execFileSync('git', ['-C', origin, 'show', 'pagebeam/drift:content/guide.md']).toString();
    assert.match(proposed, /Create a report summary/);
  } finally {
    await api.stop();
  }
});

const REMOVED = {
  files: {
    'docs/guide.md': '# Ledger\n\nPress **Export ledger** to download every entry as a file you can open.\n',
    'app/Ledger.vue': '<template><button>Export ledger</button><button>Print</button></template>\n',
  },
  changed: { 'app/Ledger.vue': '<template><button>Print</button></template>\n' },
};

async function proposing(page: string): Promise<string> {
  const llm = await model(page);
  try {
    const { work } = await repository(
      {
        ...REMOVED.files,
        'pagebeam.config.yaml': `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n`,
      },
      REMOVED.changed,
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work]);
    return stdout;
  } finally {
    await llm.stop();
  }
}

test('a draft that keeps an undeclared setting is not proposed', async () => {
  const page = 'Set the retry limit before you start.\n\n```env\nRETRY_LIMIT=5\n```\n';
  const llm = await model('Set how many times a delivery is retried before you start.\n\n```env\nRETRY_LIMIT=5\n```\n');
  try {
    const { work } = await repository(
      {
        'docs/setup.md': page,
        'app/.env.example': 'RETRY_LIMIT=5\n',
        'app/Home.vue': '<template><p>Home</p></template>\n',
        'pagebeam.config.yaml': `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n`,
      },
      { 'app/.env.example': 'DELIVERY_RETRIES=5\n' },
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work]);
    assert.match(stdout, /^1 finding\(s\), 0 with a change to propose\./m);
  } finally {
    await llm.stop();
  }
});

test('a draft that keeps a dead external link is not proposed', async () => {
  const dead = createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const a = dead.address();
  const url = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}/gone`;
  const llm = await model(`# Links\n\nThe full reference is [on the old site](${url}), which covers every option in detail.\n`);
  try {
    const { work } = await repository(
      {
        'docs/links.md': `# Links\n\nSee [the reference](${url}) for every option.\n`,
        'app/Home.vue': '<template><p>Home</p></template>\n',
        'pagebeam.config.yaml':
          `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n`.replace(
            'checks:\n',
            'checks:\n  links:\n    external: true\n',
          ),
      },
      { 'app/Home.vue': '<template><p>Welcome</p></template>\n' },
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work]);
    assert.match(stdout, /^1 finding\(s\), 0 with a change to propose\./m);
  } finally {
    await llm.stop();
    await new Promise<void>((resolve) => dead.close(() => resolve()));
  }
});

async function oneAtATime(): Promise<{ url: string; stop: () => Promise<void> }> {
  return serve(({ body }) => {
    const asked = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages
      .map((m) => m.content)
      .join('\n');
    const page = asked.slice(asked.indexOf('\n', asked.indexOf('Page (')) + 1);
    const name = asked.match(/^Problem: "([^"]+)"/m)?.[1];
    if (name !== undefined) return { choices: [{ message: { content: page.replace(`**${name}**`, '**Print**') } }] };
    const link = asked.match(/^Problem: (\S+) does not resolve/m)?.[1] ?? '';
    const unlinked = page.replace(new RegExp(`\\[([^\\]]+)\\]\\(${link.replace(/[/.]/g, '\\$&')}\\)`), '$1');
    return { choices: [{ message: { content: unlinked } }] };
  });
}

test('two drafts for one page both reach the proposal', async () => {
  const llm = await oneAtATime();
  const api = await forge();
  try {
    const { work, origin } = await repository(
      {
        'docs/ledger.md':
          '# Ledger\n\nPress **Export ledger** to download every entry as a file.\n\nPress **Archive ledger** to move old entries out of sight.\n',
        'app/Ledger.vue':
          '<template><button>Export ledger</button><button>Archive ledger</button><button>Print</button></template>\n',
        'pagebeam.config.yaml': `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n`,
      },
      { 'app/Ledger.vue': '<template><button>Print</button></template>\n' },
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], {
      env: { ...process.env, GITHUB_REPOSITORY: 'acme/docs', GITHUB_TOKEN: 'x', GITHUB_API_URL: api.url },
    });
    assert.match(stdout, /create/);
    const proposed = execFileSync('git', ['-C', origin, 'show', 'pagebeam/drift:docs/ledger.md']).toString();
    assert.doesNotMatch(proposed, /Export ledger/);
    assert.doesNotMatch(proposed, /Archive ledger/);
  } finally {
    await llm.stop();
    await api.stop();
  }
});

test('drafts of different severity for one page all reach the proposal', async () => {
  const llm = await oneAtATime();
  const api = await forge();
  try {
    const { work, origin } = await repository(
      {
        'docs/ledger.md':
          '# Ledger\n\nPress **Export ledger** to download every entry as a file.\n\nSee the [old archive](/archive) for entries from before.\n',
        'app/Ledger.vue': '<template><button>Export ledger</button><button>Print</button></template>\n',
        'pagebeam.config.yaml': `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n`,
      },
      { 'app/Ledger.vue': '<template><button>Print</button></template>\n' },
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], {
      env: { ...process.env, GITHUB_REPOSITORY: 'acme/docs', GITHUB_TOKEN: 'x', GITHUB_API_URL: api.url },
    });
    assert.match(stdout, /create/);
    const proposed = execFileSync('git', ['-C', origin, 'show', 'pagebeam/drift:docs/ledger.md']).toString();
    assert.doesNotMatch(proposed, /Export ledger/);
    assert.doesNotMatch(proposed, /\(\/archive\)/);
  } finally {
    await llm.stop();
    await api.stop();
  }
});

test('a proposal that would leave the docs with a new finding is not published', async () => {
  const llm = await model(
    '# Ledger\n\nThe ledger lists every entry you have recorded, newest first, with its date and its amount.\n',
  );
  const api = await forge();
  try {
    const { work } = await repository(
      {
        'docs/ledger.md': '# Ledger\n\nPress **Export ledger** to download every entry as a file.\n',
        'app/pages/ledger.vue': '<template><button>Export ledger</button></template>\n',
        'pagebeam.config.yaml': `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n`,
      },
      {
        'docs/ledger.md':
          '# Ledger\n\nPress **Export ledger** to download every entry as a file. ' +
          'Use **Print entries**, **Refresh totals** and **Filter by month** to work with the list.\n',
        'app/pages/ledger.vue':
          '<template><button>Print entries</button><button>Refresh totals</button><button>Filter by month</button></template>\n',
      },
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work, '--publish'], {
      env: { ...process.env, GITHUB_REPOSITORY: 'acme/docs', GITHUB_TOKEN: 'x', GITHUB_API_URL: api.url },
    });
    assert.match(stdout, /would gain/);
    assert.doesNotMatch(stdout, /create/);
  } finally {
    await llm.stop();
    await api.stop();
  }
});

test('a draft the checks no longer object to is proposed', async () => {
  const said = await proposing(
    '# Ledger\n\nPress **Print** to get every entry on paper, or save it as a file you can open.\n',
  );
  assert.match(said, /1 with a change to propose/);
});

test('init writes a config that reads back when a folder name means something in YAML', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagebeam-init-'));
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs/guide.md'), '# Guide\n\nPress **Save** to keep it.\n');
  await mkdir(path.join(root, 'true/pages'), { recursive: true });
  await writeFile(path.join(root, 'true/pages/index.vue'), '<template><button>Save</button></template>\n');

  await run(process.execPath, [CLI, 'init', '--cwd', root]);
  const config = parse(await readFile(path.join(root, 'pagebeam.config.yaml'), 'utf8')) as {
    apps: { name: unknown; path: unknown }[];
  };
  for (const app of config.apps) {
    assert.equal(typeof app.name, 'string');
    assert.equal(typeof app.path, 'string');
  }
  const { stdout } = await run(process.execPath, [CLI, 'check', '--cwd', root]);
  assert.match(stdout, /pages checked against/);
});

// Deleting the old root tree leaves the commit findable but its files unlistable.
test('history that cannot be read makes the run untrusted, not historyless', async () => {
  const { work } = await repository(
    {
      'pagebeam.config.yaml': 'docs:\n  root: docs\nhistory:\n  sinceDays: 3650\n',
      'docs/guide.md': '# Guide\n\nThe first words.\n',
    },
    { 'docs/guide.md': '# Guide\n\nOther words.\n' },
  );
  const first = execFileSync('git', ['-C', work, 'rev-list', '--max-parents=0', 'HEAD']).toString().trim();
  const tree = execFileSync('git', ['-C', work, 'rev-parse', `${first}^{tree}`]).toString().trim();
  await rm(path.join(work, '.git/objects', tree.slice(0, 2), tree.slice(2)));

  const code = await run(process.execPath, [CLI, 'check', '--cwd', work]).then(
    () => 0,
    (error: { code?: number }) => error.code ?? -1,
  );
  assert.equal(code, 2);
});

test('source held back from the model for its size is named in the output', async () => {
  const llm = await model('# Ledger\n\nPress **Print entries**, **Refresh totals** or **Filter by month**.\n');
  try {
    const big = `<!-- ${'x'.repeat(130_000)} -->`;
    const { work } = await repository(
      {
        'docs/intro.md': '# Intro\n\nWelcome to the product and its guides.\n',
        'app/pages/ledger.vue': '<template><p>Ledger</p></template>\n',
        'pagebeam.config.yaml': `${CONFIG}model:\n  baseUrl: ${llm.url}\n  name: local\n  sendSource: true\n`,
      },
      {
        'app/pages/ledger.vue':
          '<template><button>Print entries</button><button>Refresh totals</button>' +
          `<button>Filter by month</button></template>\n${big}\n`,
      },
    );
    const { stdout } = await run(process.execPath, [CLI, 'fix', '--cwd', work]);
    assert.match(stdout, /model: 1 source file\(s\) did not fit and were not sent: .*ledger\.vue/);
  } finally {
    await llm.stop();
  }
});
