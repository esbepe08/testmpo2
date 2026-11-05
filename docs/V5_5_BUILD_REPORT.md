# eas-online v5.5 — build report

Base: v5.4.1. Version string `5.5`, new migration `20261105000008_eas_v5_5_tahkim_discussion.sql`, service worker restamped.

## What changed, by request item

| # | Request | What was done | Where |
|---|---|---|---|
| 1 | Offline pause button independent of rack/panel | The clock in the player panel is no longer a button. A dedicated 44 px round button is fixed to a corner of the **screen** (default bottom-left, above the safe area). It is outside `.app`, panels and racks, so rack size, layout, rotation or viewport changes cannot move it. It can be dragged (short press = pause); its spot is stored as "nearest corner + distance", so after rotation it stays in the same corner, clamped inside the screen. Shift+arrows nudge it. P and the Settings button still work. Hidden online, on the cover, when the game is over. | `js/pausefab.js`, `js/pause.js`, `css/overlay.css` |
| 2 | Resizable online match panel | In Floating Workspace the panel with room code / surrender / pause is now resizable on **both axes** (grip in the corner), keeps its geometry `[x, y, w, h]` per device, is limited to the viewport (it can never be larger than the screen, a huge drag cannot push it off, a smaller window clamps it), width scales its content like other modules, pinned height wraps the row; double-click on the grip resets. Resizing it moves/resizes no other module (tested). | `js/float-*.js`, `js/layout.js`, `css/online.css` |
| 3 | Tahkim discussion | Challenge (reason mandatory) opens a shared chat for both players at once. Both clocks stop. No time limit. The dismissal only happens when the server settles the dispute. Esc / outside click cannot close it; the game behind is inert; surrender and "opponent has gone" stay inside the panel. The v5.4 approve / decline / withdraw steps were removed (nobody can finalise alone). | `js/online/tahkim.js`, engine `requestTahkim / tahkimSay / tahkimChoose` |
| 4 | Persistent sessions | Removed `TAHKIM_APPROVE_MS` / `TAHKIM_RULE_MS` and the lapse logic (engine, service, heartbeat). The whole state (reason, words, chat, both choices) lives in the game row, so refresh and reconnection redraw exactly the same panel. The hourly janitor no longer abandons a discussion after 24 h; it only closes one that **both** players have left for 7 days. Disconnect: the frozen state stays until the player returns, the other resigns, or uses the existing explicit "opponent absent" claim (5 min of silence, server-checked). | engine, `service.js`, migration 08 |
| 5 | Mutual agreement | Each player picks valid/invalid independently, may change or take back the choice. Same verdict -> settled in the same commit as the second choice (row lock + revision check; concurrent choices retry against the newest state and settle exactly once, tested). Different -> stays open. | engine `tahkimChoose` |
| 6 | Gameplay lock | Server: move/pass/swap/undo/pause/resume/timeout/new challenge all refused while `tahkim_pending` (tested, state byte-identical). Client: whole game inert behind the panel. | tests `tahkim-discussion.mjs` |
| 7 | History / records | `games.ext.tahkim_log` (disputed words, reason, challenger, agreed verdict, resolution timestamp, penalty) and the same record on the move in the snapshot; shown in the word log as a collapsible "سجل التحكيم". | `snapshot.js`, `js/ui.js` |
| 8 | Responsive floating optimisation | New browser tests: resizing the match panel changes no other module; clamping at smaller windows; reload keeps size; reset. Existing floating suites pass. | `tests/e2e/run.py`, `layout/float_modules.py` |
| 9 | Regression testing | See "Tests run" below. Service worker precache list updated (3 new files) and restamped; `APP_VERSION` 5.5. | |
| 10 | Rules Reference panel | Collapsible panel inside the discussion, **per player and local** (nothing is sent; the other player's screen, the clocks and the session do not change; verified: no server revision is created). Two tabs: game rules (generated from `config.js`, `modes.js`, `rules.js`, so numbers cannot drift) and the word rules (the same text as Settings). A side column when there is room (wide windows, short landscape phones), a short scrolling band above the chat on narrow portrait; message box and decision buttons are separate grid rows and never covered (measured on 390x844 and 1280x800). A test compares every figure with the engine, including running a real penalty. | `js/tahkimrules.js`, `tests/online/tahkim-rules.mjs` |

## Design decisions you may want to veto
* **No withdraw.** A challenger can no longer cancel unilaterally (that would be a one-sided verdict). Only agreement, surrender or an abandon claim end a discussion.
* **Choices are visible to both players** while they discuss (it helps reach agreement); clicking your own selected button takes it back.
* **Chat is stored in the game row** (max 200 messages x 300 chars; oldest dropped; ids keep counting). Once settled only a record (word, reason, verdict, time, message count) is kept, not the chat. A dedicated table would allow unlimited history but needs a new `commit_action` path; say if you want it.
* The pause button can be covered by a floating module dragged on top of it (modules sit above it so they are never blocked). P and Settings still pause.
* Offline (local) Tahkim keeps its single-device dialog (it already has the collapsible rules).

## Deploy
1. Run migration `20261105000008_eas_v5_5_tahkim_discussion.sql` (replaces only `eas_cleanup_stale_games`).
2. Redeploy the Edge Function (shared engine changed) **and** the site together. A v5.4 client against the v5.5 server cannot use Tahkim (old actions were removed); the existing version check tells a player to refresh.

## Tests run (this build)
* Server suites on the in-memory server: rooms, game, security, network, endgame, abandon, pause-undo, parity, tahkim-reason, **tahkim-discussion (63)**, **tahkim-rules (94)**, draft, explain, first-draw, env-build, hardening: all pass.
* Two real browsers through the server core (`e2e/run.py`): **123 checks pass** (discussion on both screens, Esc, chat both ways, rules open/close independent, no server revision, no overlap with message box / decision buttons at 390x844 and 1280x800, refresh keeps chat and decisions, differing choices keep it open, reconsidering settles, history record, floating match panel resize / clamp / reload / reset).
* Layout suites: floating, float_modules, layering, fluid, tools, collapse, log-icon, contrast, logic: pass.
* Edge shared modules in sync; `pwa/static` passes after restamp.

## Failures that exist in v5.4.1 and are NOT caused by this build (verified by running the original zip)
* `e2e/local.py`: "the support section sits with the two ways to play".
* `layout/history-toggle.mjs`: 9 layout-baseline diffs (identical numbers on the original).
* `pwa/e2e.mjs`: Chrome "in-incognito" installability error (headless test environment).
* Fixed stale test counts: `endRules` list is 7 items (test said 5).

## Not tested
* Real Supabase / Realtime (the in-memory server and the fake backend stand in, as before). The migration SQL was written but not executed against a database.
* Physical phones; layout was measured in emulated viewports.
* `layout/feel.mjs` times out (puppeteer protocol timeout) in this environment, identically on the original v5.4.1, so it gives no signal either way.
