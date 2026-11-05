// The Rules Reference of the Tahkim discussion must say what the engine really does: every figure is compared with the engine running on the in-memory server.
import { makeWorld, suite, across } from './lib.mjs';
import { ruleFacts, gameRulesHtml, wordRulesHtml } from '../../js/tahkimrules.js';
import * as C from '../../supabase/functions/_shared/game/config.js';
import { TILE_MODES } from '../../supabase/functions/_shared/game/modes.js';
import { challengePenalty, bonusMinutes } from '../../supabase/functions/_shared/game/rules.js';
const { ok, group, done } = suite('tahkim rules reference vs the real engine');
const plain = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

group('figures come from the engine modules');
for (const mode of Object.keys(TILE_MODES)) {
  const f = ruleFacts(mode), html = plain(gameRulesHtml(mode));
  ok(f.penalty === C.PENALTY && f.rack === C.RACK && f.bingo === C.BINGO && f.minBagSwap === C.MIN_BAG_SWAP, `${mode}: constants`);
  ok(f.incrementSec * 1000 === C.INCREMENT_MS && f.pausesEach === C.PAUSES_EACH && f.pauseMin * 60000 === C.PAUSE_MS && f.abandonMin * 60000 === C.ABANDON_MS, `${mode}: clock constants`);
  ok(f.totalTiles === TILE_MODES[mode].tiles.reduce((s, t) => s + t[2], 0), `${mode}: tile count`);
  for (const [l, v] of TILE_MODES[mode].tiles) if (l) ok(f.byValue[v].some(x => x.l === l), `${mode}: ${l} listed with value ${v}`);
  for (const n of [C.PENALTY, C.RACK, C.BINGO, C.MIN_BAG_SWAP, C.INCREMENT_MS / 1000, C.TIME_BONUS_PER_MIN, C.PAUSES_EACH, C.PAUSE_MS / 60000, C.ABANDON_MS / 60000])
    ok(new RegExp(`(^|\\D)${n}(\\D|$)`).test(html), `${mode}: the text states ${n}`);
}
ok(ruleFacts('expanded').premium.TW === 8 && ruleFacts('expanded').premium.DL === 24, 'premium square counts follow the board layout');
ok(/الكلمات|الإضافة/.test(plain(wordRulesHtml())) && wordRulesHtml().includes('wrList'), 'word rules are the same text Settings shows');

group('the penalty the panel states is the penalty the server applies');
{
  const w = makeWorld({ seed: 33 }); await w.start({ minutes: 10 });
  w.giveRack('A', [...'كتاب']); await w.call('A', 'snapshot');
  await w.call('A', 'submit_move', { placements: across(w.snap.A, 'كتاب') }); await w.call('B', 'snapshot');
  const b = w.server().players.find(p => p.player_id === w.users.B); b.score = 40;
  await w.call('B', 'snapshot');
  await w.call('B', 'request_tahkim', { reason: 'سبب التحكيم' });
  await w.call('A', 'tahkim_choose', { verdict: 'valid' }); const r = await w.call('B', 'tahkim_choose', { verdict: 'valid' });
  ok(r.snapshot.players.find(p => p.seat === 1).score === 40 - ruleFacts('expanded').penalty, 'valid verdict: the challenger loses exactly the stated penalty');
  ok(r.snapshot.game.tahkim_log[0].penalty === C.PENALTY, 'and it is recorded');
  ok(challengePenalty(3) === 3 && challengePenalty(1000) === C.PENALTY, 'capped by the challenger\'s score');
  ok(r.snapshot.players[0].ms_left === 10 * 60000 + C.INCREMENT_MS, 'the +5 s stays when the move stands');
}
done();
