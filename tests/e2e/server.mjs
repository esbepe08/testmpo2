// Test server for the browser end-to-end run: serves the site AND stands in for Supabase.
// The REAL server core (supabase/functions/_shared/core) runs here on the in-memory store, so two real browsers play each other
// through exactly the code that runs in the Edge Function. /__api = the eas-game function, /__events = the realtime channel (polled).
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { MemoryStore } from '../online/memory-store.mjs';
import { handleRequest } from '../../supabase/functions/_shared/core/service.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const store = new MemoryStore(), seen = new Map(), metas = new Map();   // metas: the stand-in for realtime presence state (the real server never stores it)   // seen: "game|user" -> last poll time (presence)
const deps = { now: () => Date.now(), rng: Math.random, uuid: () => crypto.randomUUID(), log: () => {}, noDraw: true };   // noDraw: the host starts, so the tests know who moves first; /__draw?on=1 switches the real draw on
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__api' && req.method === 'POST') {
    const { user, body: b } = JSON.parse(await body(req));
    const out = await handleRequest(store, user, b, deps);
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
  }
  if (u.pathname === '/__track' && req.method === 'POST') { const d = JSON.parse(await body(req)); metas.set(d.game + '|' + d.user, d.meta); res.writeHead(204); return res.end(); }
  if (u.pathname === '/__draw') { deps.noDraw = u.searchParams.get('on') !== '1'; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__events') {
    const game = u.searchParams.get('game'), user = u.searchParams.get('user'), since = +u.searchParams.get('since') || 0;
    seen.set(game + '|' + user, Date.now());
    const events = store.events.map((e, i) => ({ ...e, i })).filter(e => e.game_id === game && e.i >= since);
    const presence = [...seen].filter(([k, t]) => k.startsWith(game + '|') && Date.now() - t < 2500).map(([k]) => k.split('|')[1]);
    const peerId = presence.find(x => x !== user), peer = peerId ? metas.get(game + '|' + peerId) || null : null;
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ events, next: store.events.length, presence, peer }));
  }
  let p = path.join(root, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) p = path.join(p, 'index.html');
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(p).pipe(res);
});
srv.listen(+process.env.PORT || 8765, () => console.log('ready'));
