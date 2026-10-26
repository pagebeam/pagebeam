import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { history, routeMatches, type ImpactAnalyzer } from '@pagebeam/app';
import type { PagebeamConfig } from '@pagebeam/core';
import { selectViewports } from './viewports.js';
import { environment, StageFailure } from './environment.js';
import { CaptureSession, Incomplete, type StepResult } from './session.js';
import type { Selection, SelectionRequest } from './selection.js';
import { planCaptures } from './plan.js';
import { missingEnv } from './accounts.js';

export interface CaptureRequest extends SelectionRequest {
  cwd: string;
  config: PagebeamConfig;
  environment: string;
  target: string;
  viewports?: string[] | undefined;
  html?: boolean | undefined;
  out?: string | undefined;
  base?: string | undefined;
  captureRoutes?: string[] | undefined;
  impactAnalyzer?: ImpactAnalyzer | undefined;
  mode?: 'saved' | 'caller' | 'model' | undefined;
  purpose?: 'capture' | 'check' | 'both' | undefined;
  signal?: AbortSignal | undefined;
}

export interface JourneyResult {
  journey: string;
  viewport: string;
  size: { width: number; height: number; scale: number };
  status: 'running' | 'passed' | 'failed' | 'incomplete';
  steps: StepResult[];
  error?: string;
  assessment?: { by: 'caller' | 'model'; outcome: 'complete' | 'incomplete' };
}

export interface CaptureReport {
  schemaVersion: 1;
  id: string;
  revision: string | null;
  base: string | null;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'incomplete' | 'empty';
  stage: string;
  mode: 'saved' | 'caller' | 'model';
  purpose: 'capture' | 'check' | 'both';
  environment: string;
  backend?: { kind: string; revision: string | null; fixtureVersion: string | null; mocked: boolean };
  selection: Selection;
  results: JourneyResult[];
  errors: { stage: string; message: string }[];
}

export type CaptureDriver = (session: CaptureSession) => Promise<void>;

export async function explore(session: CaptureSession, choose: (observation: unknown) => Promise<unknown>): Promise<void> {
  for (;;) {
    const action = await choose(await session.observe());
    if (typeof action === 'object' && action !== null && 'finish' in action) {
      const finish = (action as { finish: unknown }).finish;
      if (finish === 'complete') return;
      throw new Incomplete('model could not complete the goal');
    }
    await session.step(action);
  }
}

const html = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export async function capture(request: CaptureRequest, driver?: CaptureDriver): Promise<{ directory: string; report: CaptureReport }> {
  const { config, cwd } = request;
  const id = randomUUID();
  const directory = path.resolve(cwd, request.out ?? '.pagebeam/runs', id);
  await mkdir(directory, { recursive: true });
  const report: CaptureReport = {
    schemaVersion: 1, id, revision: null, base: request.base ?? null,
    startedAt: new Date().toISOString(), status: 'running', stage: 'selection',
    mode: request.mode ?? 'saved', purpose: request.purpose ?? 'both', environment: request.environment,
    selection: { journeys: [], unmapped: [] }, results: [], errors: [],
  };
  const secrets = new Set<string>();
  for (const key of [...(config.capture?.redactEnv ?? []), ...Object.keys(process.env).filter(key => /password|secret|token|api.?key/i.test(key))]) {
    const value = process.env[key];
    if (value) secrets.add(value);
  }
  for (const account of Object.values(config.tours?.accounts ?? {})) {
    for (const key of [account.login.usernameEnv, account.login.passwordEnv]) if (key && process.env[key]) secrets.add(process.env[key]!);
  }
  const redact = (value: string): string => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      if (secret.length >= 4) value = value.split(secret).join('<REDACTED>');
      else value = value.replace(new RegExp(`(?<![\\w])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g'), '<REDACTED>');
    }
    return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1<REDACTED>@');
  };
  const literals = new Set(['id', 'status', 'stage', 'mode', 'purpose', 'kind', 'action', 'assertion', 'by', 'outcome', 'startedAt', 'finishedAt', 'journey', 'viewport', 'name', 'file']);
  function sanitize(value: unknown, key = ''): unknown {
    if (typeof value === 'string') return literals.has(key) ? value : redact(value);
    if (Array.isArray(value)) return value.map(item => sanitize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
    return value;
  }
  async function save(): Promise<void> {
    const current = sanitize(report) as CaptureReport;
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(current, null, 2) + '\n');
    if (!request.html) return;
    const results = current.results.map(result => `<section><h2>${html(result.journey)} / ${html(result.viewport)}: ${result.status}</h2>${result.steps.map(step => {
      const file = `${encodeURIComponent(result.journey)}/${encodeURIComponent(result.viewport)}/${encodeURIComponent(step.file ?? '')}`;
      return `<p>${step.step}: ${step.action} ${step.status}</p>${step.file ? `<a href="${file}"><img alt="${html(result.journey)} step ${step.step}" src="${file}"></a>` : ''}`;
    }).join('')}</section>`).join('');
    const selection = current.selection.journeys.map(journey => `<li>${html(journey.name)}: ${html(journey.reasons.join(', '))}</li>`).join('');
    const errors = current.errors.map(error => `<li>${html(error.stage)}: ${html(error.message)}</li>`).join('');
    await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pagebeam run</title><style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;padding:1rem}img{max-width:100%;border:1px solid #888}</style><h1>${current.status}</h1><p>Revision: ${html(current.revision ?? 'unknown')}</p><p>Backend: ${html(current.backend?.kind ?? 'not started')}${current.backend?.mocked ? ' (mocked)' : ''}</p><p><a href="report.json">Run report</a></p><h2>Selection</h2><ul>${selection}</ul><p>Unmapped changes: ${html(current.selection.unmapped.join(', '))}</p><ul>${errors}</ul>${results}</html>`);
  }
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  let managed: ReturnType<typeof environment> | undefined;
  try {
    signal.throwIfAborted();
    if (!['saved', 'caller', 'model'].includes(report.mode)) throw new Error('unknown execution style');
    if (!['capture', 'check', 'both'].includes(report.purpose)) throw new Error('unknown run purpose');
    if (!config.tours) throw new Error('no tours are configured');
    const tours = config.tours;
    report.revision = await history.head(cwd);
    report.selection = await planCaptures(request, request.impactAnalyzer);
    signal.throwIfAborted();
    if (report.selection.coverage?.status === 'incomplete') {
      report.status = 'incomplete';
      report.errors.push(...report.selection.coverage.reasons.map(message => ({ stage: 'selection', message })));
    } else if (!report.selection.journeys.length) { report.status = 'empty'; }
    else {
    for (const { name } of report.selection.journeys) {
      selectViewports(tours.journeys[name]!, request.viewports);
      if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('journey names must be safe directory names');
      if (report.mode !== 'saved' && !tours.journeys[name]!.explore) throw new Error(`journey ${name} needs an exploration goal and policy`);
      if (report.mode === 'saved' && !tours.journeys[name]!.steps.length) throw new Error(`journey ${name} needs saved steps`);
    }
    if (!tours.targets[request.target]) throw new Error(`unknown target ${request.target}`);
    const configured = config.capture?.environments[request.environment];
    if (!configured) throw new Error(`unknown capture environment ${request.environment}`);
    report.revision = configured.frontendRevision ?? (configured.frontend ? await history.head(path.resolve(cwd, configured.frontend.path)) || null : null);
    if (report.mode !== 'saved' && !configured.disposable && report.selection.journeys.some(({ name }) => tours.journeys[name]!.explore!.allowChanges)) {
      throw new Error('data-changing exploration requires disposable test data');
    }
    for (const [key, value] of Object.entries(configured.env)) if (value && /secret|token|password|api.?key/i.test(key)) secrets.add(value);
    managed = environment(configured, cwd, id, directory, signal);
    for (const { name } of report.selection.journeys) {
      const journey = tours.journeys[name]!;
      for (const key of missingEnv(tours.accounts[journey.account]!, managed.env)) throw new StageFailure('environment', `required variable ${key} is not set`);
      for (const step of journey.steps) {
        const key = 'fill' in step ? step.fill.valueEnv : 'type' in step && typeof step.type !== 'string' ? step.type.valueEnv : undefined;
        if (key && !managed.env[key]) throw new StageFailure('environment', `required variable ${key} is not set`);
      }
    }
    report.backend = managed.metadata;
    report.stage = 'environment';
    await save();
    await managed.start();
    for (const { name } of report.selection.journeys) {
      const journey = tours.journeys[name]!;
      for (const viewport of selectViewports(journey, request.viewports)) {
        const result: JourneyResult = { journey: name, viewport: viewport.name, size: { width: viewport.width, height: viewport.height, scale: viewport.scale }, status: 'running', steps: [] };
        report.results.push(result);
        report.stage = 'journey';
        const session = new CaptureSession({
          cwd, tours, journey, name, target: request.target, viewport, out: path.join(directory, name, viewport.name),
          mode: report.mode, purpose: report.purpose, disposable: configured.disposable,
          captureRoutes: request.captureRoutes ?? (report.selection.coverage?.status === 'complete' ? report.selection.coverage.routes.map(route => route.route) : undefined),
          mask: config.capture?.mask ?? [], signal, env: managed.env, redact, registerSecret: value => { if (value) secrets.add(value); },
          onStep: async step => { result.steps.push(step); await save(); },
        });
        try {
          await session.start();
          if (report.mode === 'saved') {
            if (!journey.steps.length) throw new Error('saved execution needs declared steps');
            for (const step of journey.steps) await session.step(step);
          } else {
            if (!driver) throw new Error('exploration needs a driver');
            await driver(session);
            result.assessment = { by: report.mode, outcome: 'complete' };
          }
          result.status = result.steps.some(step => step.status === 'failed') ? 'failed' : 'passed';
        } catch (error) {
          result.status = error instanceof Incomplete || signal.aborted ? 'incomplete' : 'failed';
          if (report.mode !== 'saved') result.assessment = { by: report.mode, outcome: 'incomplete' };
          result.error = redact(error instanceof Error ? error.message : String(error));
          report.errors.push({ stage: error instanceof StageFailure ? error.stage : 'journey', message: result.error });
        } finally {
          await session.close().catch(error => { result.status = 'failed'; report.errors.push({ stage: 'recording', message: redact(error instanceof Error ? error.message : String(error)) }); });
          await save();
        }
        signal.throwIfAborted();
      }
    }
    if (report.selection.coverage?.status === 'complete') {
      for (const route of report.selection.coverage.routes) {
        const viewports = new Set(route.journeys.flatMap(name => selectViewports(tours.journeys[name]!, request.viewports).map(viewport => viewport.name)));
        for (const viewport of viewports) {
          const captured = report.results.some(result => result.viewport === viewport && result.steps.some(step => step.action === 'shot' && step.status === 'passed' && step.route && routeMatches(route.route, step.route) && (request.purpose === 'check' || step.file)));
          if (!captured) {
            report.selection.coverage.status = 'incomplete';
            const message = `No verified screenshot of ${route.route} at ${viewport} was captured.`;
            report.selection.coverage.reasons.push(message);
            report.errors.push({ stage: 'coverage', message });
          }
        }
      }
    }
    report.status = report.results.some(result => result.status === 'failed') ? 'failed' : report.results.some(result => result.status === 'incomplete') ? 'incomplete' : report.selection.coverage?.status === 'incomplete' ? 'incomplete' : 'passed';
    }
  } catch (error) {
    report.status = signal.aborted || error instanceof Incomplete ? 'incomplete' : 'failed';
    report.errors.push({ stage: error instanceof StageFailure ? error.stage : report.stage, message: redact(error instanceof Error ? error.message : String(error)) });
  } finally {
    report.stage = 'cleanup';
    try { await managed?.close(); }
    catch (error) { report.status = 'failed'; report.errors.push({ stage: 'cleanup', message: redact((error as Error).message) }); }
    if (report.selection.coverage?.status === 'complete' && report.status !== 'passed') {
      report.selection.coverage.status = 'incomplete';
      report.selection.coverage.reasons.push('Affected-screen capture did not complete successfully.');
    }
    report.stage = 'finished';
    report.finishedAt = new Date().toISOString();
    await save();
  }
  return { directory, report: sanitize(report) as CaptureReport };
}
