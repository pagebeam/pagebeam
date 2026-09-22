import path from 'node:path';
import process from 'node:process';
import { loadConfig, type RunResult } from '@pagebeam/engine';
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

  const outcome = await write(host, {
    repo,
    branch: config.propose.branch,
    base: config.propose.base,
    findings,
    comparedWith: result.comparedWith,
    complete: result.degraded.length === 0,
    labels: config.propose.labels,
    reviewers: config.propose.reviewers,
    draft: config.propose.draft,
    dryRun: false,
  });

  return {
    said: `${outcome.action}: ${outcome.reason}${outcome.url === null ? '' : `\n${outcome.url}`}`,
    code: 0,
  };
}
