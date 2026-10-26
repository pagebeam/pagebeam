import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const cli = process.env.PAGEBEAM_CLI;
if (!cli) throw new Error('Set PAGEBEAM_CLI to the built CLI entrypoint');
const child = spawn(process.execPath, [cli, 'session', '--environment', 'source', '--target', 'local', '--journey', 'notes'], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = new Promise(resolve => child.once('exit', code => resolve(code ?? 2)));
let id = 0;
const actions = [
  { method: 'step', action: { goto: '/notes' } },
  { method: 'observe' },
  { method: 'step', action: { expect: { selector: 'li.note', text: 'Second note' } } },
  { method: 'step', action: { shot: { name: 'review' } } },
  { method: 'finish' },
];
let next = 0;
for await (const line of createInterface({ input: child.stdout })) {
  const event = JSON.parse(line);
  if (event.event === 'finished') {
    process.stdout.write(JSON.stringify(event) + '\n');
    child.stdin.end();
    break;
  }
  if (event.error) { child.stdin.end(); throw new Error(event.error); }
  if (event.event === 'ready') next = 0;
  const action = actions[next++];
  if (action) child.stdin.write(JSON.stringify({ id: ++id, ...action }) + '\n');
}
process.exitCode = await exited;
