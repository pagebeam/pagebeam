import { createServer, type IncomingMessage, type Server } from 'node:http';

// A small notes app: a login form, a page listing a user's notes, and an empty
// page. A new user can be made by posting to /signup, which is what a seed does.
export interface NotesApp {
  url: string;
  stop: () => Promise<void>;
}

const page = (body: string): string =>
  `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`;

const NAV = '<nav><a id="signout" href="/login">Sign out</a></nav>';

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

export async function notesApp(): Promise<NotesApp> {
  const users = new Map<string, { password: string; notes: string[] }>([
    ['ada', { password: 'pw-ada', notes: ['First note', 'Second note', 'Third note'] }],
    ['bo', { password: 'pw-bo', notes: [] }],
  ]);
  let made = 0;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const session = /session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = session === undefined ? undefined : users.get(session);
    const html = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(page(body));
    };

    if (url.pathname === '/signup' && req.method === 'POST') {
      made += 1;
      const username = `new${made}`;
      users.set(username, { password: `pw-${username}`, notes: [] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ username, password: `pw-${username}` }));
      return;
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const sent = await form(req);
      const who = users.get(sent.get('username') ?? '');
      if (who === undefined || who.password !== sent.get('password')) {
        html(401, '<p>Wrong username or password</p>');
        return;
      }
      res.writeHead(303, { location: '/notes', 'set-cookie': `session=${sent.get('username')}; Path=/` });
      res.end();
      return;
    }
    if (url.pathname === '/login' || url.pathname === '/') {
      html(
        200,
        '<form method="post" action="/login">' +
          '<input id="username" name="username"><input id="password" name="password" type="password">' +
          '<button id="submit">Sign in</button></form>',
      );
      return;
    }
    if (url.pathname === '/api/me') {
      res.writeHead(user === undefined ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(user === undefined ? {} : { name: session }));
      return;
    }
    if (user === undefined) {
      res.writeHead(303, { location: '/login' });
      res.end();
      return;
    }
    if (url.pathname === '/notes') {
      const list =
        user.notes.length === 0
          ? '<p class="empty">Nothing here yet</p>'
          : `<ul>${user.notes.map((n) => `<li class="note">${n}</li>`).join('')}</ul>`;
      html(
        200,
        NAV +
          '<h1>Notes</h1>' +
          list +
          '<button id="new" style="position:absolute;left:100px;top:50px;width:200px;height:40px">New note</button>' +
          '<div id="dialog" hidden><input id="title"><select id="kind"><option>plain</option><option>todo</option></select></div>' +
          '<script>document.getElementById("new").onclick=()=>{document.getElementById("dialog").hidden=false}</script>',
      );
      return;
    }
    if (url.pathname === '/empty') {
      html(200, `${NAV}<p>Nothing to show</p>`);
      return;
    }
    html(404, 'Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// The width and height a PNG declares in its header.
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
