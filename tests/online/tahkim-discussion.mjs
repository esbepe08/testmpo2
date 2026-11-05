import { makeWorld, suite, across } from './lib.mjs';
import { TAHKIM_CHAT_MAX_MESSAGES, TAHKIM_CHAT_MAX_CHARS, ABANDON_MS } from '../../supabase/functions/_shared/game/config.js';
const { ok, group, done } = suite('online tahkim discussion: shared chat, mutual agreement, lock, persistence, record');
const MIN = 60000, SEC = 1000;
async function challenged(seed = 7) {
  const w = makeWorld({ seed }); await w.start({ minutes: 10 });
  w.giveRack('A', [...'كتاب']); await w.call('A', 'snapshot');
  await w.call('A', 'submit_move', { placements: across(w.snap.A, 'كتاب') }); await w.call('B', 'snapshot');
  const r = await w.call('B', 'request_tahkim', { reason: 'كلمة غير صحيحة' }); await w.call('A', 'snapshot');
  return { w, r };
}

group('opening: both players get the same discussion, clocks stopped');
{
  const { w, r } = await challenged();
  const A = w.snap.A, B = w.snap.B;
  ok(r.ok && A.game.status === 'tahkim_pending' && A.game.tahkim.state === 'discussion', 'the discussion is open for both');
  ok(JSON.stringify(A.game.tahkim) === JSON.stringify(B.game.tahkim), 'both players read the very same state');
  ok(A.game.tahkim.words.join() === 'كتاب' && A.game.tahkim.reason === 'كلمة غير صحيحة', 'the disputed word and the reason are in it');
  ok(A.game.clock_running === false && A.game.turn_started_at === null, 'both clocks are stopped');
  const before = A.players.map(p => p.ms_left); w.clock.t += 45 * MIN;
  const s = (await w.call('A', 'snapshot')).snapshot; ok(s.players.map(p => p.ms_left).join() === before.join(), 'no time is charged while they talk');
}

group('chat: no time limit, no turn order, both directions, sanitised, bounded');
{
  const { w } = await challenged(8);
  const m1 = await w.call('A', 'tahkim_say', { text: 'مرحبا' }); ok(m1.ok, 'A writes');
  const m2 = await w.call('A', 'tahkim_say', { text: 'هل ترى ذلك؟' }); ok(m2.ok, 'A writes again without waiting for B');
  w.clock.t += 3 * 60 * MIN;
  const m3 = await w.call('B', 'tahkim_say', { text: '  رأيي \n\u202e مختلف  ' }); ok(m3.ok, 'B writes three hours later: still allowed');
  const c = m3.snapshot.game.tahkim.chat;
  ok(c.length === 3 && c.map(x => x.s).join() === '0,0,1' && c.map(x => x.i).join() === '1,2,3', 'history is kept in order with author and id');
  ok(c[2].t === 'رأيي مختلف', 'control / bidi characters are stripped: ' + c[2].t);
  for (const bad of ['', '   ', 5, undefined, 'x'.repeat(TAHKIM_CHAT_MAX_CHARS + 1)]) { const r = await w.call('A', 'tahkim_say', { text: bad }); ok(!r.ok && r.code === 'BAD_REQUEST', `bad message ${String(bad).slice(0, 8)} refused`); }
  for (let i = 0; i < TAHKIM_CHAT_MAX_MESSAGES + 5; i++) await w.call('B', 'tahkim_say', { text: 'm' + i });
  const s = (await w.call('A', 'snapshot')).snapshot.game.tahkim;
  ok(s.chat.length === TAHKIM_CHAT_MAX_MESSAGES && s.chat_n > TAHKIM_CHAT_MAX_MESSAGES && s.chat[s.chat.length - 1].t === 'm' + (TAHKIM_CHAT_MAX_MESSAGES + 4), 'the chat is bounded: the oldest messages are dropped, ids keep counting');
}

group('mutual agreement: same verdict only; different keeps it open; choices can change');
{
  const { w } = await challenged(9);
  const a1 = await w.call('A', 'tahkim_choose', { verdict: 'valid' });
  ok(a1.ok && a1.snapshot.game.status === 'tahkim_pending' && a1.snapshot.game.tahkim.choices.join() === 'valid,', 'one choice alone finalises nothing');
  const b1 = await w.call('B', 'tahkim_choose', { verdict: 'invalid' });
  ok(b1.ok && b1.snapshot.game.status === 'tahkim_pending', 'different choices: the discussion stays open');
  ok(b1.snapshot.game.tahkim.choices.join() === 'valid,invalid', 'both current choices are visible to both');
  const talk = await w.call('A', 'tahkim_say', { text: 'لننظر في القاعدة' }); ok(talk.ok, 'and the talk goes on');
  const a2 = await w.call('A', 'tahkim_choose', { verdict: null }); ok(a2.ok && a2.snapshot.game.tahkim.choices.join() === ',invalid', 'a choice can be taken back');
  const a3 = await w.call('A', 'tahkim_choose', { verdict: 'invalid' });
  ok(a3.ok && a3.snapshot.game.status === 'active' && a3.snapshot.game.tahkim.state === 'resolved_invalid', 'A changes their mind: the same verdict settles it');
  ok(a3.snapshot.game.tahkim.chat === undefined && a3.snapshot.game.tahkim.msgs === 1, 'the settled state keeps no chat, only its size');
  const late = await w.call('B', 'tahkim_choose', { verdict: 'valid' }); ok(!late.ok && late.code === 'NOT_DISCUSSING', 'after settlement nothing more can be chosen or said');
  const late2 = await w.call('B', 'tahkim_say', { text: 'x' }); ok(!late2.ok && late2.code === 'NOT_DISCUSSING', 'chat is closed');
  for (const v of ['maybe', 1, {}, 'VALID']) { const bad = makeWorld({ seed: 91 }); }
}
{
  const { w } = await challenged(10);
  for (const v of ['maybe', 1, {}, 'VALID', undefined]) { const r = await w.call('A', 'tahkim_choose', { verdict: v }); ok(!r.ok && r.code === 'BAD_REQUEST', `verdict ${JSON.stringify(v)} refused`); }
}

group('atomic: two players choosing at the same moment settle exactly once');
{
  const { w } = await challenged(11);
  const body = (k, v) => ({ action: 'tahkim_choose', game_id: w.gameId, client_action_id: w.deps.uuid(), verdict: v });
  const [x, y] = await Promise.all([w.raw('A', body('A', 'valid')), w.raw('B', body('B', 'valid'))]);
  const s = (await w.call('A', 'snapshot')).snapshot;
  ok(x.ok && y.ok, 'both requests succeed');
  ok(s.game.status === 'active' && s.game.tahkim.state === 'resolved_valid', 'settled');
  ok(s.game.tahkim_log.length === 1, 'recorded once, not twice');
  const pen = s.players.reduce((t, p) => t + p.score, 0);
  ok(s.moves[0].st === 'ok', 'the move is marked valid once');
}

group('valid: challenger pays the penalty; invalid: move void, mover loses the turn');
{
  const { w } = await challenged(12);
  await w.call('A', 'tahkim_choose', { verdict: 'valid' }); const r = await w.call('B', 'tahkim_choose', { verdict: 'valid' });
  const rec = r.snapshot.game.tahkim_log[0];
  ok(rec.penalty === 0 && r.snapshot.players[1].score === 0, 'the challenger had 0 points: the penalty is capped by their score');
  ok(r.snapshot.moves[0].st === 'ok' && r.snapshot.game.current_seat === 1, 'the move stands and B stays on turn');
  ok(r.snapshot.game.clock_running, 'the clocks run again');
}

group('gameplay lock: nothing changes before the discussion is settled');
{
  const { w } = await challenged(13);
  const snapBefore = JSON.stringify([w.snap.A.board, w.snap.A.players.map(p => [p.score, p.ms_left]), w.snap.A.game.current_seat, w.snap.A.moves]);
  const tries = [['B', 'submit_move', { placements: [{ tileId: 'x', row: 7, col: 7 }] }], ['B', 'pass_turn'], ['B', 'swap_tiles', { tileIds: ['a'] }], ['A', 'request_undo'], ['A', 'cancel_undo'], ['B', 'pause_game'], ['A', 'pause_game'],
    ['B', 'resume_game'], ['B', 'request_tahkim', { reason: 'again again' }], ['B', 'claim_timeout'], ['A', 'respond_undo', { accept: true }]];
  for (const [k, act, ex] of tries) { const r = await w.call(k, act, ex || {}); ok(!r.ok, `${k} ${act} refused during Tahkim (${r.code})`); }
  const s = (await w.call('A', 'snapshot')).snapshot;
  ok(JSON.stringify([s.board, s.players.map(p => [p.score, p.ms_left]), s.game.current_seat, s.moves]) === snapBefore, 'board, scores, clocks, turn and history are untouched');
  ok(s.game.status === 'tahkim_pending', 'still frozen');
}

group('only members can take part');
{
  const { w } = await challenged(14);
  const x = await w.raw('C', { action: 'tahkim_say', game_id: w.gameId, client_action_id: w.deps.uuid(), text: 'hi' }); ok(!x.ok && x.code === 'NOT_MEMBER', 'a stranger cannot write');
  const y = await w.raw('C', { action: 'tahkim_choose', game_id: w.gameId, client_action_id: w.deps.uuid(), verdict: 'valid' }); ok(!y.ok && y.code === 'NOT_MEMBER', 'a stranger cannot choose');
  const z = await w.raw('C', { action: 'snapshot', game_id: w.gameId }); ok(!z.ok, 'a stranger cannot read the chat');
}

group('persistence: refresh, reconnection, a long silence; nothing expires');
{
  const { w } = await challenged(15);
  await w.call('A', 'tahkim_say', { text: 'مرحبا' }); await w.call('B', 'tahkim_choose', { verdict: 'valid' }); await w.call('A', 'tahkim_choose', { verdict: 'invalid' });
  w.clock.t += 26 * 60 * MIN;   // 26 hours, nobody does anything
  const rec = await w.raw('A', { action: 'reconnect' });   // a refreshed page
  const g = rec.snapshot.game;
  ok(g.status === 'tahkim_pending' && g.tahkim.chat.length === 1 && g.tahkim.choices.join() === 'invalid,valid', 'after a reconnection the chat and both decisions are exactly as left');
  ok(rec.snapshot.players.every(p => p.ms_left > 0) && rec.snapshot.game.clock_running === false, 'frozen game state intact');
  const hb = await w.raw('B', { action: 'heartbeat', game_id: w.gameId }); ok(hb.status === 'tahkim_pending', 'a heartbeat does not end it');
  const other = await w.raw('B', { action: 'reconnect' }); ok(other.snapshot.game.tahkim.chat[0].t === 'مرحبا', 'the other player sees the same history');
  const done = await w.call('B', 'tahkim_choose', { verdict: 'invalid' }); ok(done.ok && done.snapshot.game.status === 'active', 'they can still settle it after all that time');
}
{
  const { w } = await challenged(16);   // surrender and abandon stay available, and score rules still hold
  const r = await w.call('A', 'resign_game'); ok(r.ok && r.snapshot.game.status === 'finished' && r.snapshot.players.find(p => p.seat === w.seatOfUser('A')).score === 0, 'surrender during a discussion works (explicit procedure)');
}

group('record: disputed words, reason, agreed verdict, timestamp, kept in the history');
{
  const { w } = await challenged(17);
  const at = w.clock.t += 5 * SEC;
  await w.call('B', 'tahkim_choose', { verdict: 'invalid' }); const r = await w.call('A', 'tahkim_choose', { verdict: 'invalid' });
  const log = r.snapshot.game.tahkim_log;
  ok(log.length === 1 && log[0].n === 1 && log[0].words.join() === 'كتاب' && log[0].reason === 'كلمة غير صحيحة' && log[0].verdict === 'invalid' && log[0].at === at && log[0].by === 1, 'the log has word, reason, verdict, time and challenger');
  const m = r.snapshot.moves[0]; ok(m.st === 'void' && m.tk && m.tk.verdict === 'invalid' && m.tk.reason === 'كلمة غير صحيحة' && m.tk.at === at, 'and the move in the history carries it');
  const other = (await w.call('B', 'snapshot')).snapshot; ok(JSON.stringify(other.moves[0].tk) === JSON.stringify(m.tk), 'both players see the same record');
  const text = JSON.stringify(r.snapshot); ok(!/"bag"|"undo"/.test(text), 'no private data leaks into the snapshot');
}
done();
