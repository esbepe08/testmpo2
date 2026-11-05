# Online multiplayer: setup from zero

You need: a free [Supabase](https://supabase.com) account, your existing Vercel project, Node 20+ on your computer, and the repository checked out.
Nothing below is optional unless it says so. Local play keeps working before, during and after this setup.

> Not verified against a live Supabase project: this repository was developed and tested without access to one (see
> `ONLINE_IMPLEMENTATION_REPORT.md`, "Known limitations"). Follow step 11 in order the first time; section 12 lists what to check if something fails.

## 1. Create the Supabase project
1. supabase.com → **New project**. Pick a region near your players, set a database password (store it in a password manager; the game never needs it).
2. Wait until the project is ready.

## 2. Project URL
**Project Settings → API → Project URL**, e.g. `https://abcdefghijklmno.supabase.co`. This is `SUPABASE_URL`. The part before `.supabase.co` is the **project ref**.

## 3. Public key
Same page → **Project API keys** → the key labelled **anon / public** (or **publishable** in the newer UI). This is `SUPABASE_ANON_KEY`.
Do **not** use `service_role` / `secret`. (`tools/write-env.mjs` refuses to build if it recognises a service-role key.)

## 4. Anonymous sign-ins (players never register)
**Authentication → Sign In / Providers → Anonymous Sign-Ins → enable.**
Recommended: **Authentication → Attack Protection → enable CAPTCHA** so bots cannot mass-create anonymous users.

## 5. Install the CLI and link the project
```bash
npm install -g supabase            # or: npx supabase ...
supabase login
supabase link --project-ref YOUR_PROJECT_REF     # asks for the database password from step 1
```

## 6. Apply the migrations (tables, constraints, RLS, functions, realtime trigger)
```bash
supabase db push
```
This runs, in order, `supabase/migrations/20261024000001_eas_online_schema.sql`, `…02_eas_online_security.sql`, `…03_eas_online_functions.sql`, `…04_eas_v5_no_validator_abandon.sql`, `…05_eas_v5_1_pause_undo_live.sql` (adds `games.ext`: the pause / undo / live-preview state), `…06_eas_v5_2_drop_draft_policy.sql` (removes a permission an early copy of 05 granted and nothing needs any more), `…07_eas_v5_4_hardening.sql` (one open game per player enforced by the database; clean-up of old anonymous players; re-schedules both clean-ups when `pg_cron` is enabled).
Everything (tables, indexes, RLS policies, the commit/create functions, the realtime trigger, the cleanup function) is in those files; there is nothing to click in the dashboard.

## 7. Row Level Security
Already enabled by migration 02 on all six tables. Verify: **Table Editor → each table → "RLS enabled"** is shown, and **Authentication → Policies** lists:
`members read their game`, `members read game players`, `members read game moves`, `owner reads own rack` (public schema) and
`members receive game channel`, `members track presence`, (realtime schema). Browsers can never publish broadcasts: only the server does. The live preview of tentative tiles travels in the sender's *presence* state, which members may already track. `game_private` and `game_actions` must have **no** policies.

## 8. Realtime
1. **Realtime → Settings**: make sure **"Allow public access"** is **OFF** (so only authorised private channels work; the game uses private channels `game:<id>`).
2. Nothing else: the migration installs a trigger that calls `realtime.send(...)` after each committed revision, and the RLS policies above authorise members.

## 9. Deploy the Edge Function and set its secret
```bash
supabase secrets set ALLOWED_ORIGIN=https://YOUR-SITE.vercel.app   # several sites: comma-separated; unset = any origin (first test only)
supabase functions deploy eas-game
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function by Supabase itself. You never copy the service-role key anywhere.
There is **no dictionary** to host: words are judged by the players (Tahkim), so the function needs no `ASSET_BASE_URL` and no site assets.
The function code imports `supabase/functions/_shared/game/*`, a generated mirror of `js/config.js`, `js/modes.js` and `js/rules.js`. After changing any of
those three, run `node tools/sync-edge-shared.mjs` and redeploy the function (the test-suite fails if the mirror is stale).

## 10. Vercel
1. Vercel → your project → **Settings → Environment Variables**: add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Production + Preview). Nothing else.
2. **Settings → Build & Development**: Framework Preset **Other**; Build Command `node tools/write-env.mjs && node tools/stamp-sw.mjs && node tools/build-dist.mjs`; Output Directory `dist` (the repository's `vercel.json` already says this). Only `dist/` is published: `supabase/`, `tests/`, `docs/` and `tools/` are not reachable from the site.
3. **Deployments → Redeploy** (env variables only apply to new builds).

## 11. Test with two devices
1. Device A (phone, mobile data): open the site → **ONLINE** → nickname → **إنشاء غرفة**. Note the 6-character code.
2. Device B (laptop, home Wi-Fi: a different network is fine): open the site → **ONLINE** → nickname → type the code → **انضمام**.
3. B presses **أنا جاهز**; A presses **ابدأ المباراة** (A can also use **مشاركة رابط**). Each device shows only its own tiles.
4. Play a few moves, one pass, one swap. Refresh A's page mid-game: it returns to the same match. Switch B to airplane mode for ten seconds: A sees B as "غير متصل", B recovers by itself.
5. Abandon claim: close B's tab while it is B's turn. A sees "بانتظار عودته…" with a countdown; after 5 minutes the button **إنهاء المباراة والفوز** becomes active and ends the match in A's favour.
6. Share link variant: `https://YOUR-SITE.vercel.app/?room=K7Q4P2` opens the join screen with the code filled in.

Optional, recommended: **Database → Extensions → pg_cron → enable**, then run migration 03's last block once more (or `select cron.schedule('eas-cleanup-stale-games','17 * * * *','select public.eas_cleanup_stale_games()');`) to clean up stale rooms hourly.

## 12. Upgrading an existing project to this build
`supabase db push` applies migration `20261031000004_eas_v5_no_validator_abandon.sql` (turns the legacy `validator_mode` column off for every room, new rooms default to off). Then redeploy the function (`supabase functions deploy eas-game`) and redeploy the site. You may delete the old `ASSET_BASE_URL` secret (`supabase secrets unset ASSET_BASE_URL`). Do not deploy the new site before the function: the new page sends `heartbeat`, which an old function answers with `BAD_REQUEST` (harmless, but the abandon claim needs the new function).

## 12b. Upgrading from v5 to v5.1 (pause, undo with approval, live preview)
Order matters: **1.** `supabase db push` (migrations `…05`, `…06`, `…07`), **2.** `supabase functions deploy eas-game`, **3.** deploy the site. The new page asks for `games.ext` fields that only the new function writes; an old page keeps working with the new function (it just does not show the new buttons). If the migration was skipped, creating a room answers *"قاعدة البيانات غير جاهزة…"* instead of a generic error. The page `pwa-check.html` (also linked from Settings → التطبيق) tests the install conditions, the Supabase URL/key and whether the function is deployed.

## 13. Common problems
| Symptom | Cause / fix |
|---|---|
| "اللعب عبر الإنترنت غير مُهيَّأ" | Vercel env vars missing or you did not redeploy after adding them. Check `js/online/env.js` in the deployed site is non-empty. |
| A specific message (anonymous sign-ins off / wrong key / function not deployed / project paused) | Since v5.1 the lobby names the exact cause and shows the technical line under it (see `explain()` in `js/online/supabase-backend.js`). Older message: |
| "تعذّر الاتصال بخدمة اللعب" right away | Anonymous sign-ins disabled (step 4), wrong URL/key, or the function is not deployed (`supabase functions list`). Open the browser console → Network → look at the `auth/v1/signup` and `functions/v1/eas-game` calls. |
| CORS error on `eas-game` | `ALLOWED_ORIGIN` does not equal the exact site origin (no trailing slash). Re-run `supabase secrets set …` and redeploy. |
| Room created but the other player's join never appears live | Realtime private channel not authorised: re-apply migration 02; confirm the two `realtime.messages` policies exist; confirm "Allow public access" is OFF and the project's Realtime is enabled. The game still works: every 20 seconds the heartbeat notices a newer revision and fetches it, only slower. |
| "قاعدة البيانات غير جاهزة" | A migration is missing: run `supabase db push` against the right project (`supabase link`). |
| Live preview (dashed tiles) never appears | Either player switched it off: the host's room rule in the waiting room, or Settings → المعاينة المباشرة on either device. Both devices must run v5.2: an old cached copy of the page ignores it (open Settings → التطبيق → *فحص التثبيت والاتصال* to see which version each device has). |
| A request (undo / pause) shows on one device only | The other device runs an old cached copy of the page, or its connection dropped. Since v5.2 each device also tells the other which revision it has seen, so a missed realtime event heals itself within a second or two. |
| `ROOM_CODE_TAKEN` / `STALE_REVISION` in logs | Normal and handled (retry / resync). |
| "الجلسة منتهية" | The browser's anonymous identity was lost (site data cleared). The old seat cannot be reclaimed; start a new room. |
| Everything works locally, nothing online after deploy | `supabase db push` not run, or run against the wrong project (`supabase link` again). |

## Stale rooms: what happens
Lobby idle > 2 h → abandoned. Active/Tahkim idle > 24 h → abandoned. Finished/abandoned > 7 days → deleted with all its rows. Runs hourly if pg_cron is enabled; otherwise call `select public.eas_cleanup_stale_games();` from the SQL editor now and then (or never: it only saves space).
Anonymous auth users are not deleted by this; Supabase documents periodic cleanup of old anonymous users.

## 12. Recommended before real use (v5.4)

- **Anonymous sign-ins**: Supabase Dashboard → Authentication → Attack Protection → enable **CAPTCHA** (Cloudflare Turnstile is free). Without it anyone can script thousands of anonymous accounts. (The page must then send the captcha token when it signs in: this needs a small client change, ask for it when you switch it on.)
- **ALLOWED_ORIGIN** must be your real site (step above), not left empty.
- **Security headers** ship in `vercel.json`. `Content-Security-Policy-Report-Only` shows in the browser console what a strict script policy would block; once it is quiet during a full online match, rename it to `Content-Security-Policy` to enforce it.
- **Hosting supabase-js yourself** (instead of the CDN import in `js/online/supabase-backend.js`) would allow `script-src 'self'` and offline-first loading; not done yet because it needs a download this build environment did not have.
