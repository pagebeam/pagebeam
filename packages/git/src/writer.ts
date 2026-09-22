import type { Finding } from '@pagebeam/core';
import { apply, baseRef, commit, commitsOn, exists, open, push, remoteCommits } from './branch.js';
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
  // False when a check was asked for and could not run.
  complete: boolean;
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

  // The remote is what will be replaced, so the remote has to be asked; a
  // local ref only says what this clone last heard. But work committed here
  // and not yet pushed is still somebody's work, so both have to agree before
  // anything is thrown away.
  // Not being able to ask is not an answer. Nothing is replaced or closed on
  // the strength of a question that went unanswered.
  const onRemote = await remoteCommits(repo, branch, await baseRef(repo, base));
  const from = await baseRef(repo, base);
  const locally = (await exists(repo, branch)) ? await commitsOn(repo, branch, from) : [];
  const theirs =
    (onRemote !== null && onRemote.length > 0 && !byPagebeam(onRemote)) ||
    (locally.length > 0 && !byPagebeam(locally));
  const ours = !theirs;

  const plan = planFor({
    findings,
    open:
      openPr === null
        ? null
        : { number: openPr.number, head: openPr.head, body: openPr.body, commits: [] },
    ours,
    complete: request.complete,
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

  // Each finding stays its own commit, so a reviewer reads them one at a time.
  // Within a page they are made from the last span backwards, so that a change
  // never moves the ground under the one after it.
  const startOf = (finding: Finding): number =>
    Math.max(...(finding.fix?.changes ?? []).map((c) => c.splice?.start ?? -1), -1);
  const fixable = findings
    .filter((f) => f.fix !== undefined)
    .sort((a, b) => a.doc.path.localeCompare(b.doc.path) || startOf(b) - startOf(a));

  // A dry run says what it would do. Creating a branch and committing to it is
  // doing it, so nothing here goes near the repository.
  if (request.dryRun) {
    return fixable.length === 0
      ? { ...nothing, action: 'noop', reason: 'nothing found has a fix to propose', url: openPr?.url ?? null, commits: 0 }
      : { ...nothing, url: openPr?.url ?? null, commits: fixable.length };
  }

  const session = await open(repo, branch, base, plan.action !== 'append');
  let written = 0;
  try {
    // Each finding is still its own commit, so a reviewer can read them one at
    // a time, but a page's spans are resolved against the file as it stands
    // when that commit is made.
    for (const finding of fixable) {
      await apply(session.dir, finding.fix!.changes);
      if (await commit(session.dir, finding, finding.title)) written += 1;
    }
    if (written > 0) await push(session.dir, branch, plan.action === 'update');
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
