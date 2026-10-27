import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { impactSources, routeMatches, staticImpactAnalyzer, type ImpactAnalyzer } from '@pagebeam/app';
import { checkpointRoutes } from './checkpoints.js';
import type { PagebeamConfig } from '@pagebeam/core';
import { changedFiles, selectJourneys, type Selection, type SelectionRequest } from './selection.js';

export interface PlanRequest extends SelectionRequest { cwd: string; config: PagebeamConfig; base?: string | undefined }

export async function planCaptures(request: PlanRequest, analyzer: ImpactAnalyzer = staticImpactAnalyzer): Promise<Selection> {
  const { config, cwd } = request;
  if (!config.tours) throw new Error('no tours are configured');
  if (request.all || request.journeys !== undefined) {
    const selected = selectJourneys(config.tours, config.capture, request);
    return { ...selected, coverage: { status: 'manual', routes: [], ignored: [], reasons: ['Explicit selection; affected-screen coverage was not assessed.'] } };
  }
  let changed = request.changed ?? (request.base ? await changedFiles(cwd, request.base) : undefined);
  selectJourneys(config.tours, config.capture, { ...request, changed });
  if (request.base && request.changed === undefined) {
    const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--show-prefix']);
    const prefix = stdout.trim();
    if (prefix) {
      changed = changed!.map(file => file.startsWith(prefix) ? file.slice(prefix.length) : path.posix.relative(prefix, file));
    }
  }
  const options = config.capture?.impact;
  const root = path.resolve(cwd, options?.root ?? '.');
  let baseline: string | undefined;
  if (request.base) {
    const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${request.base}^{commit}`]);
    baseline = stdout.trim();
  }
  const relative = path.relative(cwd, root).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('impact root must be inside the capture checkout');
  const localChanges = (changed ?? []).map(file => path.posix.relative(relative || '.', file));
  const analysis = await analyzer.analyze({
    head: await impactSources(root),
    ...(baseline ? { base: await impactSources(root, baseline) } : {}),
    changed: localChanges,
    ...(options ? { ignore: options.ignore, global: options.global, routes: options.routes } : {}),
  });
  const reasons = [...analysis.reasons];
  const selected = new Map<string, Set<string>>();
  const routes = analysis.routes.map(affected => {
    const journeys = Object.entries(config.tours!.journeys).filter(([, journey]) => checkpointRoutes(journey).some(route => routeMatches(affected.route, route))).map(([name]) => name);
    for (const name of journeys) {
      const why = selected.get(name) ?? new Set<string>();
      for (const file of affected.files) why.add(`${file} affects ${affected.route}`);
      selected.set(name, why);
    }
    if (!journeys.length) reasons.push(`No screenshot checkpoint covers ${affected.route}. Add shot.route to a saved journey.`);
    if (affected.presence !== 'existing') reasons.push(`Route ${affected.route} is ${affected.presence}; an equivalent before-and-after journey is unavailable.`);
    return { ...affected, journeys };
  });
  for (const file of analysis.unknown) reasons.push(`Cannot establish UI impact for ${file}. Declare its routes or explicitly classify it as non-UI.`);
  const limit = options?.maxJourneys ?? 6;
  if (selected.size > limit) reasons.push(`Affected screens require ${selected.size} journeys, exceeding the automatic budget of ${limit}. Raise maxJourneys or request an explicit run.`);
  const status = reasons.length ? 'incomplete' : routes.length ? 'complete' : 'no-ui';
  return {
    journeys: [...selected].map(([name, why]) => ({ name, reasons: [...why] })),
    unmapped: analysis.unknown,
    coverage: { status, routes, ignored: analysis.ignored, reasons },
  };
}
