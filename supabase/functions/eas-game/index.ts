// Supabase Edge Function `eas-game`: the single authoritative entry point for online Arabic Scrabble.
//   POST { action, ...payload }   Authorization: Bearer <user JWT (anonymous sign-in is fine)>
// It authenticates the caller, then hands everything to the PURE core in ../_shared/core (unit-tested in Node), which uses the SAME
// rules, scoring and end-of-game settlement as the local game (mirrored from /js by tools/sync-edge-shared.mjs). There is no dictionary: Tahkim judges words.
// The service-role key lives only here (it is injected by Supabase); it never reaches a browser.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleRequest } from '../_shared/core/service.js';
import { SupabaseStore } from './store.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// ALLOWED_ORIGIN: one origin or a comma-separated list (e.g. https://my-game.vercel.app,https://game.example.com). Unset = any origin ('*'): fine for a first test, set it before real use.
const ALLOWED = (Deno.env.get('ALLOWED_ORIGIN') || '*').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const store = new SupabaseStore(db);

const corsFor = (req: Request) => {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED.includes('*') ? '*' : (ALLOWED.includes(origin) ? origin : ALLOWED[0] || '');
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};

const deps = {
  now: () => Date.now(),
  rng: () => { const a = new Uint32Array(2); crypto.getRandomValues(a); return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53; },   // 53 random bits, uniform in [0,1)
  uuid: () => crypto.randomUUID(),
  // Structured logs. Never rack contents, bag order, tokens or keys.
  log: (evt: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), evt, ...fields }))
};

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, code: 'BAD_REQUEST', message: 'POST only.' }, 405);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, code: 'NOT_MEMBER', message: 'الجلسة منتهية. أعد تحميل الصفحة.' }, 401);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return json({ ok: false, code: 'NOT_MEMBER', message: 'الجلسة منتهية. أعد تحميل الصفحة.' }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, code: 'BAD_REQUEST', message: 'طلب غير صالح.' }, 400); }
  // Domain errors are normal answers (HTTP 200 + ok:false): the browser never has to parse a platform error page.
  return json(await handleRequest(store, data.user.id, body, deps));
});
