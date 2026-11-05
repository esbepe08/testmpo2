// Gameplay operations: clock, move transaction, turn flow, pass/swap/undo, end of game.
import { MIN_BAG_SWAP, REASONS, INCREMENT_MS } from './config.js';
import { $, S, app, shuffle, inMove, cur, refill, pushHist, pushUndo, popUndo, restore, createState, profile, bagCount } from './state.js';
import { analyze, scoreWords, finalScore } from './scoring.js';
import { notice, warn, fail, showResult, render, tickUI, bumpClock, chooseMode, openBlankPicker, buildBlankPicker, bagNote } from './ui.js';
import { nameOf, nameIso, nameHtml } from './names.js';
import { flashWords, clearFlash } from './flash.js';
import { haptic } from './haptics.js';

// ---------- Clock (timestamp based; driven by a single interval in main.js) ----------
export function tick() {
  if (app.net) return app.net.tick();   // online the clock is the server's: this only displays it
  if (S.ended) return;
  const now = performance.now(), p = cur();
  if (S.paused || S.hold || !S.started) { S.last = now; return; }   // paused: a dialogue is open, or the player pressed Pause (S.hold)
  p.ms = Math.max(0, p.ms - (now - S.last)); S.last = now;
  if (p.ms === 0) { endGame('time'); return; }
  tickUI();
}
function setTurn(i) { tick(); if (S.ended) return false; S.cur = i; S.last = performance.now(); return true; }

export function newGame(min = app.minutes, mode = app.mode) {
  createState(min, mode);
  clearFlash();
  buildBlankPicker();
  notice(`لعبة جديدة · ${profile().labelAr} · ${app.minutes} دقيقة`);
  render();
}

// ---------- Move transaction ----------
export function place(t, r, c) {
  if (app.net && !app.net.canPlay()) return false;
  if (S.hold || S.ended || S.swap || S.board[r][c]) return false;
  let e = inMove(t);
  if (e) { S.board[e.r][e.c] = null; e.r = r; e.c = c; }
  else {
    const slot = cur().rack.indexOf(t);
    if (slot < 0) return false;
    cur().rack[slot] = null; e = {t, r, c, slot}; S.move.push(e);
  }
  S.board[r][c] = t; S.land = t; S.pick = null;
  // A blank tile must be given a letter before the move can continue (clock paused meanwhile).
  if (t.blank && !t.as) { S.pending = e; S.paused = true; render(); openBlankPicker(); return true; }
  render(); return true;
}
export function unplace(e) {
  S.board[e.r][e.c] = null;
  if (e.t.blank) e.t.as = null;
  const rack = cur().rack;
  const i = rack[e.slot] ? rack.indexOf(null) : e.slot;
  rack[i] = e.t;
  S.move = S.move.filter(x => x !== e);
}
export function cancelMove() {
  [...S.move].forEach(unplace);
  S.pick = null;
}

// ---------- Actions ----------
export function submit() {
  if (S.hold || S.ended || S.swap) return;
  const a = analyze();
  if (a.err) return fail(a.err);
  if (app.net) return app.net.submit();   // online: the server re-checks, scores and commits; the check above was only a courtesy
  const r = scoreWords(a.words, a.isNew, S.move.length), pts = r.total, p = cur();
  pushUndo();
  S.move.forEach(e => { e.t.o = S.cur; });   // remember who placed each tile: its letter keeps that player's colour
  pushHist({p: S.cur, type: 'move', words: r.list, total: pts, bingo: r.bingo, inc: INCREMENT_MS});   // inc: taken back again if the move is voided
  p.score += pts; S.move = []; S.pick = null; S.pop = S.cur;
  const had = S.bag.length;
  refill(p);
  notice(`${nameIso(S.cur)}: +${pts} نقطة${bagNote(had, S.bag.length)}`);
  haptic(r.bingo ? 'bingo' : 'score');
  if (!p.rack.some(Boolean)) { S.hist[S.hist.length - 1].inc = 0; endGame('rack'); }   // the move that ends the game earns no time
  else { nextTurn(true); if (!S.ended) { p.ms += INCREMENT_MS; bumpClock(S.cur === 0 ? 1 : 0); } }   // chess clock: +5 s for the player who just played (never for a pass or a swap)
  flashWords(a.words);   // after the render: the words just scored light up in reading order (js/flash.js)
}
export function nextTurn(scored) {
  if (!setTurn(1 - S.cur)) return;
  if (scored && !S.started) { S.started = true; S.last = performance.now(); }
  S.sel.clear(); S.pick = null; render();
}
// What Undo would take back, in words (the confirmation and the notice use it).
export function undoLabel() {
  const e = S.hist[S.hist.length - 1];
  if (!e) return 'آخر إجراء';
  return e.type === 'move' ? `حركة ${nameIso(e.p)} (${e.total} نقطة)` : e.type === 'pass' ? `تمرير ${nameIso(e.p)}` : `تبديل ${nameIso(e.p)}`;
}
// Local play: Undo takes back the last action (a move, a pass or a swap), as many times in a row as you like. Board, racks, bag, scores, turn and clocks go back.
// Online it is a request to the opponent instead (js/online/session.js).
export function undo() {
  if (app.net || S.hold) return;
  if (!S.undo || S.ended || S.swap || S.move.length) return;
  tick(); if (S.ended) return;
  clearFlash();   // the move being taken back must not keep lighting up
  const what = undoLabel(), u = popUndo();
  restore(u); S.hist.length = u.hlen; S.hv++;
  notice(`تم التراجع: ${what}`); render();
}
export function pass() {
  if (S.hold || S.ended || S.swap || S.move.length) return;
  if (app.net) return app.net.pass();
  pushUndo(); pushHist({p: S.cur, type: 'pass'});   // passing is unlimited (and can be taken back)
  notice(`${nameIso(S.cur)} مرّر الدور`); nextTurn();
}
export function startSwap() {
  if (S.hold || S.ended || S.move.length) return;
  if (app.net && !app.net.guard()) return;
  S.swap = true; S.sel.clear(); S.pick = null; notice('اختر القطع للتبديل.'); render();
}
export function cancelSwapOrMove() {
  if (S.ended) return;
  if (S.swap) { S.swap = false; S.sel.clear(); } else cancelMove();
  render();
}
export function doSwap() {
  if (S.hold) return;
  if (!S.sel.size) return fail('حدد قطعة واحدة على الأقل للتبديل.');
  if (bagCount() < MIN_BAG_SWAP) return fail(`لا يمكن التبديل: في الكيس ${bagCount()} قطع فقط (الحد الأدنى ${MIN_BAG_SWAP}).`);
  if (app.net) return app.net.swap([...S.sel].map(t => t.id));
  pushUndo();
  const rack = cur().rack, idx = rack.map((t, i) => t && S.sel.has(t) ? i : -1).filter(i => i >= 0);
  const drawn = S.bag.splice(0, idx.length), old = idx.map(i => rack[i]);
  idx.forEach((i, k) => { rack[i] = drawn[k]; });
  S.bag.push(...old); shuffle(S.bag);
  S.swap = false; S.sel.clear(); pushHist({p: S.cur, type: 'swap', cnt: idx.length});   // swapping is unlimited too (and can be taken back)
  notice(`تم تبديل ${idx.length} قطع`); nextTurn();
}
export function endGame(reason) {
  if (S.ended) return;
  S.ended = true;
  if (S.pending) { S.pending = null; $('#bd').close(); }
  if (app.judge) { app.judge = null; $('#jd').close(); }
  cancelMove(); S.swap = false; S.sel.clear(); S.pick = null;
  // S.cur is the player the ending concerns: whose clock ran out, or who just used the last tile (the turn has not passed yet).
  const why = REASONS[reason](nameHtml(S.cur));
  const rows = S.players.map((p, i) => {
    const f = finalScore(p.score, p.ms, p.rack.reduce((s, t) => s + (t ? t.v : 0), 0));
    p.score = f.total;
    return {name: nameOf(i), ...f, score: f.total};
  });
  const [a, b] = [rows[0].score, rows[1].score];
  render();
  showResult({reason: why, rows, winner: a === b ? -1 : a > b ? 0 : 1}, chooseMode);
}
