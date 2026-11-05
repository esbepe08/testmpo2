// Authoritative game transitions for online play. PURE: no I/O, no clock, no randomness of its own. Everything comes in as
// arguments (state, userId, request, now, deps) and a PATCH comes out (see service.js / the commit_action SQL function).
//
// The server state is split exactly as the design requires:
//   PUBLIC   game row (board, turn, revision, clock, tahkim, result ...), players' score / tile_count / time, move history
//   PRIVATE  one rack per player (only its owner ever receives it)
//   SERVER   the tile bag, the undo snapshot Tahkim may need; neither ever leaves the server
//
// Rules are NOT re-implemented here: legality, words, scoring and the end-of-game settlement come from game/rules.js (shared with the local game).
// There is no dictionary: whether a word is valid is decided by the players through Tahkim, exactly as in local play.
import { SIZE, RACK, MIN_BAG_SWAP, DURATIONS, ABANDON_MS, PAUSE_MS, PAUSES_EACH, INCREMENT_MS, TAHKIM_CHAT_MAX_MESSAGES, TAHKIM_CHAT_MAX_CHARS, TAHKIM_LOG_MAX } from '../game/config.js';
import { TILE_MODES } from '../game/modes.js';
import { analyzeMove, scoreWords, wordStr, makeTileSet, settleEnd, challengePenalty } from '../game/rules.js';
import { fail } from './errors.js';

export const STATUS = Object.freeze({ LOBBY: 'lobby', STARTING: 'starting', ACTIVE: 'active', TAHKIM: 'tahkim_pending', FINISHED: 'finished', ABANDONED: 'abandoned' });
export const PLAYING = [STATUS.ACTIVE, STATUS.TAHKIM];
export const OPEN = [STATUS.LOBBY, STATUS.STARTING, STATUS.ACTIVE, STATUS.TAHKIM];

const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
export const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
export const pubTile = t => ({ id: t.id, l: t.blank ? '' : t.l, v: t.blank ? 0 : t.v, blank: !!t.blank, as: t.blank ? (t.as || null) : null, o: t.o === 0 || t.o === 1 ? t.o : null });

// ---------- randomness (injected so tests are deterministic; production uses crypto) ----------
export function shuffle(a, rng) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function idFactory(rng) {
  const seen = new Set();
  return () => { let id; do { id = Array.from({ length: 6 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(rng() * 32)]).join(''); } while (seen.has(id)); seen.add(id); return id; };
}

// ---------- helpers ----------
export const seatOf = (w, userId) => { const p = w.players.find(x => x.player_id === userId); return p ? p.seat : -1; };
export const playerBySeat = (w, seat) => w.players.find(p => p.seat === seat);
const other = seat => 1 - seat;
export const rackOf = (w, seat) => w.racks[playerBySeat(w, seat).player_id];
const turnNo = w => w.moves.length + 1;

// ---------- ext: small public extras of a game (the `games.ext` jsonb column) ----------
//   live    boolean   the host allows live preview of the player-on-turn's tentative tiles (browsers broadcast it; the server never sees it)
//   pause   null | {by, at, until}   both clocks are stopped
//   pauses  [n0, n1]  pauses used by each seat in this game
//   undo    null | {state:'pending'|'declined', by, move_number, at}   the last mover's request to take the move back
//   tahkim_log  [{n, by, words, reason, verdict, at, penalty}]   every resolved Tahkim of this round (the match's transparent dispute record)
export const extOf = g => g.ext || {};
const setExt = (g, patch) => { g.ext = { ...(g.ext || {}), ...patch }; };
export const isPaused = g => !!(g.ext && g.ext.pause);
const clearUndo = w => { if (w.game.ext && w.game.ext.undo) setExt(w.game, { undo: null }); };   // acting on the move implicitly declines a pending request

function requireMember(w, userId) { const s = seatOf(w, userId); if (s < 0) fail('NOT_MEMBER'); return s; }
function requirePlaying(w) { if (w.game.status === STATUS.TAHKIM) fail('TAHKIM_PENDING'); if (w.game.status !== STATUS.ACTIVE) fail('WRONG_STATUS'); if (isPaused(w.game)) fail('PAUSED'); }
function requireTurn(w, userId) { const s = requireMember(w, userId); requirePlaying(w); if (w.game.current_seat !== s) fail('WRONG_TURN'); return s; }

// ---------- clock ----------
// players[].ms_left is the time left when the clock was last settled; while the clock runs, the player on turn is still spending
// (now - turn_started_at). All of it is computed from SERVER timestamps, never from a browser counter.
export const clockRunning = g => !!(g.clock_started && g.turn_started_at && g.status === STATUS.ACTIVE);
export function liveMs(w, seat, now) {
  const p = playerBySeat(w, seat), g = w.game;
  return (clockRunning(g) && g.current_seat === seat) ? Math.max(0, p.ms_left - (now - g.turn_started_at)) : p.ms_left;
}
function settle(w, now) {   // charge the elapsed time to the player on turn
  const g = w.game;
  if (!clockRunning(g)) return;
  const p = playerBySeat(w, g.current_seat);
  p.ms_left = Math.max(0, p.ms_left - Math.max(0, now - g.turn_started_at)); g.turn_started_at = now;
}
function restartClock(w, now) {
  const g = w.game;
  if (g.clock_started && g.status === STATUS.ACTIVE) { g.turn_started_at = now; g.turn_deadline_at = now + playerBySeat(w, g.current_seat).ms_left; }
  else { g.turn_started_at = null; g.turn_deadline_at = null; }
}
function nextTurn(w, now, scored) {
  settle(w, now);
  w.game.current_seat = other(w.game.current_seat);
  if (scored && !w.game.clock_started) w.game.clock_started = true;   // the clock starts after the first scored move, like the local game
  restartClock(w, now);
}

// ---------- patches ----------
// Only what changed is sent. players/racks are keyed by player_id.
function patchOf(w, ev, o = {}) {
  const g = w.game;
  const game = {
    status: g.status, current_seat: g.current_seat, current_player_id: g.current_seat == null ? null : playerBySeat(w, g.current_seat)?.player_id ?? null,
    board: g.board, turn_started_at: g.turn_started_at, turn_deadline_at: g.turn_deadline_at, clock_started: g.clock_started, tahkim: g.tahkim,
    tahkim_available: g.tahkim_available, bag_count: g.bag_count, tile_mode: g.tile_mode, minutes: g.minutes, round: g.round,
    started_at: g.started_at, finished_at: g.finished_at, winner_player_id: g.winner_player_id, winner_seat: g.winner_seat, result: g.result, rematch_seats: g.rematch_seats,
    ext: g.ext || {}
  };
  return { event: ev, game, players: w.players.map(p => ({ player_id: p.player_id, score: p.score, tile_count: p.tile_count, ms_left: p.ms_left, ready: p.ready })),
    racks: o.racks === 'all' ? w.players.map(p => ({ player_id: p.player_id, tiles: w.racks[p.player_id] })) : (o.racks || []).map(pid => ({ player_id: pid, tiles: w.racks[pid] })),
    private: o.private ? { bag: w.priv.bag, undo: w.priv.undo ?? null } : undefined, move: o.move || null, move_update: o.move_update || null,
    add_player: o.add_player || null, remove_player: o.remove_player || null };
}
export const withBagCount = w => { w.game.bag_count = w.priv.bag.length; };
export const refill = (w, seat) => { const rack = rackOf(w, seat), bag = w.priv.bag; for (let i = 0; i < RACK && bag.length; i++) if (!rack[i]) rack[i] = bag.pop(); playerBySeat(w, seat).tile_count = rack.filter(Boolean).length; };

// ---------- lobby ----------
const sanitizeSettings = s => {
  const out = {};
  if (s?.tile_mode !== undefined) { if (!TILE_MODES[s.tile_mode]) fail('BAD_REQUEST'); out.tile_mode = s.tile_mode; }
  if (s?.minutes !== undefined) { if (!DURATIONS.includes(Number(s.minutes))) fail('BAD_REQUEST'); out.minutes = Number(s.minutes); }
  if (s?.live !== undefined) { if (typeof s.live !== 'boolean') fail('BAD_REQUEST'); out.live = s.live; }   // lives in games.ext, not in a column
  return out;
};
export { sanitizeSettings };

export function updateSettings(w, userId, settings) {
  const seat = requireMember(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  if (seat !== 0) fail('NOT_HOST');
  const { live, ...cols } = sanitizeSettings(settings);
  Object.assign(w.game, cols); if (live !== undefined) setExt(w.game, { live });
  w.players.forEach(p => { if (p.seat !== 0) p.ready = false; });   // a guest must re-confirm after the rules changed
  return patchOf(w, 'SETTINGS_UPDATED');
}
export function setReady(w, userId, ready) {
  const seat = requireMember(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  playerBySeat(w, seat).ready = !!ready;
  return patchOf(w, 'PLAYER_READY');
}
export function leaveLobby(w, userId, now) {
  const seat = requireMember(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  if (seat === 0) { w.game.status = STATUS.ABANDONED; w.game.finished_at = now; return patchOf(w, 'PLAYER_LEFT'); }   // the host closes the room
  const p = playerBySeat(w, seat); w.players = w.players.filter(x => x !== p);
  return patchOf(w, 'PLAYER_LEFT', { remove_player: p.player_id });
}

// Deals a fresh game for the current round: bag, racks, empty board, zero scores, clock not started.
// Who starts: each player draws one tile from the bag, the higher value starts (a blank counts 0), a tie is drawn again. The tiles go back into the bag.
// The draws are public (they are only tiles of the bag, and the bag is shuffled again before the racks are dealt, so they say nothing about anyone's rack): every round is
// recorded in games.ext.first so both browsers can show the same draw. After MAX_DRAWS ties in a row (about 1 in 10^9) a coin decides.
export const MAX_DRAWS = 12;
export function drawFirst(bag, rng) {
  const rounds = [];
  for (let i = 0; i < MAX_DRAWS; i++) {
    shuffle(bag, rng);
    const pair = [bag[0], bag[1]].map(t => ({ l: t.blank ? '' : t.l, v: t.blank ? 0 : t.v, blank: !!t.blank }));
    rounds.push(pair);
    if (pair[0].v !== pair[1].v) return { seat: pair[0].v > pair[1].v ? 0 : 1, rounds };
  }
  return { seat: Math.floor(rng() * 2), rounds, coin: true };
}
function deal(w, now, deps) {
  const g = w.game, next = idFactory(deps.rng);
  const bag = shuffle(makeTileSet(g.tile_mode, next), deps.rng);
  // deps.noDraw is for tests that need a known first player: it keeps the old rule (the host starts, and each rematch alternates)
  const first = deps.noDraw ? { seat: (g.round - 1) % 2, rounds: [] } : drawFirst(bag, deps.rng);
  shuffle(bag, deps.rng);   // the drawn tiles went back: the racks are dealt from a fresh shuffle
  w.priv = { bag, undo: null };
  w.racks = {};
  for (const p of [...w.players].sort((a, b) => a.seat - b.seat)) { w.racks[p.player_id] = Array(RACK).fill(null); refill(w, p.seat); }
  w.players.forEach(p => { p.score = 0; p.ms_left = g.minutes * 60000; });
  Object.assign(g, { board: emptyBoard(), status: STATUS.ACTIVE, current_seat: first.seat, clock_started: false, turn_started_at: null, turn_deadline_at: null,
    tahkim: { state: 'none' }, tahkim_available: false, winner_player_id: null, winner_seat: null, result: null, finished_at: null, rematch_seats: [], started_at: now });
  setExt(g, { pause: null, undo: null, tahkim_log: [], pauses: [0, 0], first: { seat: first.seat, rounds: first.rounds, round: g.round } });
  withBagCount(w);
}
export function startGame(w, userId, now, deps) {
  const seat = requireMember(w, userId);
  if (w.game.status !== STATUS.LOBBY) fail('WRONG_STATUS');
  if (seat !== 0) fail('NOT_HOST');
  if (w.players.length !== 2) fail('NEED_OPPONENT');
  if (!w.players.every(p => p.seat === 0 || p.ready)) fail('NOT_READY');
  w.game.round = 1;
  deal(w, now, deps);
  return patchOf(w, 'GAME_STARTED', { racks: 'all', private: true });
}

// ---------- moves ----------
function parsePlacements(pl) {
  if (!Array.isArray(pl) || pl.length < 1 || pl.length > RACK) fail('BAD_REQUEST', 'عدد القطع غير صالح.');
  const ids = new Set(), cells = new Set();
  for (const x of pl) {
    if (!x || typeof x.tileId !== 'string' || !Number.isInteger(x.row) || !Number.isInteger(x.col) || x.row < 0 || x.row >= SIZE || x.col < 0 || x.col >= SIZE) fail('BAD_REQUEST');
    if (x.as !== undefined && x.as !== null && typeof x.as !== 'string') fail('BAD_REQUEST');
    if (ids.has(x.tileId) || cells.has(x.row * SIZE + x.col)) fail('BAD_REQUEST', 'قطعة أو مربع مكرر في الحركة.');
    ids.add(x.tileId); cells.add(x.row * SIZE + x.col);
  }
  return pl;
}
const snapshotForUndo = w => ({
  board: clone(w.game.board), racks: clone(w.racks), bag: clone(w.priv.bag), scores: Object.fromEntries(w.players.map(p => [p.player_id, p.score])),
  tile_counts: Object.fromEntries(w.players.map(p => [p.player_id, p.tile_count])), cur_seat: w.game.current_seat, started: w.game.clock_started
});

// Ends the game. reason: 'rack' | 'time' | 'resign' | 'abandon'. loserSeat is only used by 'resign' and 'abandon' (the player who gave up / vanished).
// Result lines carry everything the result card shows: {seat, score (final), raw, ded, mins, bon}.
export function finish(w, reason, now, loserSeat) {
  settle(w, now);
  const g = w.game, seats = [0, 1];
  let lines;
  const forfeit = reason === 'resign' || reason === 'abandon';
  if (reason === 'resign') playerBySeat(w, loserSeat).score = 0;   // surrender rule: whoever gives up drops to 0 at once and the other player wins
  if (forfeit) lines = seats.map(s => ({ seat: s, score: playerBySeat(w, s).score, raw: playerBySeat(w, s).score, ded: 0, mins: 0, bon: 0 }));
  else {
    const res = settleEnd(seats.map(s => ({ score: playerBySeat(w, s).score, rack: rackOf(w, s), ms: playerBySeat(w, s).ms_left })));
    lines = res.map((r, s) => ({ seat: s, ...r }));
    seats.forEach(s => { playerBySeat(w, s).score = lines[s].score; });
  }
  let win = null;
  if (forfeit) win = other(loserSeat);
  else if (lines[0].score !== lines[1].score) win = lines[0].score > lines[1].score ? 0 : 1;
  Object.assign(g, { status: STATUS.FINISHED, finished_at: now, winner_seat: win, winner_player_id: win == null ? null : playerBySeat(w, win).player_id,
    result: { reason, lines, winner_seat: win, ...(forfeit ? { loser_seat: loserSeat } : { subject_seat: g.current_seat }) }, turn_started_at: null, turn_deadline_at: null, tahkim_available: false, rematch_seats: [] });
  w.priv.undo = null; setExt(g, { pause: null, undo: null });
}

export function submitMove(w, userId, req, now, deps) {
  const seat = requireTurn(w, userId), g = w.game;
  if (liveMs(w, seat, now) <= 0) { finish(w, 'time', now); return { patch: patchOf(w, 'GAME_ENDED', { private: true, racks: 'all' }), ended: 'time' }; }
  const placements = parsePlacements(req.placements), rack = rackOf(w, seat), alpha = TILE_MODES[g.tile_mode].alpha;
  const board = clone(g.board).map(r => r.map(t => t && { ...t }));
  const move = [];
  for (const x of placements) {
    const slot = rack.findIndex(t => t && t.id === x.tileId);
    if (slot < 0) fail('TILE_NOT_OWNED');
    if (board[x.row][x.col]) fail('MOVE_INVALID', 'هذا المربع مشغول.');
    const src = rack[slot], t = { id: src.id, l: src.l, v: src.v, blank: src.blank, as: null, o: seat };
    if (src.blank) { if (typeof x.as !== 'string' || ![...alpha].includes(x.as)) fail('MOVE_INVALID', 'اختر حرفًا صالحًا للقطعة الفارغة.'); t.as = x.as; }
    else if (x.as) fail('BAD_REQUEST');
    board[x.row][x.col] = t; move.push({ t, r: x.row, c: x.col, slot });
  }
  const a = analyzeMove(board, move);
  if (a.err) fail('MOVE_INVALID', a.err);
  const r = scoreWords(a.words, a.isNew, move.length);   // words are judged by the players (Tahkim), never by the server
  // ---- commit to the working copy ----
  const undo = snapshotForUndo(w), p = playerBySeat(w, seat);
  move.forEach(e => { rack[e.slot] = null; });
  g.board = board.map(row => row.map(t => t && pubTile(t)));
  p.score += r.total; refill(w, seat);
  w.priv.undo = undo; g.tahkim = { state: 'none' }; g.tahkim_available = true; clearUndo(w);
  const row = { player_id: userId, seat, turn_number: turnNo(w), action_type: 'move', placements: placements.map(x => ({ tileId: x.tileId, row: x.row, col: x.col, as: x.as || null })),
    formed_words: r.list, score_delta: r.total, validation_result: 'skipped', bingo: r.bingo, swap_count: 0 };
  if (!rack.some(Boolean)) { finish(w, 'rack', now); withBagCount(w); return { patch: patchOf(w, 'GAME_ENDED', { racks: 'all', private: true, move: row }), result: { score: r.total, words: r.list }, ended: 'rack' }; }
  nextTurn(w, now, true); withBagCount(w);
  p.ms_left += INCREMENT_MS; undo.inc = INCREMENT_MS; w.priv.undo = undo;   // chess clock: +5 s for the mover; remembered so a voided / taken-back move gives it back
  return { patch: patchOf(w, 'MOVE_COMMITTED', { racks: [userId], private: true, move: row }), result: { score: r.total, words: r.list } };
}

export function passTurn(w, userId, now) {
  const seat = requireTurn(w, userId);
  if (liveMs(w, seat, now) <= 0) { finish(w, 'time', now); return { patch: patchOf(w, 'GAME_ENDED', { private: true }), ended: 'time' }; }
  w.priv.undo = null; w.game.tahkim = { state: 'none' }; w.game.tahkim_available = false; clearUndo(w);
  const row = { player_id: userId, seat, turn_number: turnNo(w), action_type: 'pass', placements: [], formed_words: [], score_delta: 0, validation_result: 'skipped', bingo: false, swap_count: 0 };
  nextTurn(w, now, false);   // passing is unlimited, exactly like the local game
  return { patch: patchOf(w, 'PASS_COMMITTED', { private: true, move: row }) };
}

export function swapTiles(w, userId, req, now, deps) {
  const seat = requireTurn(w, userId), g = w.game;
  if (liveMs(w, seat, now) <= 0) { finish(w, 'time', now); return { patch: patchOf(w, 'GAME_ENDED', { private: true }), ended: 'time' }; }
  const ids = req.tileIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > RACK || new Set(ids).size !== ids.length || ids.some(i => typeof i !== 'string')) fail('BAD_REQUEST');
  if (w.priv.bag.length < MIN_BAG_SWAP) fail('SWAP_NOT_ALLOWED', `لا يمكن التبديل: في الكيس ${w.priv.bag.length} قطع فقط (الحد الأدنى ${MIN_BAG_SWAP}).`);
  const rack = rackOf(w, seat);
  const idx = ids.map(id => { const i = rack.findIndex(t => t && t.id === id); if (i < 0) fail('TILE_NOT_OWNED'); return i; }).sort((a, b) => a - b);
  const drawn = w.priv.bag.splice(0, idx.length), old = idx.map(i => rack[i]);
  idx.forEach((i, k) => { rack[i] = drawn[k]; });
  w.priv.bag.push(...old.map(t => ({ ...t, as: null }))); shuffle(w.priv.bag, deps.rng);
  w.priv.undo = null; g.tahkim = { state: 'none' }; g.tahkim_available = false; clearUndo(w);
  const row = { player_id: userId, seat, turn_number: turnNo(w), action_type: 'swap', placements: [], formed_words: [], score_delta: 0, validation_result: 'skipped', bingo: false, swap_count: idx.length };
  nextTurn(w, now, false); withBagCount(w);
  return { patch: patchOf(w, 'SWAP_COMMITTED', { racks: [userId], private: true, move: row }) };
}

// ---------- Tahkim ----------
// v5.5: Tahkim is a shared DISCUSSION, decided by agreement. State machine:
//     none -> discussion -> resolved_valid | resolved_invalid  (-> none again on the next committed action)
// The challenger is the player now on turn. The moment the request is accepted by the server (a reason is mandatory) the match is frozen (status tahkim_pending, both clocks
// stopped, every gameplay action refused) and both players share ONE chat. Each player independently chooses a final verdict (valid / invalid) and may change it as often as
// they like; only when both CURRENT choices are the same does the server resolve the dispute, in the same atomic commit as the second choice. Neither player can finalise alone.
// Nothing here expires: no approval limit, no ruling limit. The state (reason, chat, both choices) lives in the game row, so it survives refreshes and reconnections.
// The ways out are an agreement, a surrender (resign) or the other player's explicit abandon claim after ABANDON_MS of silence (claimAbandon).
export const TAHKIM_REASON_MIN = 3, TAHKIM_REASON_MAX = 160;
const stripCtl = r => (typeof r === 'string' ? r.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim() : '');
export const cleanReason = stripCtl;
export const cleanChat = stripCtl;
const inDiscussion = g => g.status === STATUS.TAHKIM && g.tahkim && g.tahkim.state === 'discussion';
export function requestTahkim(w, userId, req, now) {
  const seat = requireTurn(w, userId), g = w.game, last = w.moves[w.moves.length - 1];
  if (!w.priv.undo || !last || last.action_type !== 'move' || last.tahkim_status) fail('NO_TAHKIM');
  const reason = cleanReason(req && req.reason);
  if ([...reason].length < TAHKIM_REASON_MIN) fail('REASON_REQUIRED');
  if ([...reason].length > TAHKIM_REASON_MAX) fail('BAD_REQUEST', 'السبب طويل جدًا.');
  settle(w, now); clearUndo(w);
  g.status = STATUS.TAHKIM; g.turn_started_at = null; g.turn_deadline_at = null;   // both clocks stop for the whole discussion
  g.tahkim = { state: 'discussion', move_number: last.turn_number, challenger_seat: seat, reason, words: (last.formed_words || []).map(x => x.w).filter(Boolean),
    requested_at: now, chat: [], chat_n: 0, choices: [null, null] };
  return { patch: patchOf(w, 'TAHKIM_REQUESTED', { private: true }) };
}
// A message in the shared chat. No time limit, no turn order. Only while the discussion is open.
export function tahkimSay(w, userId, req, now) {
  const seat = requireMember(w, userId), g = w.game;
  if (!inDiscussion(g)) fail('NOT_DISCUSSING');
  const text = [...cleanChat(req && req.text)].slice(0, TAHKIM_CHAT_MAX_CHARS + 1);
  if (!text.length) fail('BAD_REQUEST', 'الرسالة فارغة.');
  if (text.length > TAHKIM_CHAT_MAX_CHARS) fail('BAD_REQUEST', 'الرسالة طويلة جدًا.');
  const t = g.tahkim, n = (t.chat_n || 0) + 1;
  const chat = [...(t.chat || []), { i: n, s: seat, t: text.join(''), at: now }].slice(-TAHKIM_CHAT_MAX_MESSAGES);
  g.tahkim = { ...t, chat, chat_n: n };
  return { patch: patchOf(w, 'TAHKIM_MESSAGE', { private: true }) };
}
// A player's CURRENT choice (null takes it back). When both current choices are the same the dispute is settled right here, in the same commit.
export function tahkimChoose(w, userId, req, now, deps) {
  const seat = requireMember(w, userId), g = w.game;
  if (!inDiscussion(g)) fail('NOT_DISCUSSING');
  const v = req && req.verdict;
  if (v !== 'valid' && v !== 'invalid' && v !== null) fail('BAD_REQUEST');
  const choices = [...(g.tahkim.choices || [null, null])]; choices[seat] = v;
  g.tahkim = { ...g.tahkim, choices };
  if (choices[0] && choices[0] === choices[1]) return settleTahkim(w, choices[0], now, deps);
  return { patch: patchOf(w, 'TAHKIM_CHOICE', { private: true }) };
}
// Applies the agreed verdict. Only reachable from tahkimChoose, so a verdict can never come from one player alone.
function settleTahkim(w, verdict, now, deps) {
  const g = w.game, t = g.tahkim, challenger = t.challenger_seat, u = w.priv.undo, last = w.moves[w.moves.length - 1];
  if (!u || !last || last.turn_number !== t.move_number) fail('NO_TAHKIM');
  const rec = { n: t.move_number, by: challenger, words: t.words || [], reason: t.reason, verdict, at: now, penalty: 0 };
  const done = { state: verdict === 'valid' ? 'resolved_valid' : 'resolved_invalid', move_number: t.move_number, challenger_seat: challenger, reason: t.reason, words: t.words || [],
    verdict, resolved_at: now, msgs: t.chat_n || 0 };   // the chat itself is not kept once the dispute is settled; the record above is
  const record = () => setExt(g, { tahkim_log: [...(extOf(g).tahkim_log || []), rec].slice(-TAHKIM_LOG_MAX) });   // always BEFORE patchOf, which copies ext
  g.status = STATUS.ACTIVE;
  if (verdict === 'valid') {
    const ch = playerBySeat(w, challenger), pen = challengePenalty(ch.score); ch.score -= pen; rec.penalty = pen;
    w.priv.undo = null; g.tahkim_available = false; g.tahkim = done;
    restartClock(w, now); record();
    return { patch: patchOf(w, 'TAHKIM_RESOLVED', { private: true, move_update: { turn_number: last.turn_number, tahkim_status: 'ok', penalty: pen } }), verdict: 'valid', penalty: pen };
  }
  // invalid: the move is void. Board, racks, bag and scores go back to before the move (clocks are kept), and the mover loses the turn.
  g.board = clone(u.board);
  for (const p of w.players) { w.racks[p.player_id] = clone(u.racks[p.player_id]); p.score = u.scores[p.player_id]; p.tile_count = u.tile_counts[p.player_id]; }
  w.priv.bag = clone(u.bag); if (deps && deps.rng) shuffle(w.priv.bag, deps.rng);   // the mover saw the tiles they drew: put them back in a NEW order
  [...w.priv.bag, ...Object.values(w.racks).flat()].forEach(x => { if (x && x.blank) x.as = null; });
  g.clock_started = u.started; g.tahkim = done;
  { const m = playerBySeat(w, u.cur_seat); m.ms_left = Math.max(0, m.ms_left - (u.inc || 0)); }   // a voided move earns no time
  w.priv.undo = null; g.tahkim_available = false; withBagCount(w);
  g.current_seat = u.cur_seat; nextTurn(w, now, false);   // restores the mover, then the turn passes to the challenger
  record();
  return { patch: patchOf(w, 'TAHKIM_RESOLVED', { racks: 'all', private: true, move_update: { turn_number: last.turn_number, tahkim_status: 'void', penalty: 0 } }), verdict: 'invalid' };
}

// ---------- undo with the opponent's approval ----------
// The player who has just moved (and so is waiting for the other one) may ask to take the move back, provided the other player has not acted yet.
// The player on turn answers. Approval restores board, racks, bag and scores to before the move and gives the turn back to the mover (clocks are kept,
// the responder's thinking time is charged). Declining ends it: the same move cannot be asked for again. Acting on the move (move, pass, swap, Tahkim)
// is an implicit decline. The move stays in the history, marked void.
export function requestUndo(w, userId, now) {
  const seat = requireMember(w, userId), g = w.game, last = w.moves[w.moves.length - 1], x = extOf(g);
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (isPaused(g)) fail('PAUSED');
  if (!w.priv.undo || !last || last.action_type !== 'move' || last.tahkim_status || last.seat !== seat || g.current_seat === seat) fail('NO_UNDO');
  if (x.undo && x.undo.move_number === last.turn_number) fail(x.undo.state === 'pending' ? 'UNDO_PENDING' : 'UNDO_DECLINED');
  setExt(g, { undo: { state: 'pending', by: seat, move_number: last.turn_number, at: now } });
  return patchOf(w, 'UNDO_REQUESTED');
}
export function cancelUndo(w, userId) {
  const seat = requireMember(w, userId), x = extOf(w.game).undo;
  if (!x || x.state !== 'pending' || x.by !== seat) fail('NO_UNDO');
  setExt(w.game, { undo: null });
  return patchOf(w, 'UNDO_CANCELLED');
}
export function respondUndo(w, userId, req, now, deps) {
  const seat = requireMember(w, userId), g = w.game, x = extOf(g).undo;
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (isPaused(g)) fail('PAUSED');
  if (!x || x.state !== 'pending' || x.by === seat) fail('NO_UNDO');
  if (typeof req.accept !== 'boolean') fail('BAD_REQUEST');
  if (!req.accept) { setExt(g, { undo: { ...x, state: 'declined' } }); return patchOf(w, 'UNDO_DECLINED'); }
  const u = w.priv.undo, last = w.moves[w.moves.length - 1];
  if (!u || !last || last.turn_number !== x.move_number) fail('NO_UNDO');
  settle(w, now);   // the responder's thinking time up to now is charged to them
  g.board = clone(u.board);
  for (const p of w.players) { w.racks[p.player_id] = clone(u.racks[p.player_id]); p.score = u.scores[p.player_id]; p.tile_count = u.tile_counts[p.player_id]; }
  w.priv.bag = clone(u.bag); if (deps && deps.rng) shuffle(w.priv.bag, deps.rng);   // same reason as a voided move: the mover knows the tiles they drew
  [...w.priv.bag, ...Object.values(w.racks).flat()].forEach(t => { if (t && t.blank) t.as = null; });
  g.clock_started = u.started; g.current_seat = u.cur_seat;
  { const m = playerBySeat(w, u.cur_seat); m.ms_left = Math.max(0, m.ms_left - (u.inc || 0)); }   // a move taken back earns no time
  w.priv.undo = null; g.tahkim_available = false; g.tahkim = { state: 'none' }; withBagCount(w); setExt(g, { undo: null });
  restartClock(w, now);
  return { patch: patchOf(w, 'UNDO_ACCEPTED', { racks: 'all', private: true, move_update: { turn_number: last.turn_number, tahkim_status: 'void', penalty: 0 } }) };
}

// ---------- pause ----------
// Either player may stop both clocks (PAUSES_EACH times each, PAUSE_MS at most). While paused nothing can be played. The player who paused may resume
// at any time; the other player may resume once the time is up; the first gameplay action after it also resumes (autoResume). Both clocks only restart at the resume.
export function pauseGame(w, userId, now) {
  const seat = requireMember(w, userId), g = w.game, x = extOf(g);
  if (g.status === STATUS.TAHKIM) fail('TAHKIM_PENDING');
  if (g.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (x.pause) fail('PAUSED');
  if (x.undo && x.undo.state === 'pending') fail('UNDO_PENDING');
  const used = (x.pauses || [0, 0])[seat] || 0;
  if (used >= PAUSES_EACH) fail('NO_PAUSES_LEFT');
  settle(w, now);
  const pauses = [...(x.pauses || [0, 0])]; pauses[seat] = used + 1;
  g.turn_started_at = null; g.turn_deadline_at = null;
  setExt(g, { pause: { by: seat, at: now, until: now + PAUSE_MS }, pauses });
  return patchOf(w, 'GAME_PAUSED');
}
export function resumeGame(w, userId, now) {
  const seat = requireMember(w, userId), g = w.game, x = extOf(g);
  if (g.status !== STATUS.ACTIVE || !x.pause) fail('NOT_PAUSED');
  if (x.pause.by !== seat && now < x.pause.until) fail('NOT_YOURS_TO_RESUME');
  setExt(g, { pause: null }); restartClock(w, now);
  return patchOf(w, 'GAME_RESUMED');
}
// Called by the service before any action (except resume itself): an expired pause ends by itself, so a stopped game can never block play.
export function autoResume(w, now) {
  const g = w.game, x = extOf(g);
  if (x.pause && g.status === STATUS.ACTIVE && now >= x.pause.until) { setExt(g, { pause: null }); restartClock(w, now); }
}

// ---------- things that happen because time passed (applied by the service before any action and by the heartbeat) ----------
// A clock that has run out ends the game as soon as ANY request reaches the server, so an expired player can no longer freeze it with a pause, a Tahkim request or an undo.
export function expiredPatch(w, now) {
  const g = w.game;
  if (g.status !== STATUS.ACTIVE || !clockRunning(g) || liveMs(w, g.current_seat, now) > 0) return null;
  finish(w, 'time', now);
  return { patch: patchOf(w, 'GAME_ENDED', { private: true, racks: 'all' }), ended: 'time' };
}
// (v5.5: a Tahkim discussion has no time limit and never lapses by itself.)

// ---------- end / time / resign / rematch ----------
export function resign(w, userId, now) {
  const seat = requireMember(w, userId);
  if (!PLAYING.includes(w.game.status)) fail('WRONG_STATUS');
  finish(w, 'resign', now, seat);
  return { patch: patchOf(w, 'GAME_ENDED', { private: true }) };
}
// Anyone may ask; only the server's own clock decides.
export function claimTimeout(w, userId, now) {
  requireMember(w, userId);
  if (w.game.status !== STATUS.ACTIVE) fail('WRONG_STATUS');
  if (!clockRunning(w.game) || liveMs(w, w.game.current_seat, now) > 0) fail('NOT_EXPIRED');
  finish(w, 'time', now);
  return { patch: patchOf(w, 'GAME_ENDED', { private: true, racks: 'all' }) };
}
// The player the match is waiting for: whoever is on turn, or, in a Tahkim discussion, the player who has not made a choice yet while the other has.
// (null when nobody is singled out: nothing chosen yet, or both chose and differ.)
export const blockingSeat = g => {
  if (g.status !== STATUS.TAHKIM) return g.current_seat;
  const c = (g.tahkim && g.tahkim.choices) || [null, null];
  return c[0] && !c[1] ? 1 : c[1] && !c[0] ? 0 : null;
};
// How long the server has heard nothing from a player (every action and every heartbeat refreshes last_seen_at).
export const idleMs = (w, seat, now) => { const p = playerBySeat(w, seat); return p && p.last_seen_at != null ? Math.max(0, now - p.last_seen_at) : 0; };
// The other player may end the match in their favour once the one being waited for has been silent for ABANDON_MS. Only the server's own
// knowledge counts, so a browser cannot claim early. In a Tahkim discussion nobody is singled out, so the claim is against the OTHER player: a discussion is only ever
// ended by an agreement, a surrender or this explicit claim, never by a timer.
export function claimAbandon(w, userId, now) {
  const seat = requireMember(w, userId);
  if (!PLAYING.includes(w.game.status)) fail('WRONG_STATUS');
  const waiting = w.game.status === STATUS.TAHKIM ? other(seat) : blockingSeat(w.game);
  if (waiting == null || waiting === seat) fail('NOT_ABANDONED');
  if (idleMs(w, waiting, now) < ABANDON_MS) fail('NOT_ABANDONED');
  finish(w, 'abandon', now, waiting);
  return { patch: patchOf(w, 'GAME_ENDED', { private: true }) };
}
export function requestRematch(w, userId, now, deps) {
  const seat = requireMember(w, userId), g = w.game;
  if (g.status !== STATUS.FINISHED) fail('WRONG_STATUS');
  const set = new Set(g.rematch_seats || []); set.add(seat); g.rematch_seats = [...set].sort();
  if (set.size < 2) return { patch: patchOf(w, 'REMATCH_REQUESTED') };
  g.round += 1; deal(w, now, deps);   // a brand-new bag and racks; nothing of the previous round is reused
  return { patch: patchOf(w, 'GAME_STARTED', { racks: 'all', private: true }) };
}
