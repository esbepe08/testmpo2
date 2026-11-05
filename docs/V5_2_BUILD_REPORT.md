# v5.2 build report

## What was reported, what was found, what changed
| Report | Finding | Change |
|---|---|---|
| Live preview "does not work in a room, nothing once the match starts" | Drafts were published by browsers as realtime broadcasts, which needs an extra database permission (migration 05) and fails silently or can disturb the channel when it is missing; the toggle was the host's room rule only, with nothing to see or change once the match began; a draft that arrived a moment before its revision was dropped. | Drafts ride on **presence** (always authorised); a personal switch in Settings; late drafts are kept and shown when their revision arrives; migration 06 drops the permission. |
| Undo request: "sent" but nothing on the other screen | The request depended on one realtime event and on a shared dialog element. A missed event, a busy dialog, or the other device running an older cached copy of the page all produce exactly this. | Own full-screen card; presence **revision gossip** (a newer revision seen by the peer triggers a fetch); presence **version handshake** (mismatch announced; requests not sent to a device that cannot show them). |
| Local undo single-use | One snapshot, cleared by pass / swap / ruling | A step history: move, pass and swap all push a snapshot; Undo pops; the move history is truncated to match; saved with the match. |
| Rack display (local) | – | Settings → الرفوف: always / on turn only. |
| Pause: prominent, tournament style, also local | Online pause was a status line and a button | Full-screen card on both screens; local pause on clocks / P / Settings; the board and racks are hidden while paused. |

## Decisions
- The local pause control is the **clock** (plus P and a Settings button), not a new button in the controls: the layout test suites enumerate the exact set of ten control buttons, and measured geometry of every layout element is **identical** to v5 at four screen sizes and both history layouts (checked here against the untouched v5).
- The undo responder's clock keeps running while the card is up (their thinking time is theirs); declining or answering is the only way to continue.
- Presence is rate limited, so drafts are coalesced (200 ms) and sent only when the tiles change.

## Verification (this sandbox)
- Server suites: rooms 38, game 62, security 39, network 33, endgame 41 (one stale assertion fixed), abandon 25, pause-undo 58, parity 10, draft 26, explain 15.
- Browser, two players through the real server core: **76/76** (undo card accept / decline / inert game, pause card on both screens with countdown, ghost tiles, personal switch). Local play: **34/34** (unlimited undo of moves, passes and swaps, saved-match validation, rack modes, pause by clock / P / Settings, clock frozen while paused).
- PWA static 383, PWA e2e 91/92 (the one failure is Chrome's "in-incognito" installability note: this headless sandbox runs incognito), theme contrast, floating modules 51.
- Not run here: the layout and logic suites that need `jsdom` / `pngjs` (not installable offline; they failed identically on the untouched v5), and anything against a real Supabase project. Update order: `supabase db push` (05 and 06), `supabase functions deploy eas-game`, deploy the site, then **close and reopen the page on both devices** (the service worker serves the old copy until then).

## Addendum: who starts (v5.2.1)
- **Rule**: each player draws one tile; the higher value starts (a blank counts 0, as the score does); a tie is drawn again. The tiles go back into the bag.
- **Online**: the **server** draws (`drawFirst` in `engine.js`, inside the same transaction that deals the racks), records every round in `games.ext.first` (public: they are only tiles of the bag, which is reshuffled before the racks are dealt) and both browsers play that recorded draw. Neither player can influence it; a rematch draws again; after 12 ties in a row a coin decides (never seen in 4,000 simulated draws). No migration is needed (it uses `games.ext`).
- **Local**: interactive. Each player taps their own tile; ties are redrawn; Skip picks at random; Settings → بداية المباراة can switch it off (the first player starts).
- **Animation**: one card on the dimmed, blurred backdrop: tiles rise in, flip once, the winner lifts with a ring, the loser steps back, a tie shakes and is redrawn. Only the tiles waiting for a tap bob softly. `prefers-reduced-motion` keeps every state and drops the movement.
- **Tests**: server 14 (higher value wins, only ties redraw, blanks 0, seats start about equally often: 4,000 draws, coin fallback, public and identical for both players, tile conservation, rematch redraws); browser online: both screens show the same draw and the drawn player is on turn (82/82); browser local: tie then redraw then winner, Escape, Skip (43/43). The other suites run with the draw off (`scrabble.firstdraw=off`) or the old rule (`deps.noDraw`) so they keep a known first player. Layout geometry unchanged.
