// Local dev server: serves /public and routes /api/* to the Netlify functions using each
// function's own `config.path` — same routing as production. `npm run dev` → http://localhost:8888
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.chdir(ROOT);
const PORT = +process.env.PORT || 8888;
const routes = [];
for (const f of await fs.readdir('netlify/functions')) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'netlify/functions', f)));
  const paths = [].concat(mod.config?.path || `/.netlify/functions/${f.replace(/\.m?js$/, '')}`);
  for (const p of paths) routes.push({ re: new RegExp('^' + p.replace(/\*/g, '.*') + '$'), fn: mod.default });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes.find(r => r.re.test(url.pathname));
  try {
    if (route) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const t0 = Date.now(); const out = (await route.fn(request, {})) || new Response('', { status: 204 });
      const headers = Object.fromEntries(out.headers); const sc = out.headers.getSetCookie?.(); if (sc?.length) headers['set-cookie'] = sc;
      res.writeHead(out.status, headers); res.end(Buffer.from(await out.arrayBuffer()));
      if (!process.env.QUIET) console.log(req.method, url.pathname, out.status, Date.now() - t0 + 'ms');
      return;
    }
    let file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(path.join(ROOT, 'public'))) throw new Error('bad path');
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(e);
    res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(e.code === 'ENOENT' ? 'Not found' : 'Error');
  }
}).listen(PORT, () => console.log(`Trivium CRM dev server → http://localhost:${PORT}  (${routes.length} API routes)`));
