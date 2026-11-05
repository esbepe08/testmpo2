# v5.3 build report

| # | Request | What changed |
|---|---|---|
| 1 | No idhafah | `js/wordrules.js`: the "attached possessive pronoun" line moved from allowed to **not allowed**; new rule names every form (noun or preposition + pronoun: لي، لك، كتابي، بابي، قلمك، له، به، منه…) and the mudhaf + mudhaf ilaih case; the judge's checklist has an idhafah question; a red reminder line sits above the rules in the Tahkim dialog. There is still no dictionary: the players enforce it through Tahkim. |
| 2 | +5 s per move | `INCREMENT_MS` in `js/config.js`. Local (`game.js`) and server (`engine.js`) add it to the mover after a move that places tiles. Not for pass, swap, a voided move (given back on a Tahkim "wrong" ruling and on an accepted online undo) or the move that ends the game. Saved matches accept clocks above the starting time. |
| 3 | Cover | One menu: PLAY (filled, primary) and ONLINE (outlined, secondary) at the same width, each with a one-line subtitle; support is one quiet text link below; the author last. Short landscape screens put the two doors side by side. |
| 4 | Tahkim reason | Online: the challenger must type a reason (3–160 characters; send stays disabled until then, the server checks again). It goes to the opponent as a full-screen card (approve / decline). Approved → the challenger rules صحيح / خطأ as before, with the reason shown. Declined → the move stands, the clock restarts, the same move cannot be challenged again. The challenger can withdraw. The reason is stored in `games.tahkim` (no migration). Local single-device Tahkim is unchanged. |
| 5 | Expanded values | أ 2→4, ى 3→4, إ 3→6, ء 4→6, ئ 4→7, ؤ 5→8, آ 5→10; ة stays 3 (it ends most feminine nouns). Table: `EXPANDED_TILES` in `js/modes.js` (the server copy is regenerated). Matches saved with the old values are discarded on load (the tile signature changed). |
| 6 | Scaling | New `js/scale.js`: the board's padding absorbs the remainder so cells are whole pixels (no shimmer while resizing); `--ui` (board width / 720, 0.85–1.2) scales names, clocks, scores, button labels and the word log with the board. Compact landscape layouts keep their fixed sizes. |
| 7 | Player colours | Each player's name, score, panel stripe and result card use the theme's `--player-1` (warm) / `--player-2` (cool). Placed tiles keep the colour of the player who placed them: letter and value in crimson (P1) or blue (P2) via `--tile-p1` / `--tile-p2`; a blank gets a dotted underline instead of its old orange. The placer is stored on the tile (`o`, server and local save); tiles from games started before this version show the neutral colour. Contrast audit extended. |

## Verification
Server suites pass (rooms, game, security, network, endgame, abandon, pause-undo, parity, draft, explain, first-draw, env-build) plus new `tests/online/tahkim-reason.mjs` (36 checks), PWA static 404. Not run here: browser suites (no Chromium in this sandbox); `tests/e2e/run.py` was updated for the reason step but not executed.

## Deploy
`node tools/stamp-sw.mjs` (done), `supabase functions deploy eas-game` (no migration), deploy the site, reopen the page on both devices.
