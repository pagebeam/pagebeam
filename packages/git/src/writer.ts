import type { Finding } from '@pagebeam/core';
import {
  apply,
  baseRef,
  commit,
  commitsOn,
  entriesOn,
  exists,
  open,
  push,
  remoteCommits,
  replay,
} from './branch.js';
import { bodyFor, titleFor } from './body.js';
import type { Forge, PullRequest } from './forge.js';
import { planFor, type Action } from './plan.js';
import { byPagebeam, readTrailers } from './trailers.js';

export interface WriteRequest {
  repo: string;
  branch: string;
  base: string;
  findings: Finding[];
  // Every application this run examined. A run owns the commits raised for the
  // applications it looked at, whether or not it still has findings for them.
  apps?: string[] | undefined;
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
  const mine = new Set(
    request.apps ?? findings.map((f) => f.app).filter((a): a is string => a !== undefined),
  );

  const openPr = await forge.findOpen(branch);

  // Both the remote and this clone have to agree before anything is replaced,
  // and a question that could not be asked is not an answer.
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
  const done = (): typeof nothing => ({ ...nothing, action });

  if (plan.action === 'noop') return { ...nothing, url: openPr?.url ?? null, commits: 0 };

  if (plan.action === 'close') {
    // Everything this run raised is dealt with. Another application's findings
    // may not be, and they live on the same branch.
    const left = (await entriesOn(repo, branch, from)).filter((entry) => {
      const trailers = readTrailers(entry.message);
      return trailers !== null && trailers.app !== null && !mine.has(trailers.app);
    });
    if (left.length > 0) {
      return {
        ...nothing,
        action: 'noop',
        reason: 'another application still has findings open on this branch',
        url: openPr?.url ?? null,
        commits: 0,
      };
    }
    if (!request.dryRun && openPr !== null) {
      await forge.close(openPr.number, 'Everything raised here has been dealt with.');
    }
    return { ...nothing, url: openPr?.url ?? null, commits: 0 };
  }

  // One commit per finding. Within a page they go from the last span
  // backwards, so an edit never moves the one after it.
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

  // One documentation repository can be written to by several product
  // repositories. Rebuilding from the base is what keeps this branch honest as
  // findings come and go, but it would throw away work another application
  // raised, so that work is replayed first and this run only replaces its own.
  const others =
    plan.action === 'update' && mine.size > 0
      ? (await entriesOn(repo, branch, from)).filter((entry) => {
          const trailers = readTrailers(entry.message);
          return trailers !== null && trailers.app !== null && !mine.has(trailers.app);
        })
      : [];

  let session = await open(repo, branch, base, plan.action !== 'append');
  let action = plan.action;
  let written = 0;
  try {
    if (others.length > 0 && !(await replay(session.dir, others.map((e) => e.sha)))) {
      // Their edits and ours meet in the same bytes. Adding to the branch
      // leaves both intact; rebuilding would drop theirs.
      await session.end();
      session = await open(repo, branch, base, false);
      action = 'append';
    }

    for (const finding of fixable) {
      await apply(session.dir, finding.fix!.changes);
      if (await commit(session.dir, finding, finding.title)) written += 1;
    }
    if (written > 0 || others.length > 0) await push(session.dir, branch, action === 'update');
  } finally {
    await session.end();
  }

  // A pull request needs something to propose. Findings nothing can mend are
  // reported by the run itself rather than raised as a change to review.
  if (written === 0 && others.length === 0) {
    return {
      ...nothing,
      action: 'noop',
      reason: 'nothing found has a fix to propose',
      url: openPr?.url ?? null,
      commits: 0,
    };
  }

  // A change worked out from the source says exactly what it replaces and
  // what it expects to find there. One a model wrote is a suggestion about
  // prose nobody has read yet, so it arrives as a draft unless the
  // configuration says otherwise outright.
  const anyFromAModel = fixable.some((f) => f.fix?.author === 'model');
  const asDraft = request.draft ?? anyFromAModel;

  const pr: PullRequest =
    openPr === null
      ? await forge.create({
          head: branch,
          base,
          title,
          body,
          ...(request.labels ? { labels: request.labels } : {}),
          ...(request.reviewers ? { reviewers: request.reviewers } : {}),
          draft: asDraft,
        })
      : await forge.update(openPr.number, title, body);

  return { ...done(), url: pr.url, commits: written };
}
