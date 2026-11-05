// v5.4 hardening: surrender rule, expired clocks, bag reshuffle after a voided/undone move, pinned "ready", Tahkim timeouts and one-use challenges,
// room-code guessing limit, one open game per player under a race, and the public build folder.
import { execFileSync } from 'child_process'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { makeWorld, suite } from './lib.mjs';
import { ABANDON_MS } from '../../supabase/functions/_shared/game/config.js';
const { ok, group, done } = suite('v5.4 hardening');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEC = 1000;
const mv = (w, who, n, row) => { const rack = w.snap[who].me.rack.filter(Boolean).slice(0, n);
  return w.call(who, 'submit_move', { placements: rack.map((t, i) => ({ tileId: t.id, row, col: 7 + i, as: t.blank ? 'ا' : undefined })) }); };
// A moved (row 7), B moved (row 8): A is on turn and may challenge B's move, etc. Returns who is on turn ("a") and the other ("b").
async function twoMoves(seed) {
  const w = makeWorld({ seed }); await w.start();
  const a = w.who(w.turn()), b = a === 'A' ? 'B' : 'A';
  await mv(w, a, 3, 7); await w.call(b, 'snapshot'); await mv(w, b, 3, 8); await w.call(a, 'snapshot');
  return { w, a, b };
}
// A moved once: b is on turn and may challenge a's move.
async function oneMove(seed) {
  const w = makeWorld({ seed }); await w.start();
  const a = w.who(w.turn()), b = a === 'A' ? 'B' : 'A';
  const r = await mv(w, a, 3, 7); await w.call(b, 'snapshot');
  return { w, a, b, moved: r.ok };
}

group('surrender: score drops to 0 and the other player wins');
{
  const { w, a, b } = await twoMoves(31);
  const before = w.snap[a].players.map(p => p.score);
  ok(before.some(s => s > 0), 'both sides have points before the surrender: ' + before);
  const r = await w.call(a, 'resign_game');
  const g = r.snapshot.game, me = r.snapshot.me.seat;
  ok(r.ok && g.status === 'finished' && g.result.reason === 'resign' && g.winner_seat === 1 - me, 'the other player is the winner');
  ok(r.snapshot.players[me].score === 0, 'the surrendering player has 0');
  ok(g.result.lines.find(l => l.seat === me).score === 0 && g.result.loser_seat === me, 'the result card carries the 0 and names the loser');
  const winner = r.snapshot.players[1 - me];
  ok(winner.score === before[1 - me], 'the winner keeps the score earned (no bonus, no deduction on a surrender)');
}
{
  // the surrendering player even leads on points and still loses
  const w = makeWorld({ seed: 32 }); await w.start();
  const a = w.who(w.turn()), b = a === 'A' ? 'B' : 'A';
  await mv(w, a, 3, 7);
  const lead = w.snap[a].players[w.snap[a].me.seat].score;
  await w.call(a, 'snapshot'); const r = await w.call(a, 'resign_game');
  ok(lead > 0 && r.snapshot.game.winner_seat === 1 - r.snapshot.me.seat && r.snapshot.players[r.snapshot.me.seat].score === 0, 'a leader who surrenders still loses and drops to 0');
  const rb = await w.call(b, 'snapshot'); ok(rb.snapshot.game.result.lines.length === 2 && rb.snapshot.game.winner_seat === 1 - r.snapshot.me.seat, 'the opponent sees the identical result');
}
{
  // abandon (vanished player) is a different case: scores are kept
  const { w, a, b } = await twoMoves(33); const sc = w.snap[b].players.map(p => p.score);
  w.clock.t += ABANDON_MS + SEC; const r = await w.call(b, 'claim_abandon');
  ok(r.ok && r.snapshot.game.result.reason === 'abandon' && r.snapshot.players.every((p, i) => p.score === sc[i]), 'an abandon claim keeps the scores');
}

group('an expired clock cannot be frozen');
{
  const { w, a } = await twoMoves(41); w.clock.t += 26 * 60 * SEC;   // a's whole clock is gone
  const p = await w.call(a, 'pause_game');
  ok(!p.ok && p.code === 'TIME_UP' && p.snapshot.game.status === 'finished' && p.snapshot.game.result.reason === 'time', 'pause by a player with no time left ends the match on time instead');
}
{
  const { w, a, b } = await twoMoves(42); w.clock.t += 26 * 60 * SEC;
  const t = await w.call(a, 'request_tahkim', { reason: 'abc xyz' });
  ok(!t.ok && t.snapshot.game.status === 'finished' && t.snapshot.game.result.reason === 'time', 'a Tahkim request cannot be used to dodge the clock either');
  const again = await w.call(b, 'claim_timeout'); ok(!again.ok && again.code === 'WRONG_STATUS', 'and the opponent is not left with a stuck game');
}
{
  const { w, a, b } = await twoMoves(43); w.clock.t += 26 * 60 * SEC;
  const x = await w.call(b, 'request_undo');   // b has just moved; it is a's clock that ran out
  ok(!x.ok && x.snapshot.game.result && x.snapshot.game.result.reason === 'time', 'any request that reaches the server settles an expired clock first');
}
{
  const { w, a } = await twoMoves(44); w.clock.t += 26 * 60 * SEC;
  const r = await w.call(a, 'resign_game');
  ok(r.ok && r.snapshot.game.result.reason === 'resign', 'resigning is still honoured as a resignation (not turned into a time loss)');
}

group('undo and a voided move reshuffle the bag');
{
  const { w, a, b } = await oneMove(51);
  const bagAfterMove = w.server().priv.bag.map(t => t.id);   // what the mover drew is the end of this bag; undo restores the pre-move bag
  await w.call(a, 'request_undo'); await w.call(b, 'snapshot');
  const bagBefore = w.server().priv.undo.bag.map(t => t.id);
  const r = await w.call(b, 'respond_undo', { accept: true });
  const bagNow = w.server().priv.bag.map(t => t.id);
  ok(r.ok && [...bagNow].sort().join() === [...bagBefore].sort().join(), 'undo gives back exactly the tiles of the bag');
  ok(bagNow.join() !== bagBefore.join(), 'but in a new order: the mover cannot know what they would draw next');
}
{
  const { w, a, b } = await oneMove(52);
  await w.call(b, 'request_tahkim', { reason: 'abc xyz' }); await w.call(b, 'tahkim_choose', { verdict: 'invalid' });
  const bagBefore = w.server().priv.undo.bag.map(t => t.id);
  const r = await w.call(a, 'tahkim_choose', { verdict: 'invalid' });
  const bagNow = w.server().priv.bag.map(t => t.id);
  ok(r.ok && [...bagNow].sort().join() === [...bagBefore].sort().join() && bagNow.join() !== bagBefore.join(), 'a voided move also returns the tiles in a new order');
}

group('"ready" is pinned to the revision the guest has seen');
{
  const w = makeWorld({ seed: 61 }); await w.room({ minutes: 25 });
  const seen = w.snap.B.game.revision;
  await w.call('A', 'update_settings', { settings: { minutes: 60 } });
  const stale = await w.raw('B', { action: 'set_ready', game_id: w.gameId, client_action_id: '11111111-1111-4111-8111-111111111111', base_revision: seen, ready: true });
  ok(!stale.ok && stale.code === 'STALE_STATE' && stale.snapshot.game.minutes === 60, 'a ready flag given on a screen that has not seen the new rules is refused (and the screen is brought up to date)');
  const fresh = await w.call('B', 'snapshot'); const good = await w.call('B', 'set_ready', { ready: true });
  ok(good.ok && good.snapshot.players.find(p => p.seat === 1).ready === true, 'after seeing the rules the same confirmation works');
}

group('Tahkim never lapses by itself (v5.5); only agreement, surrender or an explicit abandon claim end it');
{
  const { w, a, b } = await oneMove(71);
  await w.call(b, 'request_tahkim', { reason: 'abc xyz' });
  for (let t = 0; t < 30 * 60 * SEC; t += 20 * SEC) { w.clock.t += 20 * SEC; await w.raw(a, { action: 'heartbeat', game_id: w.gameId }); await w.raw(b, { action: 'heartbeat', game_id: w.gameId }); }
  const s = (await w.call(b, 'snapshot')).snapshot;
  ok(s.game.status === 'tahkim_pending' && s.game.tahkim.state === 'discussion', 'half an hour later the discussion is still open');
  ok((await w.raw(a, { action: 'heartbeat', game_id: w.gameId })).status === 'tahkim_pending', 'and heartbeats report it');
  for (const act of ['respond_tahkim', 'cancel_tahkim', 'resolve_tahkim']) { const x = await w.call(b, act, { accept: true, verdict: 'invalid' }); ok(!x.ok && x.code === 'BAD_REQUEST', `${act} no longer exists: nobody can finalise alone (${x.code})`); }
}

group('guessing room codes is limited');
{
  const w = makeWorld({ seed: 81, who: ['A', 'B', 'D'] });
  const c = await w.raw('A', { action: 'create_room', nickname: 'A' }), code = c.snapshot.game.room_code;
  let last;
  for (let i = 0; i < 8; i++) last = await w.raw('D', { action: 'join_room', code: 'ZZZZZ' + (i % 2 ? '2' : '3') });
  ok(!last.ok && last.code === 'ROOM_NOT_FOUND', 'eight misses are answered normally');
  const blocked = await w.raw('D', { action: 'join_room', code });
  ok(!blocked.ok && blocked.code === 'RATE_LIMITED', 'the ninth attempt is refused, even with the right code');
  const other = await w.raw('B', { action: 'join_room', code, nickname: 'B' }); ok(other.ok, 'other players are not affected');
  w.clock.t += 61 * SEC; const later = await w.raw('D', { action: 'join_room', code });
  ok(!later.ok && later.code !== 'RATE_LIMITED', 'a minute later the limit has reset (the room is simply full now: ' + later.code + ')');
}

group('one open game per player, even when two requests race');
{
  const w = makeWorld({ seed: 91, who: ['A', 'B'] });
  const [r1, r2] = await Promise.all([w.raw('A', { action: 'create_room', nickname: 'A' }), w.raw('A', { action: 'create_room', nickname: 'A' })]);
  const okCount = [r1, r2].filter(r => r.ok).length;
  ok(okCount === 1, 'two simultaneous create_room calls open exactly one room (' + okCount + ')');
  ok([r1, r2].some(r => !r.ok && r.code === 'ALREADY_IN_GAME'), 'the other one is told it is already in a game');
  const c = [r1, r2].find(r => r.ok);
  const j = await Promise.all([w.raw('B', { action: 'create_room', nickname: 'B' }), w.raw('B', { action: 'join_room', code: c.snapshot.game.room_code, nickname: 'B' })]);
  ok(j.filter(r => r.ok).length === 1, 'a player cannot create a room and join another at the same moment');
}

group('heartbeat uses the light read');
{
  const w = makeWorld({ seed: 95 }); await w.start();
  let heavy = 0; const load = w.store.load.bind(w.store); w.store.load = async (id) => { heavy++; return load(id); };
  const hb = await w.raw('A', { action: 'heartbeat', game_id: w.gameId });
  ok(hb.ok && heavy === 0, 'a normal heartbeat never loads racks, bag or moves');
}

group('public build folder and headers');
{
  const dist = '.dist-test';
  execFileSync('node', [path.join(ROOT, 'tools/build-dist.mjs')], { env: { ...process.env, EAS_DIST: dist }, stdio: 'pipe' });
  const out = path.join(ROOT, dist), has = p => fs.existsSync(path.join(out, p));
  ok(has('index.html') && has('sw.js') && has('js/online/session.js') && has('assets/icons/icon-192.png') && has('manifest.webmanifest'), 'everything the browser needs is in the public folder');
  ok(!has('supabase') && !has('tests') && !has('docs') && !has('tools') && !has('README.md'), 'server sources, migrations, tests, docs and tools are NOT published');
  ok(fs.readFileSync(path.join(out, 'sw.js'), 'utf8') === fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), 'the stamped service worker is copied as it is');
  fs.rmSync(out, { recursive: true, force: true });
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const hdr = Object.fromEntries(v.headers[0].headers.map(h => [h.key, h.value]));
  ok(v.outputDirectory === 'dist' && /build-dist\.mjs/.test(v.buildCommand), 'Vercel publishes dist/, built by build-dist.mjs');
  ok(hdr['X-Content-Type-Options'] === 'nosniff' && /frame-ancestors 'none'/.test(hdr['Content-Security-Policy']) && !!hdr['Content-Security-Policy-Report-Only'] && !!hdr['Referrer-Policy'], 'security headers are set (clickjacking blocked; the strict script policy runs in report-only mode first)');
  const sw = v.headers.find(h => h.source === '/sw.js'); ok(sw && /no-cache/.test(sw.headers[0].value), 'sw.js is never cached by the browser, so updates are detected');
}
done();
