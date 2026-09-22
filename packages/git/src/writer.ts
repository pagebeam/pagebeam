import type { Finding } from '@pagebeam/core';
import { apply, commit, commitsOn, exists, open, push } from './branch.js';
import { bodyFor, titleFor } from './body.js';
import type { Forge, PullRequest } from './forge.js';
import { planFor, type Action } from './plan.js';
import { byPagebeam } from './trailers.js';

export interface WriteRequest {
  repo: string;
  branch: string;
  base: string;
  findings: Finding[];
  comparedWith: string | null;
  labels?: string[] | undefined;
  reviewers?: string[] | undefined;
  draft?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface Outcome {
  action: Action;
  reason: string;
  url: string | null;
  commits: number;
  title: string;
  body: string;
}

export async function write(forge: Forge, request: WriteRequest): Promise<Outcome> {
  const { repo, branch, base, findings } = request;

  const openPr = await forge.findOpen(branch);
  const ours = !(await exists(repo, branch))
    ? true
    : byPagebeam(await commitsOn(repo, branch, base));

  const plan = planFor({
    findings,
    open:
      openPr === null
        ? null
        : { number: openPr.number, head: openPr.head, body: openPr.body, commits: [] },
    ours,
  });

  const title = titleFor(findings);
  const body = bodyFor(findings, plan.state, request.comparedWith);
  const nothing = { action: plan.action, reason: plan.reason, title, body };

  if (plan.action === 'noop') return { ...nothing, url: openPr?.url ?? null, commits: 0 };

  if (plan.action === 'close') {
    if (!request.dryRun && openPr !== null) {
      await forge.close(openPr.number, 'Everything raised here has been dealt with.');
    }
    return { ...nothing, url: openPr?.url ?? null, commits: 0 };
  }

  const session = await open(repo, branch, base, plan.action !== 'append');
  let written = 0;
  try {
    for (const finding of findings) {
      if (finding.fix === undefined) continue;
      await apply(session.dir, finding.fix.changes);
      if (await commit(session.dir, finding, finding.title)) written += 1;
    }
    if (!request.dryRun && written > 0) {
      await push(session.dir, branch, plan.action === 'update');
    }
  } finally {
    await session.end();
  }

  // A pull request needs something to propose. Findings nothing can mend are
  // reported by the run itself rather than raised as a change to review.
  if (written === 0) {
    return {
      ...nothing,
      action: 'noop',
      reason: 'nothing found has a fix to propose',
      url: openPr?.url ?? null,
      commits: 0,
    };
  }

  if (request.dryRun) return { ...nothing, url: openPr?.url ?? null, commits: written };

  const pr: PullRequest =
    openPr === null
      ? await forge.create({
          head: branch,
          base,
          title,
          body,
          ...(request.labels ? { labels: request.labels } : {}),
          ...(request.reviewers ? { reviewers: request.reviewers } : {}),
          ...(request.draft === undefined ? {} : { draft: request.draft }),
        })
      : await forge.update(openPr.number, title, body);

  return { ...nothing, url: pr.url, commits: written };
}
