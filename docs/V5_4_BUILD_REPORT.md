# v5.4: audit fixes and the surrender rule

## New rule
**Surrender (استسلام):** the player who resigns drops to **0 points at once** and the other player **wins automatically**, whatever the scores were. The confirmation dialog says so, the result card shows the 0, the Settings text lists it. A vanished player (abandon claim) is a different case: scores are kept.

## Fixed (each has a test in `tests/online/hardening.mjs`)
| # | Problem found in the audit | Fix |
|---|---|---|
| 1 | A player with no time left could `pause` / request Tahkim / request undo, freezing the clock so the opponent's timeout claim was refused | Before any action (except resign / claim_timeout / claim_abandon) the server settles an expired clock: the match ends on time (`E.expiredPatch`) |
| 2 | Undo and a voided move restored the bag in the same order: the mover knew their next draw | The bag is reshuffled after the restore |
| 3 | A "ready" given on a screen that had not seen the host's rule change was accepted | `set_ready` is pinned to the revision the guest saw (`STALE_STATE` otherwise) |
| 4 | An unanswered Tahkim request froze the match for ever while the opponent's tab stayed open; request / withdraw could be repeated to stop one's own clock | Requests lapse by themselves: unanswered after 2 min, approved but unruled after 3 min (applied by the next heartbeat or action). Withdrawing now uses up the challenge for that move |
| 5 | A forged presence `rev` (or presence key) made the other device call `snapshot` in a loop | Opponent identified by player id, `rev` accepted only within 25 revisions of the local one, one catch-up per 5 s, oversized payloads ignored |
| 7 | Forfeit after 3 min of silence was too easy on phones | `ABANDON_MS` = 5 min |
| 8 | Two simultaneous create / join requests could put a player in two open games | Database trigger `eas_one_open_game` (migration 07) |
| – | Room codes could be guessed without limit | 8 misses per minute per player, then `RATE_LIMITED` |
| – | The whole repository (migrations, function sources, tests, docs) was published by Vercel | `tools/build-dist.mjs` copies only the browser files to `dist/`; `vercel.json` publishes `dist/` |
| – | No security headers | `nosniff`, referrer policy, permissions policy, `frame-ancestors 'none'`; strict script policy in report-only mode |
| – | `ALLOWED_ORIGIN` accepted one origin only, default `*` | Comma-separated list |
| – | Heartbeat downloaded the whole match state every 20 s per player | Light read (game + seats) |
| – | Anonymous players accumulated for ever | `eas_cleanup_anonymous_users` (90 days, never someone in an open game), scheduled with `pg_cron` |

## Deliberately NOT changed (needs your decision or could not be tested here)
- **The move that goes out cannot be challenged** (the match ends the moment a rack is empty and the bag is empty). Real Scrabble allows a challenge there. Needs a short challenge window; tell me if you want it.
- **supabase-js still loads from the CDN** (no download possible in this environment); CSP is therefore report-only.
- **CAPTCHA** for anonymous sign-in is a Supabase dashboard setting plus a small client change.
- `getUser` → `getClaims` (saves one Auth call per request) and building the answer without the second full read after a commit: untested on a live Supabase, so left alone.

## Upgrade order
1. `supabase db push` (migration `…07`), 2. `supabase functions deploy eas-game`, 3. deploy the site (Vercel now uses `dist/`: check Settings → Build & Development shows the Build Command and Output Directory from `vercel.json`).
Both players must run 5.4 (the app compares versions through presence).
