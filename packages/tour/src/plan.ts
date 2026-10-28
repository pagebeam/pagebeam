import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { impactSources, routeMatches, staticImpactAnalyzer, type ImpactAnalyzer } from '@pagebeam/app';
import { checkpointRoutes } from './checkpoints.js';
import type { PagebeamConfig, TourJourney } from '@pagebeam/core';
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
  const generated: Record<string, TourJourney> = {};
  const discovery = config.capture?.discovery;
  const account = discovery?.account ?? (Object.keys(config.tours.accounts).length === 1 ? Object.keys(config.tours.accounts)[0] : undefined);
  const routes = analysis.routes.map(affected => {
    const journeys = Object.entries(config.tours!.journeys).filter(([, journey]) => checkpointRoutes(journey).some(route => routeMatches(affected.route, route))).map(([name]) => name);
    for (const name of journeys) {
      const why = selected.get(name) ?? new Set<string>();
      for (const file of affected.files) why.add(`${file} affects ${affected.route}`);
      selected.set(name, why);
    }
    if (!journeys.length && discovery && affected.presence === 'existing') {
      let missing = false;
      const concrete = affected.route.replace(/:([A-Za-z0-9_]+)(\*)?/g, (_, name: string, rest: string | undefined) => {
        const parameter = discovery.parameters[name];
        if (parameter === undefined) { missing = true; return ':' + name; }
        return rest ? parameter.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(parameter);
      });
      if (!account || !Object.hasOwn(config.tours!.accounts, account)) reasons.push(`Automatic capture of ${affected.route} needs a configured discovery account`);
      else if (missing || /[:*?()]/.test(concrete)) reasons.push(`Automatic capture of ${affected.route} needs concrete discovery parameters`);
      else {
        const name = 'auto-' + createHash('sha256').update(affected.route).digest('hex').slice(0, 16);
        if (Object.hasOwn(config.tours!.journeys, name)) throw new Error(`Generated journey name conflicts with saved journey ${name}`);
        generated[name] = {
          account, paths: [], record: false,
          viewports: [{ name: 'desktop', width: 1440, height: 900, scale: 2 }],
          steps: [{ goto: concrete }, ...(discovery.ready ? [{ wait: discovery.ready }] : []), { shot: { name: 'screen', route: concrete, fullPage: false, focus: [] } }],
        };
        journeys.push(name);
        selected.set(name, new Set(affected.files.map(file => `${file} affects ${affected.route}`)));
      }
    }
    if (!journeys.length) reasons.push(`No screenshot checkpoint covers ${affected.route}. Configure discovery or add a saved journey.`);
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
    ...(Object.keys(generated).length ? { generated } : {}),
    coverage: { status, routes, ignored: analysis.ignored, reasons },
  };
}
