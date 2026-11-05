import { makeWorld, suite, mulberry32 } from './lib.mjs';
import { drawFirst, MAX_DRAWS } from '../../supabase/functions/_shared/core/engine.js';
import { makeTileSet } from '../../supabase/functions/_shared/game/rules.js';
const { ok, group, done } = suite('first player: each draws a tile, the higher value starts');

group('the draw itself');
{
  const bagOf = seed => { let n = 0; return makeTileSet('expanded', () => ++n); };
  let seat0 = 0, seat1 = 0, ties = 0, bad = 0, coin = 0;
  for (let i = 0; i < 4000; i++) {
    const rng = mulberry32(1000 + i), r = drawFirst(bagOf(), rng);
    r.seat === 0 ? seat0++ : seat1++;
    ties += r.rounds.length - 1; if (r.coin) coin++;
    const last = r.rounds[r.rounds.length - 1];
    if (!r.coin && (last[r.seat].v <= last[1 - r.seat].v)) bad++;                                   // the winner holds the higher value
    if (r.rounds.slice(0, -1).some(p => p[0].v !== p[1].v)) bad++;                                    // only ties are drawn again
    if (r.rounds.some(p => p.some(t => t.blank && t.v !== 0 || (!t.blank && !t.l)))) bad++;         // a blank counts 0, and the shape is { l, v, blank }
  }
  ok(bad === 0, 'the higher value always wins, only ties are redrawn, blanks count 0');
  ok(Math.abs(seat0 - 2000) < 150, `seat 0 and seat 1 start about equally often (${seat0} / ${seat1})`);
  ok(ties > 0 && coin === 0, `ties do happen and are redrawn (${ties} redraws in 4000 draws), the coin fallback never fires`);
  // the fallback: a bag of identical values can never decide, so it ends after MAX_DRAWS rounds with a coin
  const same = Array.from({ length: 20 }, (_, i) => ({ id: i, l: 'ا', v: 1, blank: false }));
  const c = drawFirst(same, mulberry32(5));
  ok(c.coin === true && c.rounds.length === MAX_DRAWS && (c.seat === 0 || c.seat === 1), `endless ties end with a coin after ${MAX_DRAWS} rounds`);
}

group('in a real game');
{
  const starts = [0, 0], N = 120;
  for (let i = 0; i < N; i++) {
    const w = makeWorld({ seed: 50 + i, draw: true }); await w.start();
    const g = w.snap.A.game, f = g.first, last = f.rounds[f.rounds.length - 1];
    starts[g.current_seat]++;
    if (i === 0) {
      ok(f && f.seat === g.current_seat && f.round === 1 && f.rounds.length >= 1, 'the draw is public and names the first seat');
      ok(JSON.stringify(w.snap.A.game.first) === JSON.stringify(w.snap.B.game.first), 'both players see the same draw');
      ok(w.snap.A.game.bag_count === 101 - 14, 'the drawn tiles went back into the bag (bag count ' + w.snap.A.game.bag_count + ')');
    }
    if (last[f.seat].v <= last[1 - f.seat].v) { ok(false, 'winner holds the higher value, game ' + i); break; }
  }
  ok(starts[0] > 30 && starts[1] > 30, `the host does not always start: ${starts}`);
  // no information about racks: all tile ids in play are still unique and complete
  const w = makeWorld({ seed: 3, draw: true }); await w.start();
  const sv = w.server(), ids = [...sv.priv.bag, ...Object.values(sv.racks).flat()].map(t => t.id);
  ok(new Set(ids).size === ids.length, 'every tile is still accounted for exactly once after the draw (' + ids.length + ')');
  const seat = w.snap.A.game.current_seat, k = w.who(seat);
  w.giveRack(k, [...'مدرسةيا']); await w.call(k, 'snapshot');
  const first = await w.call(k, 'pass_turn');
  ok(first.ok, 'the drawn player can play; the other cannot before');
  const again = await w.call(k, 'pass_turn');
  ok(!again.ok && again.code === 'WRONG_TURN', 'and it is then the other player\'s turn, not theirs again');
  await w.call(w.who(1 - seat), 'snapshot');
  ok((await w.call(w.who(1 - seat), 'pass_turn')).ok, 'turns alternate normally afterwards');
}

group('rematch draws again');
{
  const w = makeWorld({ seed: 9, draw: true }); await w.start();
  const a = JSON.stringify(w.snap.A.game.first);
  await w.call('B', 'snapshot'); await w.call('B', 'resign_game'); await w.call('A', 'rematch'); const r = await w.call('B', 'rematch');
  ok(r.ok && r.snapshot.game.round === 2 && r.snapshot.game.first.round === 2 && JSON.stringify(r.snapshot.game.first) !== a, 'a new round has its own draw');
}
group('legacy rule is kept for tests that need a known first player');
{
  const w = makeWorld({ seed: 7 }); await w.start();
  ok(w.snap.A.game.current_seat === 0 && w.snap.A.game.first.rounds.length === 0, 'without the draw the host starts and no draw is announced');
}
done();
