import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const initial = process.env.PAGEBEAM_FIXTURES
  ? JSON.parse(await readFile(process.env.PAGEBEAM_FIXTURES, 'utf8')).notes
  : ['First note', 'Second note', 'Third note'];
if (!Array.isArray(initial) || !initial.every(note => typeof note === 'string')) throw new Error('fixtures must contain a notes array');
const users = new Map();
const sessions = new Map();
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || 'http://localhost:4300');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Content-Type', 'application/json');
  const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
  if (request.method === 'OPTIONS') return send(204, null);
  if (request.url === '/health') return send(200, { ready: true });
  let text = '';
  for await (const chunk of request) text += chunk;
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { return send(400, { error: 'Invalid JSON' }); }
  if (request.url === '/signup' && request.method === 'POST') {
    const username = `capture-${randomUUID()}`;
    const password = randomUUID();
    users.set(username, { password, notes: [...initial] });
    return send(201, { username, password });
  }
  if (request.url === '/login' && request.method === 'POST') {
    if (!users.has(body.username) || users.get(body.username).password !== body.password) return send(401, { error: 'Sign-in failed' });
    const token = randomUUID();
    sessions.set(token, body.username);
    return send(200, { token });
  }
  const user = users.get(sessions.get(request.headers.authorization?.replace(/^Bearer /, '')));
  if (!user) return send(401, { error: 'Sign in first' });
  if (request.url === '/notes' && request.method === 'GET') return send(200, { notes: user.notes });
  if (request.url === '/notes' && request.method === 'POST' && typeof body.title === 'string' && body.title.trim()) {
    user.notes.push(body.title.trim());
    return send(201, { notes: user.notes });
  }
  send(404, { error: 'Not found' });
});
server.listen(Number(process.env.API_PORT || 4301), '0.0.0.0');
