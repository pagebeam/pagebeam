#!/usr/bin/env node
import process from 'node:process';
import { json, pretty, run, worst } from '@pagebeam/engine';

const USAGE = `pagebeam - find documentation that no longer matches the product

  pagebeam check [--cwd <dir>] [--json] [--fail-on error|warn|any|none]

  --cwd      directory holding pagebeam.config.* (default: current directory)
  --json     machine-readable output
  --fail-on  exit non-zero at this severity or worse (default: error)
`;

interface Args {
  command: string;
  cwd: string;
  json: boolean;
  failOn: string;
}

function parse(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? 'check', cwd: process.cwd(), json: false, failOn: 'error' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--cwd') args.cwd = argv[++i] ?? args.cwd;
    else if (a === '--fail-on') args.failOn = argv[++i] ?? args.failOn;
  }
  return args;
}

function shouldFail(failOn: string, severity: string | null): boolean {
  if (severity === null || failOn === 'none') return false;
  if (failOn === 'any') return true;
  if (failOn === 'warn') return severity === 'error' || severity === 'warn';
  return severity === 'error';
}

const args = parse(process.argv.slice(2));

if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (args.command !== 'check') {
  process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
  process.exit(2);
}

const result = await run(args.cwd);
process.stdout.write((args.json ? json(result) : pretty(result)) + '\n');

if (result.problem !== null) process.exit(2);
process.exit(shouldFail(args.failOn, worst(result.findings)) ? 1 : 0);
