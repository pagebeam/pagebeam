import type { Finding } from '@pagebeam/core';
import { readState, same, stateOf, type State } from './state.js';

export type Action = 'noop' | 'create' | 'update' | 'append' | 'close';

export interface Open {
  number: number;
  head: string;
  body: string;
  // Every commit message on the branch, newest first.
  commits: string[];
}

export interface Plan {
  action: Action;
  reason: string;
  findings: Finding[];
  state: State;
}

export interface PlanInput {
  findings: Finding[];
  open: Open | null;
  // False when a person has pushed to the branch, which changes everything.
  ours: boolean;
  // False when a check was asked for and could not run. Finding nothing is
  // not the same as having looked everywhere.
  complete: boolean;
}

export function planFor({ findings, open, ours, complete }: PlanInput): Plan {
  // State records what was proposed. A finding nothing can mend was reported
  // and never offered as a change, so counting it as settled would silence it
  // for every run after this one.
  const state = stateOf(findings.filter((f) => f.fix !== undefined));

  if (open === null) {
    return findings.length === 0
      ? { action: 'noop', reason: 'nothing has drifted and nothing is open', findings, state }
      : { action: 'create', reason: `${findings.length} finding(s) to raise`, findings, state };
  }

  if (findings.length === 0) {
    if (!complete) {
      return {
        action: 'noop',
        reason: 'nothing was found, but not everything was checked, so nothing is closed',
        findings,
        state,
      };
    }
    if (!ours) {
      return {
        action: 'noop',
        reason: 'somebody has pushed to this branch, so it is theirs to close',
        findings,
        state,
      };
    }
    return { action: 'close', reason: 'everything raised has been dealt with', findings, state };
  }

  const before = readState(open.body);
  if (before !== null && same(before, state)) {
    return { action: 'noop', reason: 'the same findings as last time', findings, state };
  }

  // Replaying from the base is the only way to stay correct as findings come
  // and go, but it throws away commits. Somebody else's work is not ours to
  // throw away, so theirs is added to rather than replaced.
  return ours
    ? { action: 'update', reason: 'the findings have changed', findings, state }
    : {
        action: 'append',
        reason: 'somebody has pushed to this branch, so nothing is being replaced',
        findings,
        state,
      };
}
