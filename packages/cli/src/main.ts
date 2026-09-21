#!/usr/bin/env node
import process from 'node:process';
import { json, pretty, run } from '@pagebeam/engine';

const USAGE = `pagebeam - find documentation that no longer matches the product

  pagebeam check [--cwd <dir>] [--json] [--profile observe|enforce]

  --cwd      directory holding pagebeam.config.* (default: current directory)
  --json     machine-readable output
  --profile  observe: report everything, block nothing (default)
             enforce: block on findings the evidence can prove

  exit 0  nothing blocks
  exit 1  a proven finding blocks, under enforce
  exit 2  the answer cannot be trusted: nothing was read, or a check that was
          asked for could not run
`;

interface Args {
  command: string;
  cwd: string;
  json: boolean;
  profile: 'observe' | 'enforce';
}

function parse(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? 'check', cwd: process.cwd(), json: false, profile: 'observe' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--cwd') args.cwd = argv[++i] ?? args.cwd;
    else if (a === '--profile') args.profile = argv[++i] === 'enforce' ? 'enforce' : 'observe';
  }
  return args;
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

if (result.problem !== null || result.degraded.length > 0) process.exit(2);
if (args.profile === 'enforce' && result.findings.some((f) => f.standing === 'proven')) {
  process.exit(1);
}
process.exit(0);
