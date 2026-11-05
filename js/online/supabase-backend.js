// The ONLY file that talks to Supabase from the browser. supabase-js is loaded on demand (never for local play), pinned to an exact version.
// Backend contract used by session.js (tests substitute their own through window.EAS_BACKEND_FACTORY):
//   init()                    -> userId         (anonymous sign-in; the session is persisted by supabase-js, so a refresh keeps the identity)
//   call(body)                -> response json  (the eas-game Edge Function)
//   subscribe(gameId, h)      -> { close() }   h = { onEvent(payload), onStatus('SUBSCRIBED'|'ERROR'|'CLOSED'), onPresence(userIds[], peerState|null), oppId?() -> the opponent's player id }
//   track(patch)              -> merge `patch` into my presence state and announce it (coalesced). Presence carries small PUBLIC hints only: my seat, the revision I have seen
//                                (a peer that sees a newer one than its own fetches a snapshot, which heals a missed event) and the tiles I am trying (live preview).
//                                It is the one realtime path every member is already authorised for, so nothing here needs a policy of its own.
// Every failure that leaves this file carries `info = { code, text, detail }`: `text` is a plain Arabic sentence that says WHAT to fix (see explain()), `detail` is
// the technical line to show underneath it (and to paste into a bug report).
import { ONLINE_ENV } from './env.js';

export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
export const isConfigured = () => !!(window.EAS_BACKEND_FACTORY || (ONLINE_ENV.url && ONLINE_ENV.anonKey));

// Turns a low-level failure into the sentence a person can act on. `where`: 'lib' (loading supabase-js), 'auth' (anonymous sign-in), 'fn' (the Edge Function).
export function explain(e, where = '') {
  const raw = String(e?.message || e || ''), code = String(e?.code || e?.error_code || ''), status = e?.status ?? e?.context?.status ?? null, name = String(e?.name || '');
  const detail = [where, name, code, status, raw].filter(x => x !== '' && x !== null).join(' · ').slice(0, 180);
  const out = (c, text, retry = false) => ({ code: c, text, detail, retry });
  const all = `${name} ${code} ${raw}`;
  if (where === 'lib' || /dynamically imported module|importing a module script|Failed to resolve module/i.test(raw))
    return out('lib', 'تعذّر تحميل مكتبة Supabase. تحقق من الإنترنت ثم أعد المحاولة.', true);
  if (/anonymous.*(disabled|not enabled)|anonymous_provider_disabled/i.test(all))
    return out('anonymous_disabled', 'تسجيل الدخول المجهول مغلق في Supabase. فعّل «Allow anonymous sign-ins» من: Authentication ← Sign In / Providers.');
  if (/invalid api key|invalid jwt|bad_jwt|no api key|apikey/i.test(all) || (where === 'auth' && (status === 401 || status === 403)))
    return out('bad_key', 'مفتاح Supabase العام (SUPABASE_ANON_KEY) غير صحيح. انسخه من Project Settings ← API ثم أعد النشر.');
  if (/FunctionsHttpError/.test(name) && (status === 404 || /not found/i.test(raw)))
    return out('fn_missing', 'الدالة eas-game غير منشورة في مشروع Supabase. انشرها بالأمر: supabase functions deploy eas-game', false);
  if (/FunctionsHttpError/.test(name) && status === 401)
    return out('fn_auth', 'رفضت الدالة جلستك. أعد تحميل الصفحة، فإن تكرر فتحقق من إعداد تسجيل الدخول المجهول والمفتاح العام.');
  if (/FunctionsHttpError/.test(name))
    return out('fn_error', 'حدث خطأ داخل الدالة eas-game. راجع Supabase ← Edge Functions ← Logs.', true);
  if (/Failed to fetch|NetworkError|Load failed|FunctionsFetchError|FunctionsRelayError|AuthRetryableFetchError|status.?0/i.test(all) || status === 0)
    return out('network', where === 'fn'
      ? 'تعذّر الوصول إلى الدالة eas-game. تحقق من الإنترنت، ومن أن الدالة منشورة، ومن قيمة ALLOWED_ORIGIN إن كنت قد ضبطتها.'
      : 'تعذّر الوصول إلى Supabase. تحقق من الإنترنت، ومن رابط المشروع (SUPABASE_URL)، ومن أن المشروع غير متوقف.', true);
  return out('unknown', 'تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.', true);
}
const tag = (e, where) => Object.assign(e instanceof Error ? e : new Error(String(e)), { info: explain(e, where) });

export async function createBackend() {
  if (window.EAS_BACKEND_FACTORY) return window.EAS_BACKEND_FACTORY();
  let createClient;
  try { ({ createClient } = await import(SUPABASE_JS)); } catch (e) { throw tag(e, 'lib'); }
  const sb = createClient(ONLINE_ENV.url, ONLINE_ENV.anonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'eas.online.auth' } });
  let userId = null, channel = null, info = {}, pushTimer = 0;
  const push = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => { try { channel?.track(info)?.catch?.(() => {}); } catch { /* presence is only a hint */ } }, 120); };
  return {
    async init() {
      try {
        let { data: { session } } = await sb.auth.getSession();
        if (!session) { const r = await sb.auth.signInAnonymously(); if (r.error) throw r.error; session = r.data.session; }
        userId = session.user.id; return userId;
      } catch (e) { throw tag(e, 'auth'); }
    },
    async call(body) {
      const { data, error } = await sb.functions.invoke('eas-game', { body });
      if (error) { const x = explain(error, 'fn'); throw Object.assign(new Error(x.code), { network: true, final: !x.retry, info: x }); }
      return data;
    },
    async subscribe(gameId, h) {
      await sb.realtime.setAuth();
      const ch = sb.channel('game:' + gameId, { config: { private: true, presence: { key: userId }, broadcast: { self: false } } });
      ch.on('broadcast', { event: '*' }, m => h.onEvent?.(m.payload || {}))
        .on('presence', { event: 'sync' }, () => {
          const st = ch.presenceState(), oppId = h.oppId?.() || null;
          // When the opponent's id is known only their own key counts (a client can announce itself under any key); before that, any other key is taken as before.
          const ids = oppId ? Object.keys(st).filter(k => k === userId || k === oppId) : Object.keys(st), other = oppId ? (st[oppId] ? oppId : null) : ids.find(k => k !== userId), metas = other ? st[other] : [];
          h.onPresence?.(ids, metas.length ? metas[metas.length - 1] : null);
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') { h.onStatus?.('SUBSCRIBED'); try { ch.track(info); } catch { /* retried by the next track() */ } }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') h.onStatus?.('ERROR');
          else if (status === 'CLOSED') h.onStatus?.('CLOSED');
        });
      channel = ch;
      return { close: () => { try { sb.removeChannel(ch); } catch { /* already gone */ } if (channel === ch) channel = null; } };
    },
    track(patch) { info = { ...info, ...patch }; if (channel) push(); }
  };
}
