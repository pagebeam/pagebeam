import type { Finding } from '@pagebeam/core';
import { createColors } from 'picocolors';
import type { RunResult } from './run.js';

const MARK = { error: '✗', warn: '!', info: 'i' } as const;
// Decided here rather than left to be worked out, because a bundle is loaded
// in a context that can answer the question differently from the program. A
// log file and a pipe read as plainly as they did before colour existed.
const watching =
  process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0'
    ? true
    : process.env['NO_COLOR'] !== undefined || process.env['TERM'] === 'dumb'
      ? false
      : process.stdout.isTTY === true;

const colour = createColors(watching);
const PAINT = { error: colour.red, warn: colour.yellow, info: colour.blue } as const;

// Reading a report is most of using this, and a wall of the same grey is a
// wall whatever it says. Colour is dropped where nothing is watching, so a log
// and a pipe read as plainly as they did before.
const dim = (text: string): string => colour.dim(text);
const bold = (text: string): string => colour.bold(text);

function heading(result: RunResult): string[] {
  const lines: string[] = [];
  const where = result.configFrom ?? 'no config file';
  const apps = result.apps.length === 0 ? 'no applications' : result.apps.join(', ');
  lines.push(
    `${bold(String(result.pages))} pages checked against ${bold(apps)} ${dim(`(${where})`)}`,
  );

  const aside: string[] = [`ran ${result.ran.length === 0 ? 'nothing' : result.ran.join(', ')}`];
  if (result.comparedWith !== null) aside.push(`compared with ${result.comparedWith.slice(0, 8)}`);
  if (result.grade !== null) {
    aside.push(
      `${result.grade.source} source, ${
        result.grade.depth === 'paired' ? 'against an earlier revision' : 'no earlier revision'
      }`,
    );
  }
  lines.push(dim(aside.join('  ·  ')));

  const build = result.build;
  if (build !== undefined) {
    const by = build.framework === null ? '' : ` (${build.framework})`;
    lines.push(
      'dir' in build
        ? dim(`built the docs with ${build.command}${by}`)
        : `${colour.yellow('could not build')} ${bold('the docs')}${by} ${dim(build.failed)}`,
    );
  }

  for (const skipped of result.skipped) {
    const name = skipped.split(':')[0] as string;
    const asked = result.degraded.includes(name);
    const said = skipped.slice(name.length + 1).trim();
    lines.push(
      `${asked ? colour.yellow('did not run') : dim('not run')} ${bold(name)} ${dim(said)}`,
    );
  }
  return lines;
}

// Finding nothing while some checks did not run is the reading most likely to
// be taken for an all-clear, so it is the one that says outright it is not.
function tail(result: RunResult, foundNothing = false): string[] {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const f of result.findings) counts.set(f.check, (counts.get(f.check) ?? 0) + 1);
  if (counts.size > 0) {
    lines.push([...counts].map(([check, n]) => `${bold(String(n))} ${check}`).join(', '));
  }
  if (result.skipped.length > 0) {
    lines.push(
      colour.yellow(
        foundNothing
          ? `${result.skipped.length} check(s) did not run. This is not a clean bill of health.`
          : `${result.skipped.length} check(s) did not run, so this is not the whole picture.`,
      ),
    );
  }
  return lines;
}

export function pretty(result: RunResult): string {
  if (result.problem !== null) {
    return `${colour.red(result.problem)}\nNothing was checked.`;
  }

  const lines = [...heading(result), ''];

  if (result.findings.length === 0) {
    lines.push(
      result.ran.length === 0
        ? colour.yellow('No check ran, so nothing was verified.')
        : colour.green(`No drift found by ${result.ran.join(', ')}.`),
    );
    lines.push(...tail(result, true));
    return lines.join('\n');
  }

  // Grouped by the page somebody would open to act on it, because that is how
  // the work is done: a page at a time, not a finding at a time.
  const byPage = new Map<string, Finding[]>();
  for (const f of result.findings) {
    byPage.set(f.doc.path, [...(byPage.get(f.doc.path) ?? []), f]);
  }

  for (const [page, found] of byPage) {
    lines.push(bold(colour.underline(page)));
    for (const f of found) {
      const at = f.doc.line === undefined ? '' : dim(`:${f.doc.line}`);
      const age = f.introduced === null ? '' : f.introduced ? ' new' : ' pre-existing';
      lines.push(`  ${PAINT[f.severity](MARK[f.severity])} ${f.title}${at}`);
      lines.push(`    ${dim(`${f.standing}${age}  ${f.id}`)}`);
      for (const line of f.detail.split('\n')) lines.push(`    ${dim(line)}`);
    }
    lines.push('');
  }

  lines.push(...tail(result));
  return lines.join('\n');
}

export function json(result: RunResult): string {
  return JSON.stringify(
    { problem: result.problem, degraded: result.degraded, ...(result.build === undefined ? {} : { build: result.build }), comparedWith: result.comparedWith, grade: result.grade, pages: result.pages, apps: result.apps, ran: result.ran, skipped: result.skipped, findings: result.findings },
    null,
    2,
  );
}

export function worst(findings: Finding[]): 'error' | 'warn' | 'info' | null {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  if (findings.some((f) => f.severity === 'info')) return 'info';
  return null;
}
