#!/usr/bin/env node
import process from 'node:process';
import { json, pretty, run } from '@pagebeam/engine';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFor, discover, readIfPresent } from '@pagebeam/engine';
import { propose } from './propose.js';

const USAGE = `pagebeam - find documentation that no longer matches the product

  pagebeam check [--cwd <dir>] [--json] [--profile observe|enforce] [--build]
  pagebeam fix   [--cwd <dir>] [--publish] [--build]
  pagebeam init  [--cwd <dir>]
  pagebeam shoot [--cwd <dir>] [--target <name>] [--journey <name>] [--out <dir>]
                 [--narration <file>] [--json]
  pagebeam capture --environment <name> --target <name>
                   [--journey <name> ... | --base <ref> | --changed-files <json> | --all]
                   [--mode saved|model] [--purpose capture|check|both] [--plan] [--out <dir>] [--json]
                   [--config <file>] [--compare-environment <name> --compare-target <name>]
  pagebeam session <capture options>    caller-directed JSON lines on stdin/stdout

  --cwd      directory holding pagebeam.config.* (default: current directory)
  --json     machine-readable output
  --config   capture/session: explicit configuration file; paths stay relative to --cwd
  --build    build the docs site first, as its project builds it, and check
             links against the pages it publishes. Installs its dependencies
             from the lockfile when they are missing. This runs the site's
             own code. A build that fails exits 2
  --build=auto
             build only a docs site of its own whose framework is
             recognised, and say why not otherwise
  --publish  actually open or update the pull request. Without it, fix says
             what it would propose and touches nothing
  --target   shoot: the tours target to open (default: local, else the first)
  --journey  shoot: follow only this journey (default: every journey)
  --out      shoot: where screenshots go (default: .pagebeam/shots), as
             <out>/<target>/<journey>/NN-<shot>.<viewport>.png with a
             manifest.json beside them. A journey with record set also
             leaves recording.<viewport>.mp4 and its timeline in the manifest
  --narration
             shoot: a JSON file of how long the voice over for each step
             lasts, {"journey": {"step": ms}}, so a recording holds each
             step until its line is said
  --profile  observe: report everything, block nothing (default)
             enforce: block on proven findings this change introduced.
                      A finding of unknown age never blocks here
             enforce-all: block on any proven finding, whatever its age

  exit 0  nothing blocks
  exit 1  a proven finding blocks, under an enforcing profile
  exit 2  the answer cannot be trusted: nothing was read, or a check that was
          asked for could not run

  shoot exits 1 when an account is not ready or a step fails, and 2 when
  nothing could be shot: no tours, an unknown target or journey, an unset
  variable, or no browser or ffmpeg to drive
`;

interface Args {
  command: string;
  cwd: string;
  json: boolean;
  publish: boolean;
  build: 'always' | 'auto' | undefined;
  profile: 'observe' | 'enforce' | 'enforce-all';
  target: string | undefined;
  journey: string | undefined;
  out: string | undefined;
  narration: string | undefined;
  environment: string | undefined;
  mode: string | undefined;
  purpose: string | undefined;
  base: string | undefined;
  changedFiles: string | undefined;
  requestedJourneys: string[];
  all: boolean;
  plan: boolean;
  compareEnvironment: string | undefined;
  compareTarget: string | undefined;
  configFile: string | undefined;
}

const PROFILES = new Set(['observe', 'enforce', 'enforce-all']);

class BadUsage extends Error {}

function parse(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'check',
    cwd: process.cwd(),
    json: false,
    publish: false,
    build: undefined,
    profile: 'observe',
    target: undefined,
    journey: undefined,
    out: undefined,
    narration: undefined,
    environment: undefined, mode: undefined, purpose: undefined, base: undefined,
    changedFiles: undefined, requestedJourneys: [], all: false, plan: false,
    compareEnvironment: undefined, compareTarget: undefined,
    configFile: undefined,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') args.json = true;
    else if (a === '--all') args.all = true;
    else if (a === '--plan') args.plan = true;
    else if (['--environment', '--mode', '--purpose', '--base', '--changed-files', '--compare-environment', '--compare-target', '--config'].includes(a!)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new BadUsage(`${a} needs a value`);
      if (a === '--changed-files') args.changedFiles = value;
      else if (a === '--config') args.configFile = value;
      else if (a === '--compare-environment') args.compareEnvironment = value;
      else if (a === '--compare-target') args.compareTarget = value;
      else args[a!.slice(2) as 'environment' | 'mode' | 'purpose' | 'base'] = value;
    }
    else if (a === '--publish') args.publish = true;
    else if (a === '--build') args.build = 'always';
    else if (a === '--build=auto') args.build = 'auto';
    else if (a === '--cwd') {
      const value = argv[++i];
      if (value === undefined) throw new BadUsage('--cwd needs a directory');
      args.cwd = value;
    } else if (a === '--target' || a === '--journey' || a === '--out' || a === '--narration') {
      const value = argv[++i];
      if (value === undefined) throw new BadUsage(`${a} needs a value`);
      args[a.slice(2) as 'target' | 'journey' | 'out' | 'narration'] = value;
      if (a === '--journey') args.requestedJourneys.push(value);
    } else if (a === '--profile') {
      const value = argv[++i];
      if (value === undefined || !PROFILES.has(value)) {
        throw new BadUsage(`--profile must be one of ${[...PROFILES].join(', ')}`);
      }
      args.profile = value as Args['profile'];
    } else throw new BadUsage(`unknown option: ${a}`);
  }
  const capturing = args.command === 'capture' || args.command === 'session';
  if (!capturing && (args.environment !== undefined || args.mode !== undefined || args.purpose !== undefined || args.base !== undefined || args.changedFiles !== undefined || args.compareEnvironment !== undefined || args.compareTarget !== undefined || args.configFile !== undefined || args.all || args.plan)) {
    throw new BadUsage('capture options require the capture or session command');
  }
  if (capturing && (args.build !== undefined || args.publish || args.narration !== undefined || argv.includes('--profile'))) {
    throw new BadUsage('capture and session do not accept documentation or narration options');
  }
  return args;
}

let args: Args;
try {
  args = parse(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}

if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

// Writing the configuration by looking at the repository, so trying this does
// not begin with reading about how to describe one.
if (args.command === 'init') {
  const at = path.join(args.cwd, 'pagebeam.config.yaml');
  if (await readIfPresent(at) !== null) {
    process.stderr.write('pagebeam.config.yaml is already there. Nothing was written.\n');
    process.exit(2);
  }

  // Asked where somebody is there to answer. A pipe, or a job on a machine, is
  // told what was worked out instead of being waited on.
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const { askFor } = await import('./ask.js');
    await writeFile(at, await askFor(args.cwd));
    process.exit(0);
  }

  const found = await discover(args.cwd);
  await writeFile(at, configFor(found));

  const said = [`Wrote pagebeam.config.yaml`];
  said.push(
    found.docs === null
      ? '  docs: nothing written in a documentation format was found, so docs.root is a guess'
      : `  docs: ${found.docs.root}, ${found.docs.pages} page(s)`,
  );
  for (const app of found.apps) said.push(`  app:  ${app.name} at ${app.path}, ${app.routes} route(s)`);
  if (found.apps.length === 0) {
    said.push('  app:  none found. Add one, or only the documentation can be checked against itself');
  }
  said.push('', 'Read it, then run: pagebeam check');
  process.stdout.write(said.join('\n') + '\n');
  process.exit(0);
}

if (args.command === 'capture' || args.command === 'session') {
  const { captureCommand } = await import('./capture.js');
  process.exit(await captureCommand(args.cwd, args, args.command === 'session'));
} else if (args.command === 'shoot') {
  const { shootCommand } = await import('./shoot.js');
  const outcome = await shootCommand(args.cwd, args);
  process.stdout.write(outcome.out);
  process.stderr.write(outcome.err);
  process.exit(outcome.code);
}

if (args.command !== 'check' && args.command !== 'fix') {
  process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
  process.exit(2);
}

// Only a run that will propose something has a reason to draft it.
const result = await run(args.cwd, { proposing: args.command === 'fix', build: args.build });

// Guessing where the documentation is and then reporting a clean run tells
// somebody their documentation is fine when nothing read it.
if (result.problem !== null && result.configFrom === null) {
  const found = await discover(args.cwd);
  process.stderr.write(
    [
      'No pagebeam.config.yaml here, so there is nothing to check documentation against.',
      '',
      'Run: pagebeam init',
      '',
      'It would write:',
      '',
      configFor(found).split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n'),
    ].join('\n'),
  );
  process.exit(2);
}

if (args.command === 'fix') {
  try {
    const outcome = await propose(args.cwd, result, args.publish);
    const notes = result.skipped.filter((note) => note.startsWith('model:'));
    process.stdout.write([...notes, outcome.said].join('\n') + '\n');
    process.exit(outcome.code);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nNothing was proposed.\n`);
    process.exit(2);
  }
}

process.stdout.write((args.json ? json(result) : pretty(result)) + '\n');

if (result.problem !== null || result.degraded.length > 0) process.exit(2);
const blocking = result.findings.filter(
  (f) =>
    f.standing === 'proven' &&
    (args.profile === 'enforce-all' || f.introduced === true),
);
if (args.profile !== 'observe' && blocking.length > 0) process.exit(1);
process.exit(0);
