// What a player is allowed to see. This is the ONLY place server state becomes client-visible data, so the privacy rules are
// enforced here once: the board, scores, tile COUNTS, clock, Tahkim state and move history are public; the caller's own rack is
// included; the opponent's rack, the bag (only its size) and the undo snapshot are never included.
import { STATUS, clockRunning, seatOf, playerBySeat, idleMs, blockingSeat, extOf } from './engine.js';
import { PAUSES_EACH } from '../game/config.js';
import { fail } from './errors.js';

export function historyItem(m, tk) {
  const it = { n: m.turn_number, p: m.seat, type: m.action_type, words: m.formed_words || [], total: m.score_delta, bingo: !!m.bingo };
  if (m.action_type === 'swap') it.cnt = m.swap_count;
  if (m.action_type === 'move') it.cells = (m.placements || []).map(x => [x.row, x.col]);   // where the move landed (the board is public; tile ids are not sent)
  if (m.tahkim_status) it.st = m.tahkim_status;
  if (m.penalty) it.pen = m.penalty;
  if (tk) it.tk = { reason: tk.reason, verdict: tk.verdict, at: tk.at, words: tk.words || [], by: tk.by, pen: tk.penalty || 0 };   // the recorded Tahkim of this move
  return it;
}

export function buildSnapshot(w, userId, now) {
  const seat = seatOf(w, userId);
  if (seat < 0) fail('NOT_MEMBER');
  const g = w.game, me = playerBySeat(w, seat);
  return {
    server_now: now,
    game: {
      id: g.id, room_code: g.room_code, host_player_id: g.host_player_id, status: g.status, tile_mode: g.tile_mode, minutes: g.minutes,
      round: g.round, revision: g.revision, current_seat: g.current_seat, turn_started_at: g.turn_started_at, turn_deadline_at: g.turn_deadline_at, clock_running: clockRunning(g),
      clock_started: g.clock_started, tahkim: g.tahkim, tahkim_available: !!g.tahkim_available, bag_count: g.bag_count, result: g.result, winner_seat: g.winner_seat,
      rematch_seats: g.rematch_seats || [], started_at: g.started_at, finished_at: g.finished_at,
      live: extOf(g).live !== false,   // live preview of the tentative tiles: on unless the host switched it off
      pause: extOf(g).pause || null, pauses_left: [0, 1].map(i => Math.max(0, PAUSES_EACH - ((extOf(g).pauses || [0, 0])[i] || 0))),
      first: extOf(g).first || null,   // how the first player was drawn: [[tile, tile], ...] (public, see drawFirst)
      tahkim_log: extOf(g).tahkim_log || [],   // every resolved Tahkim of this round: disputed words, reason, agreed verdict, time
      undo_req: extOf(g).undo || null   // the mover's request to take a move back (public; NOT the private undo snapshot)
    },
    players: [...w.players].sort((a, b) => a.seat - b.seat).map(p => ({ player_id: p.player_id, seat: p.seat, nickname: p.nickname, score: p.score, tile_count: p.tile_count,
      ms_left: p.ms_left, ready: p.ready, connection_state: p.connection_state, idle_ms: idleMs(w, p.seat, now) })),
    // who the match is waiting for (the only seat that can be claimed against). In a Tahkim discussion nobody is singled out: either player may claim against a vanished opponent.
    waiting_seat: g.status === STATUS.TAHKIM ? 1 - seat : g.status === STATUS.ACTIVE ? blockingSeat(g) : null,
    board: g.board,
    moves: w.moves.map(m => historyItem(m, (extOf(g).tahkim_log || []).find(x => x.n === m.turn_number))),
    me: { player_id: userId, seat, rack: w.racks[me.player_id] || [] }
  };
}
