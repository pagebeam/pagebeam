import path from 'node:path';
import process from 'node:process';
import { brokenLinks, loadConfig, type RunResult } from '@pagebeam/engine';
import { discover as discoverPages, parseAll } from '@pagebeam/docs';
import { github, slugOf, write, type Forge } from '@pagebeam/git';

export interface Proposed {
  said: string;
  code: number;
}

// The branch is pushed to `repo`, so the pull request has to be opened there.
// GITHUB_REPOSITORY names the checkout the job is running in, which is the
// same repository only when the documentation lives beside the code.
async function hostFrom(
  env: NodeJS.ProcessEnv,
  repo: string,
): Promise<Forge | { missing: string }> {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (token === undefined) return { missing: 'GITHUB_TOKEN' };

  const remote = await slugOf(repo);
  const slug = remote === null ? env['GITHUB_REPOSITORY'] : `${remote.owner}/${remote.name}`;
  if (slug === undefined) {
    return { missing: 'a git remote on the repository being proposed to, or GITHUB_REPOSITORY' };
  }
  const [owner, name] = slug.split('/');
  if (owner === undefined || name === undefined) {
    return { missing: 'GITHUB_REPOSITORY in the form owner/name' };
  }
  return github({
    owner,
    repo: name,
    token,
    ...(env['GITHUB_API_URL'] ? { apiUrl: env['GITHUB_API_URL'] } : {}),
  });
}

export async function propose(
  cwd: string,
  result: RunResult,
  publish: boolean,
): Promise<Proposed> {
  if (result.problem !== null) return { said: `${result.problem}\nNothing was checked.`, code: 2 };

  const { config } = await loadConfig(cwd);
  const repo = config.propose.repo === '.' ? cwd : path.resolve(cwd, config.propose.repo);

  // A finding names a page the way the documentation names it. The branch is
  // written from the repository, where the same page sits under the
  // documentation root.
  const from = path.relative(repo, path.resolve(cwd, config.docs.root));
  const inRepo = (where: string): string => (from === '' ? where : path.join(from, where));

  const findings = result.findings.map((finding) =>
    finding.fix === undefined
      ? finding
      : {
          ...finding,
          fix: {
            ...finding.fix,
            changes: finding.fix.changes.map((c) => ({ ...c, path: inRepo(c.path) })),
          },
        },
  );
  const mendable = findings.filter((f) => f.fix !== undefined);

  if (!publish) {
    const lines = [
      `${result.findings.length} finding(s), ${mendable.length} with a change to propose.`,
      ...mendable.map((f) => `  ${f.doc.path}  ${f.title}`),
      mendable.length === 0
        ? 'Nothing would be proposed.'
        : 'Nothing has been written. Pass --publish to open or update the pull request.',
    ];
    return { said: lines.join('\n'), code: 0 };
  }

  const host = await hostFrom(process.env, repo);
  if ('missing' in host) {
    return { said: `${host.missing} is needed to open a pull request.`, code: 2 };
  }

  // Links broken before anything is proposed. A proposal may leave these as
  // they were; it may not add one.
  const brokenBefore = new Set((await brokenLinks(cwd, config)).map((f) => f.id));

  // What the documentation becomes once every change is in place, read by the
  // same checks as the documentation it came from.
  const asItWouldBe = async (dir: string): Promise<string | null> => {
    const root = path.join(dir, from);
    const files = await discoverPages(root, config.docs.include, config.docs.exclude);
    const after = await parseAll(root, files);

    const unparsed = mendable
      .map((f) => f.fix!.changes[0]?.path)
      .filter((at): at is string => at !== undefined)
      .filter((at) => !after.some((page) => path.join(from, page.path) === at));
    if (unparsed.length > 0) {
      return `${unparsed[0]} could not be read back as a page`;
    }

    const made = (await brokenLinks(path.join(dir, path.relative(repo, cwd)), config)).find(
      (f) => !brokenBefore.has(f.id),
    );
    if (made !== undefined) {
      return `${made.doc.path} would link to ${made.title.replace(/ does not resolve$/, '')}, which nothing publishes`;
    }
    return null;
  };

  const outcome = await write(host, {
    repo,
    apps: result.apps,
    commitPrefix: config.propose.commitPrefix,
    verify: asItWouldBe,
    branch: config.propose.branch,
    base: config.propose.base,
    findings,
    comparedWith: result.comparedWith,
    complete: result.degraded.length === 0,
    labels: config.propose.labels,
    reviewers: config.propose.reviewers,
    ...(config.propose.draft === undefined ? {} : { draft: config.propose.draft }),
    dryRun: false,
  });

  return {
    said: `${outcome.action}: ${outcome.reason}${outcome.url === null ? '' : `\n${outcome.url}`}`,
    code: 0,
  };
}
