import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import type { CaptureConfig, Tours } from '@pagebeam/core';

export interface SelectionRequest {
  journeys?: string[] | undefined;
  all?: boolean | undefined;
  changed?: string[] | undefined;
}

export interface Selection {
  journeys: { name: string; reasons: string[] }[];
  unmapped: string[];
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const exec = promisify(execFile);
  const { stdout: head } = await exec('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD']);
  const { stdout: baseSha } = await exec('git', ['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  if (!head.trim() || !baseSha.trim()) throw new Error('Git did not return the requested revisions');
  const { stdout } = await exec('git', [
    '-C', cwd, 'diff', '--name-status', '-z', '--find-renames', `${baseSha.trim()}...${head.trim()}`, '--',
  ], { maxBuffer: 16 << 20 });
  const fields = stdout.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++]!;
    const first = fields[i++];
    if (first) paths.push(first);
    if (/^[RC]/.test(status)) {
      const second = fields[i++];
      if (second) paths.push(second);
    }
  }
  return [...new Set(paths)];
}

export function selectJourneys(tours: Tours, capture: CaptureConfig | undefined, request: SelectionRequest): Selection {
  if (request.all !== undefined && typeof request.all !== 'boolean') throw new Error('all must be a boolean');
  for (const values of [request.journeys, request.changed]) {
    if (values !== undefined && (!Array.isArray(values) || !values.every(value => typeof value === 'string'))) throw new Error('journeys and changed paths must be arrays of strings');
  }
  if (request.all && request.journeys !== undefined) throw new Error('choose --all or named journeys, not both');
  for (const [name, group] of Object.entries(capture?.groups ?? {})) {
    for (const journey of group.journeys) {
      if (!Object.hasOwn(tours.journeys, journey)) throw new Error(`group ${name} names unknown journey ${journey}`);
    }
  }
  if (request.journeys !== undefined || request.all) {
    const names = request.all ? Object.keys(tours.journeys) : [...new Set(request.journeys)];
    for (const name of names) if (!Object.hasOwn(tours.journeys, name)) throw new Error(`unknown journey ${name}`);
    return { journeys: names.map(name => ({ name, reasons: [request.all ? 'explicit full suite' : 'explicit selection'] })), unmapped: [] };
  }
  if (request.changed === undefined) throw new Error('select journeys, --all, or --base/--changed-files before running');
  const selected = new Map<string, Set<string>>();
  const unmapped: string[] = [];
  for (const file of request.changed) {
    let mapped = false;
    const add = (name: string, reason: string): void => {
      mapped = true;
      const reasons = selected.get(name) ?? new Set<string>();
      reasons.add(reason);
      selected.set(name, reasons);
    };
    for (const [name, journey] of Object.entries(tours.journeys)) {
      if (picomatch.isMatch(file, journey.paths, { dot: true })) add(name, `path: ${file}`);
    }
    for (const [name, group] of Object.entries(capture?.groups ?? {})) {
      if (picomatch.isMatch(file, group.paths, { dot: true })) {
        for (const journey of group.journeys) add(journey, `group ${name}: ${file}`);
      }
    }
    if (!mapped) unmapped.push(file);
  }
  return { journeys: [...selected].map(([name, reasons]) => ({ name, reasons: [...reasons] })), unmapped };
}
