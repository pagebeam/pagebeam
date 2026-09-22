#!/usr/bin/env node
import process from 'node:process';
import { json, pretty, run } from '@pagebeam/engine';
import { propose } from './propose.js';

const USAGE = `pagebeam - find documentation that no longer matches the product

  pagebeam check [--cwd <dir>] [--json] [--profile observe|enforce]
  pagebeam fix   [--cwd <dir>] [--publish]

  --cwd      directory holding pagebeam.config.* (default: current directory)
  --json     machine-readable output
  --publish  actually open or update the pull request. Without it, fix says
             what it would propose and touches nothing
  --profile  observe: report everything, block nothing (default)
             enforce: block on proven findings this change introduced.
                      A finding of unknown age never blocks here
             enforce-all: block on any proven finding, whatever its age

  exit 0  nothing blocks
  exit 1  a proven finding blocks, under an enforcing profile
  exit 2  the answer cannot be trusted: nothing was read, or a check that was
          asked for could not run
`;

interface Args {
  command: string;
  cwd: string;
  json: boolean;
  publish: boolean;
  profile: 'observe' | 'enforce' | 'enforce-all';
}

const PROFILES = new Set(['observe', 'enforce', 'enforce-all']);

class BadUsage extends Error {}

function parse(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'check',
    cwd: process.cwd(),
    json: false,
    publish: false,
    profile: 'observe',
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') args.json = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--cwd') {
      const value = argv[++i];
      if (value === undefined) throw new BadUsage('--cwd needs a directory');
      args.cwd = value;
    } else if (a === '--profile') {
      const value = argv[++i];
      if (value === undefined || !PROFILES.has(value)) {
        throw new BadUsage(`--profile must be one of ${[...PROFILES].join(', ')}`);
      }
      args.profile = value as Args['profile'];
    } else throw new BadUsage(`unknown option: ${a}`);
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

if (args.command !== 'check' && args.command !== 'fix') {
  process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
  process.exit(2);
}

const result = await run(args.cwd);

if (args.command === 'fix') {
  try {
    const outcome = await propose(args.cwd, result, args.publish);
    process.stdout.write(outcome.said + '\n');
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
