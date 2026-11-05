// Online session: the ONLINE ADAPTER of the game engine. The local game mutates S itself; online, S is only a rendering of the server's
// snapshot, and every action is a request to the server (supabase/functions/eas-game). Nothing here decides a rule, a score, a draw or a clock.
//
//   DATABASE = truth, REALTIME = notification:  an event only says "revision N exists"; when N is newer than ours we fetch a snapshot.
//   Network state machine:  CONNECTING -> CONNECTED <-> RECONNECTING / OFFLINE, SYNCING while a snapshot is being fetched.
//   Presence: every action and a heartbeat (HEARTBEAT_MS, page visible) tell the server we are here. If the player the match is waiting for stays silent
//   for ABANDON_MS, the other player may end the match in their favour ("claim_abandon"); the server alone decides whether that is allowed.
import { RACK, REASONS, HEARTBEAT_MS, ABANDON_MS } from '../config.js';
import { $, S, BY, app } from '../state.js';
import { nameOf, nameHtml, nameIso, setRemoteNames, esc } from '../names.js';
import { notice, warn, fail, ask, render, renderControls, tickUI, chips, buildBlankPicker, setText, setAttr, setClass, setDis, showResult } from '../ui.js';
import { analyzeMove } from '../rules.js';
import { flashWords, clearFlash } from '../flash.js';
import { haptic } from '../haptics.js';
import { createBackend, isConfigured } from './supabase-backend.js';
import { lobby } from './lobby.js';
import { hideCover } from '../cover.js';
import { isFloating, placeNetBar } from '../float.js';
import { encodeDraft, decodeDraft } from './draft.js';
import { paintGhosts } from './ghost.js';
import { rulesDetails, idhafaReminder } from '../wordrules.js';
import { showOv, hideOv, ovKind } from '../overlay.js';
import { firstDraw } from '../firstdraw.js';
import { clockButtons } from '../pause.js';
import { livePref } from '../prefs.js';
import { APP_VERSION } from '../version.js';
import { initTahkim, paintTahkim, closeTahkim, tickTahkim, paintTahkimPresence } from './tahkim.js';

const RESUME = 'scrabble.online.resume';
const ERR_AR = { network: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت.' };
const id6 = () => crypto.randomUUID();
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(s / 60 | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

export const net = {
  backend: null, userId: null, snap: null, seat: 0, state: 'CONNECTING', opp: false, busy: false, key: '', clock: null,
  sub: null, lastEvent: 0, fetching: false, again: false, shownResult: '', lastMoves: 0, closingJudge: false, lastClaim: 0,
  oppIdle: { ms: 0, at: 0 }, beat: 0, wired: false, ghost: null, peerOld: false, verWarned: '', lastDraft: null, draftSig: '', draftTimer: 0, lastResume: 0, lastError: null,
  view: { state: 'CONNECTING', opp: true }   // what the bar SHOWS (see show()); the fields above are what is true
};
export const configured = isConfigured;

// ---------- start / resume ----------
export async function connect() {
  net.state = 'CONNECTING';
  net.backend ||= await createBackend();
  net.userId = await net.backend.init();
  net.state = net.view.state = 'CONNECTED';
  return net;
}
export async function resumeOpenGame({ includeFinished = false } = {}) {
  const r = await call({ action: 'reconnect' }, { quiet: true });
  if (r?.ok && r.snapshot && (includeFinished || r.snapshot.game.status !== 'finished')) { await enter(r.snapshot); return true; }
  try { localStorage.removeItem(RESUME); } catch { /* storage unavailable */ }
  return false;
}

// Raw request with retries on NETWORK failures only (the same client_action_id is reused, so a retry can never act twice).
async function call(body, { quiet = false, retries = 3 } = {}) {
  for (let i = 0; ; i++) {
    try { const r = await net.backend.call(body); if (net.state === 'OFFLINE' || net.state === 'RECONNECTING') setState('CONNECTED'); return r; }
    catch (e) {
      net.lastError = e.info || null;   // the lobby shows WHY (see explain() in supabase-backend.js)
      if (e.final || i >= retries) { setState('OFFLINE'); if (!quiet) warn(e.info?.text || ERR_AR.network); return null; }
      setState('RECONNECTING'); await new Promise(r => setTimeout(r, 500 * 2 ** i));
    }
  }
}

// ---------- entering a game (lobby or match) ----------
export async function enter(snap) {
  app.net = net; app.firstRun = false; net.snap = null; net.key = ''; net.view = { state: net.state, opp: true };   // opponent assumed present until presence says otherwise
  document.documentElement.dataset.online = 'true'; clockButtons(false);   // clocks are pause buttons in local play only
  try { localStorage.setItem(RESUME, '1'); } catch { /* storage unavailable */ }
  // The Tahkim discussion panel (js/online/tahkim.js) draws the server's state; these are the only things it can ask for.
  initTahkim({ snap: () => net.snap, seat: () => net.seat, oppHere: () => net.view.opp, online: () => net.view.state === 'CONNECTED', oppIdleNow: () => oppIdleNow(),
    say: text => net.tkSay(text), choose: v => net.tkChoose(v), resign: () => act('resign_game'), claim: () => net.claim() });   // before the first apply: a refresh during a discussion must draw the panel at once
  net.seat = snap.me.seat;
  subscribe(snap.game.id);
  apply(snap);
  clearInterval(net.beat); net.beat = setInterval(beat, HEARTBEAT_MS);
  if (!net.wired) {   // listeners are page-wide: bound once, however many times a game is entered
    net.wired = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { beat(); sync(); } });
    addEventListener('online', () => { beat(); sync(); }); addEventListener('offline', () => setState('OFFLINE'));
    $('#netLeave').onclick = () => net.leave();
    $('#netClaim').onclick = () => net.claim();
    $('#netPause').onclick = () => net.pauseClick();
    document.addEventListener('eas:livepref', () => { clearGhost(); net.lastDraft = null; net.draftSig = ''; net.backend.track?.({ d: null }); renderControls(); });   // Settings → live preview
    $('#netRematch').onclick = () => net.rematch();
    $('#jB').addEventListener('input', e => { if (e.target.id === 'tkReason') reasonCheck(); });
  }
}

function subscribe(gameId) {
  net.sub?.close?.();
  Promise.resolve(net.backend.subscribe(gameId, {
    onEvent: p => { net.lastEvent = Date.now(); if (!net.snap || p.revision > net.snap.game.revision) sync(); },
    // Presence carries the opponent's small public state: the revision they have seen (if it is newer than mine I missed an event: fetch it) and the tiles they are trying.
    // It never touches the game DOM, and it uses the one realtime path that is always authorised (presence), so the live preview needs no extra permission.
    // The opponent is identified by their real player id (from the snapshot), never by whatever presence key a member chose to announce: a key can be picked freely by a client.
    oppId: () => net.snap?.players?.find(p => p.player_id !== net.userId)?.player_id || null,
    onPresence: (ids, peer) => {
      const opp = ids.some(u => u !== net.userId); if (opp !== net.opp) { net.opp = opp; show('opp', opp, !opp); if (!opp) { net.lastDraft = null; clearGhost(); } }
      if (!peer) return;
      try { if (JSON.stringify(peer).length > 3000) return; } catch { return; }   // presence is a hint: an oversized payload is ignored
      net.peerOld = peer.v !== APP_VERSION;
      if (net.peerOld && net.verWarned !== (peer.v || '-')) { net.verWarned = peer.v || '-'; warn(peer.v ? `نسخة اللعبة عند الخصم (${peer.v}) تختلف عن نسخة جهازك (${APP_VERSION}). حدّث الصفحة على الجهازين.` : 'الخصم يستخدم نسخة قديمة من اللعبة: لن تظهر عنده المعاينة المباشرة وطلبات التراجع والإيقاف. اطلب منه تحديث الصفحة (إغلاقها وفتحها من جديد).'); }
      // A missed event leaves me a few revisions behind, never dozens, and at most one catch-up per 5 s: a forged huge `rev` cannot make this device hammer the server.
      if (Number.isInteger(peer.rev) && net.snap && peer.rev > net.snap.game.revision && peer.rev - net.snap.game.revision <= 25 && Date.now() - (net.peerSyncAt || 0) > 5000) { net.peerSyncAt = Date.now(); sync(); }
      if (peer.d) receiveDraft(peer.d); else if (net.lastDraft) { net.lastDraft = null; clearGhost(); }
    },
    onStatus: s => {
      if (s === 'SUBSCRIBED') { setState('SYNCING'); net.backend.track?.({ seat: net.seat, v: APP_VERSION }); sync(); }
      else { setState('RECONNECTING'); net.opp = false; show('opp', false, true); clearTimeout(net.resub); net.resub = setTimeout(() => subscribe(gameId), 2000); }
    }
  })).then(sub => { net.sub = sub; });
  net.backend.track?.({ seat: net.seat, v: APP_VERSION });
}

// ---------- synchronisation ----------
export async function sync() {
  if (!net.snap || net.fetching) { net.again = net.fetching; return; }
  net.fetching = true;   // routine syncs stay invisible; SYNCING is only shown by (re)subscribing, see subscribe()
  try {
    const r = await call({ action: 'snapshot', game_id: net.snap.game.id }, { quiet: true, retries: 1 });
    if (r?.ok) { noteIdle(r.snapshot); apply(r.snapshot); setState('CONNECTED'); }
    else if (r && r.code === 'NOT_MEMBER') { warn('انتهت جلستك في هذه المباراة.'); net.leave(true); }
  } finally { net.fetching = false; if (net.again) { net.again = false; sync(); } }
}
// The heartbeat tells the server we are here and answers with the current revision (a missed realtime event is noticed without a download)
// and with how long the opponent has been silent (so the claim countdown is the server's, not a guess).
async function beat() {
  if (document.hidden || !net.snap) return;
  const r = await call({ action: 'heartbeat', game_id: net.snap.game.id }, { quiet: true, retries: 1 });
  if (!r?.ok) return;
  net.oppIdle = { ms: r.opp_idle_ms ?? 0, at: Date.now() };
  if (r.revision > net.snap.game.revision) sync(); else paintStatus();
}
function noteIdle(snap) { const o = snap.players.find(p => p.seat !== snap.me.seat); if (o) net.oppIdle = { ms: o.idle_ms ?? 0, at: Date.now() }; }

function setState(s) { if (net.state !== s) { net.state = s; show('state', s, s !== 'CONNECTED'); } }
// What the bar shows lags what is true: a BAD value (reconnecting, opponent absent) must last SHOW_BAD_MS before it is displayed, so a resubscribe or a presence blip
// never flashes the bar; a GOOD value is shown at once and cancels a pending bad one.
const SHOW_BAD_MS = 1500, timers = {};
function show(key, value, bad) {
  clearTimeout(timers[key]);
  const apply = () => { if (net.view[key] !== value) { net.view[key] = value; paintStatus(); } };
  if (bad) timers[key] = setTimeout(apply, SHOW_BAD_MS); else apply();
}

// ---------- snapshot -> game state ----------
export function apply(snap) {
  const old = net.snap;
  if (old && snap.game.id === old.game.id && snap.game.revision < old.game.revision) return;   // an older snapshot never replaces a newer one
  // The same revision is the same game: a safety poll, a duplicate event or a sync after a tab switch must not rebuild anything.
  if (old && snap.game.id === old.game.id && snap.game.revision === old.game.revision) return;
  net.snap = snap; net.seat = snap.me.seat;
  const g = snap.game;
  if (!old || old.game.id !== g.id || old.game.revision !== g.revision) { clearGhost(); net.draftSig = ''; clearTimeout(net.draftTimer); net.backend.track?.({ seat: net.seat, rev: g.revision, d: null }); }   // a draft belongs to one revision; presence tells the opponent which revision I have
  notes(old, snap);
  // A revision that only moved the Tahkim chat or a choice (the frozen match did not change) repaints the discussion alone: the board and racks are not rebuilt for every message.
  if (old && old.game.id === g.id && g.status === 'tahkim_pending' && old.game.status === 'tahkim_pending' && old.game.round === g.round && old.moves.length === snap.moves.length && g.tahkim.move_number === old.game.tahkim.move_number) { paintTahkim(snap); paintStatus(); return; }
  net.drawNow = !!old && old.game.id === g.id && g.status === 'active' && !!g.first?.rounds?.length && (old.game.status === 'lobby' || old.game.round !== g.round);   // this snapshot is the start of a round: play its draw
  setRemoteNames([0, 1].map(i => snap.players.find(p => p.seat === i)?.nickname || ''));
  if (g.status === 'lobby' || g.status === 'starting') { lobby.show(snap); return; }
  if (g.status === 'abandoned') { lobby.close(); warn('أُغلقت الغرفة.'); return net.leave(true); }
  lobby.close();
  hideCover();
  hydrate(snap, old);
}

const reg = o => { const t = BY[o.id]; if (t) { Object.assign(t, { l: o.l, v: o.v, blank: o.blank, as: o.as, o: o.o ?? null }); return t; } return (BY[o.id] = { id: o.id, l: o.l, v: o.v, blank: o.blank, as: o.as, o: o.o ?? null }); };

function hydrate(snap, old) {
  const g = snap.game, me = snap.me.seat, key = g.id + ':' + g.round, fresh = net.key !== key;
  const keep = !fresh && S.move ? S.move.map(e => ({ id: e.t.id, r: e.r, c: e.c, as: e.t.as })) : [];
  if (fresh) {
    try { localStorage.setItem(RESUME, '1'); } catch { /* storage unavailable */ }   // a rematch is a new round of the same room: a refresh in it must come back to it (showFinal cleared the flag at the end of the previous round)
    net.key = key; app.gameId++; app.mode = g.tile_mode; app.minutes = g.minutes; net.shownResult = ''; net.lastMoves = snap.moves.length;
    for (const k in BY) delete BY[k];
    for (const k of Object.keys(S)) delete S[k];
    Object.assign(S, { swap: false, sel: new Set(), pick: null, drag: null, pending: null, hist: [], hv: 0, paused: false, last: performance.now(), land: null, pop: null, move: [], lastMove: null });
    buildBlankPicker(); clearFlash();
    const d = $('#dlg'); if (d.open && d.classList.contains('result')) d.close();   // a new round replaces the previous result card
    const t = $('#toast'); t.textContent = ''; t.className = '';
  }
  const prevScores = fresh ? null : S.players.map(p => p.score);
  S.board = snap.board.map(row => row.map(c => c && reg(c)));
  S.players = [0, 1].map(i => {
    const p = snap.players.find(x => x.seat === i) || { score: 0, tile_count: 0, ms_left: g.minutes * 60000 };
    const rack = i === me ? snap.me.rack.map(t => t && reg({ ...t, as: null })) : Array.from({ length: RACK }, (_, k) => k < p.tile_count ? { id: `h${i}-${k}`, hidden: true } : null);
    return { rack, score: p.score, ms: p.ms_left };
  });
  S.cur = g.current_seat ?? 0; S.ended = g.status === 'finished' || g.status === 'abandoned'; S.started = !!g.clock_started;
  S.undo = g.tahkim_available ? true : null; S.bagCount = g.bag_count; S.bag = [];
  S.hist = snap.moves; S.hv++;
  S.move = []; S.sel.clear(); if (S.cur !== me || g.status !== 'active') { S.swap = false; S.pick = null; }
  // keep an unsent preview if it is still valid against the new state (e.g. after a resync that did not change my turn)
  if (S.cur === me && g.status === 'active') for (const k of keep) {
    const t = BY[k.id], slot = t ? S.players[me].rack.indexOf(t) : -1;
    if (slot >= 0 && !S.board[k.r][k.c]) { S.players[me].rack[slot] = null; if (t.blank) t.as = k.as; S.move.push({ t, r: k.r, c: k.c, slot }); S.board[k.r][k.c] = t; }
  }
  net.clock = { offset: snap.server_now - Date.now(), startedAt: g.turn_started_at, running: g.clock_running, base: snap.players.map(p => p.ms_left) };
  const paused = !!g.pause && g.status === 'active';   // CSS hides the board and racks while paused, so a pause cannot be used to think for free
  if (document.documentElement.dataset.paused !== String(paused) && (paused || document.documentElement.dataset.paused)) { if (paused) document.documentElement.dataset.paused = 'true'; else delete document.documentElement.dataset.paused; }

  // What just happened on the board: a small mark on the last move's tiles, the words it scored lighting up in reading order, and a note when it was the opponent's.
  const last = snap.moves[snap.moves.length - 1], grew = !fresh && snap.moves.length > net.lastMoves;
  S.lastMove = last && last.type === 'move' && last.st !== 'void' && last.cells ? new Set(last.cells.map(([r, c]) => r * 15 + c)) : null;
  let flash = null;
  if (grew && last.type === 'move' && S.lastMove) {
    const a = analyzeMove(S.board, last.cells.map(([r, c]) => ({ t: S.board[r][c], r, c })));
    if (!a.err) flash = a.words;
  }
  if (grew && last.p !== me) announce(last);
  if (grew && last.p === me && last.type === 'move') haptic(last.bingo ? 'bingo' : 'score');
  // the score pop belongs to a score that actually changed (a pass or a swap changes no score)
  if (prevScores) { const i = S.players.findIndex((p, k) => p.score !== prevScores[k]); if (i >= 0) S.pop = i; }
  net.lastMoves = snap.moves.length;
  render(); tickUI(); paintStatus();
  if (flash) flashWords(flash); else if (grew) clearFlash();
  tahkimUI(snap); paintPauseOv();
  if (net.drawNow) { net.drawNow = false; onlineDraw(snap); }
  if (net.lastDraft) receiveDraft(net.lastDraft);   // a draft that arrived a moment before this revision does
  if (S.ended) { hideOv(); showFinal(snap); }
}

const announce = m => {
  if (m.type === 'move') haptic(m.bingo ? 'bingo' : 'score');
  notice(m.type === 'move' ? `${nameIso(m.p)}: +${m.total} نقطة` : m.type === 'pass' ? `${nameIso(m.p)} مرّر الدور` : `${nameIso(m.p)} بدّل ${m.cnt} قطع`);
};

// ---------- clock (display only; the server decides) ----------
let paintedSec = 0;
net.tick = function () {
  if (!net.clock || !net.snap) return;
  const c = net.clock, now = Date.now() + c.offset;
  S.players.forEach((p, i) => { p.ms = (c.running && S.cur === i && c.startedAt) ? Math.max(0, c.base[i] - (now - c.startedAt)) : c.base[i]; });
  tickUI();
  const sec = Date.now() / 1000 | 0; if (sec !== paintedSec) { paintedSec = sec; paintClaim(); paintPause(); paintStatusText(); tickTahkim(); }   // the countdowns move once a second
  const pz = net.snap.game.pause;
  if (pz && net.snap.game.status === 'active' && now >= pz.until && Date.now() - net.lastResume > 3000) { net.lastResume = Date.now(); act('resume_game', {}, { quiet: true }); }   // the limit is up: the server lets either player resume
  if (c.running && S.players[S.cur].ms === 0 && Date.now() - net.lastClaim > 2000) { net.lastClaim = Date.now(); act('claim_timeout', {}, { quiet: true }); }
};

// ---------- actions ----------
// myTurn: pure game state (what tiles look like). canPlay: myTurn AND no request in flight (what a click may do). Only the first may drive rendering.
net.myTurn = () => !!net.snap && net.snap.game.status === 'active' && !net.snap.game.pause && S.cur === net.seat && !S.ended;
net.canPlay = () => !!net.snap && !net.busy && net.snap.game.status === 'active' && !net.snap.game.pause && S.cur === net.seat && !S.ended;
net.guard = () => {
  if (net.snap?.game.status === 'tahkim_pending') { fail('اللعب متوقف: التحكيم قيد المناقشة.'); return false; }
  if (S.ended) return false;
  if (net.snap?.game.pause) { fail('اللعبة متوقفة مؤقتًا.'); return false; }
  if (S.cur !== net.seat) { fail('ليس دورك الآن.'); return false; }
  if (net.busy) return false;
  return true;
};

async function act(action, extra = {}, { quiet = false } = {}) {
  if (net.busy && action !== 'claim_timeout') return null;
  const snap = net.snap; if (!snap) return null;
  net.busy = true; renderControls();   // a pending request only changes button state
  try {
    const r = await call({ action, game_id: snap.game.id, client_action_id: id6(), base_revision: snap.game.revision, ...extra }, { quiet });
    if (!r) return null;
    if (r.snapshot) { noteIdle(r.snapshot); apply(r.snapshot); }
    if (!r.ok) { if (!quiet && r.code !== 'NOT_EXPIRED') fail(r.message || 'تعذّر تنفيذ الإجراء.'); return r; }
    return r;
  } finally { net.busy = false; renderControls(); }
}

net.submit = async function () {
  const placements = S.move.map(e => ({ tileId: e.t.id, row: e.r, col: e.c, ...(e.t.blank ? { as: e.t.as } : {}) }));
  const r = await act('submit_move', { placements });
  if (r?.ok && r.result) notice(`${nameIso(net.seat)}: +${r.result.score} نقطة`);
};
net.pass = async () => { const r = await act('pass_turn'); if (r?.ok) notice(`${nameIso(net.seat)} مرّر الدور`); };
net.swap = async ids => { const r = await act('swap_tiles', { tileIds: ids }); if (r?.ok) notice(`تم تبديل ${ids.length} قطع`); };

// ---------- Tahkim (the players are the only judges of a word) ----------
// Step 1 (challenger): a reason is mandatory. The dialog cannot be sent empty; the server checks it again. The moment the server accepts it BOTH players get the shared
// discussion panel (js/online/tahkim.js), both clocks are stopped and the match is frozen until both players choose the same verdict. Nothing here decides a verdict.
const REASON_MIN = 3, REASON_MAX = 160;
net.openTahkim = async function () {
  const g = net.snap?.game;
  if (!g) return;
  if (g.status === 'tahkim_pending') return tahkimUI(net.snap, true);
  const last = S.hist[S.hist.length - 1];
  if (!net.canPlay() || S.move.length || S.swap || !S.undo || !last || last.type !== 'move' || last.st) return;
  if (net.peerOld) return void warn('الخصم يستخدم نسخة مختلفة من اللعبة ولن يرى مناقشة التحكيم. اطلب منه تحديث الصفحة أولًا.');
  app.judge = { e: last, online: true, kind: 'reason' };
  $('#jT').textContent = 'طلب تحكيم';
  $('#jB').innerHTML = `<p>${nameHtml(last.p)} · الحركة ${last.n} · ${last.total} نقطة</p>${chips(last)}`
    + `<label class="tkLbl" for="tkReason">سبب التحكيم (إلزامي)</label>`
    + `<textarea id="tkReason" class="tkReason" rows="3" maxlength="${REASON_MAX}" required aria-describedby="tkHint" placeholder="مثال: «كتابي» إضافة بضمير متصل، وهي غير مسموحة"></textarea>`
    + `<div class="tkMeta"><span id="tkHint" class="tkHint">اكتب ${REASON_MIN} أحرف على الأقل. عند الإرسال يُفتح صندوق نقاش مشترك لكما، وتتوقف الساعتان ويُجمَّد اللعب حتى تتفقا على حكم واحد.</span><span id="tkN" class="tkN" dir="ltr">0/${REASON_MAX}</span></div>`
    + `${idhafaReminder()}${rulesDetails()}`
    + `<div class="vrow"><button class="btn yes" data-a="send" disabled>بدء التحكيم</button><button class="btn" data-a="close">إلغاء</button></div>`;
  $('#jd').showModal(); $('#tkReason').focus();
};
const reasonText = () => ($('#tkReason')?.value || '').replace(/\s+/g, ' ').trim();
function reasonCheck() {
  const n = [...reasonText()].length, btn = $('#jB [data-a="send"]'); if (!btn) return;
  setDis(btn, n < REASON_MIN || n > REASON_MAX); setText($('#tkN'), `${n}/${REASON_MAX}`);
}
function tahkimUI(snap, force = false) {
  const g = snap.game, jd = $('#jd');
  hideOv('tahkim');   // (the approval card of v5.4 no longer exists)
  paintTahkim(snap);
  // the reason form is only meaningful while it is my turn to challenge: close it when the position changed under it
  if (jd.open && app.judge?.online && (g.status !== 'active' || S.cur !== snap.me.seat)) { net.closingJudge = true; jd.close(); net.closingJudge = false; app.judge = null; }
  undoUI(snap);
}
net.onJudgeClick = function (ev) {
  if (!app.judge?.online) return;
  const a = ev.target.closest('[data-a]')?.dataset.a;
  if (a === 'send') { const r = reasonText(); if ([...r].length < REASON_MIN) return reasonCheck(); net.closingJudge = true; $('#jd').close(); net.closingJudge = false; app.judge = null; act('request_tahkim', { reason: r }); }
  else if (a === 'close') $('#jd').close();
};
net.onJudgeClosed = function () { if (net.closingJudge || !app.judge?.online) return; app.judge = null; };
// Chat messages and verdict choices are NOT pinned to a revision (both players type and choose at once), do not use the global "request in flight" flag
// (a message must never wait for, or block, another action) and are applied by the server to the newest state.
async function tkCall(action, extra) {
  const snap = net.snap; if (!snap || snap.game.status !== 'tahkim_pending') return null;
  const r = await call({ action, game_id: snap.game.id, client_action_id: id6(), ...extra }, { quiet: true });
  if (!r) { warn('تعذّر الاتصال. لم تُرسَل رسالتك بعد.'); return null; }
  if (r.snapshot) { noteIdle(r.snapshot); apply(r.snapshot); }
  if (!r.ok && r.code !== 'NOT_DISCUSSING') warn(r.message || 'تعذّر تنفيذ الإجراء.');
  return r;
}
net.tkSay = async text => !!(await tkCall('tahkim_say', { text }))?.ok;
net.tkChoose = async verdict => !!(await tkCall('tahkim_choose', { verdict }))?.ok;

// ---------- undo with the opponent's approval ----------
// The player who has just moved may ask to take the move back while the other player has not acted. The other player answers in a dialog (accept / decline);
// acting on the move instead counts as declining. The server restores the exact state; nothing is computed here.
function undoMode() {
  const g = net.snap?.game; if (!g || g.status !== 'active' || g.pause || S.ended) return null;
  const u = g.undo_req, last = S.hist[S.hist.length - 1];
  if (u && u.state === 'pending') return u.by === net.seat ? 'cancel' : null;
  if (!g.tahkim_available || !last || last.type !== 'move' || last.st || last.p !== net.seat || S.cur === net.seat) return null;
  if (u && u.move_number === last.n) return null;   // already declined: the same move cannot be asked for again
  return 'request';
}
net.undoClick = async function () {
  const m = undoMode(); if (!m || net.busy) return;
  if (m === 'request' && net.peerOld) return void warn('الخصم يستخدم نسخة مختلفة من اللعبة ولن يرى طلبك. اطلب منه تحديث الصفحة أولًا.');
  if (m === 'cancel') return void act('cancel_undo');
  const r = await act('request_undo');
  if (r?.ok) notice('أُرسل طلب التراجع إلى الخصم');
};
// Both browsers play the SAME draw the server made (game.first); nothing here decides anything.
function onlineDraw(snap) {
  const g = snap.game, key = g.id + ':' + g.round; if (net.fdKey === key) return; net.fdKey = key;
  firstDraw({ names: [nameIso(0), nameIso(1)], auto: { rounds: g.first.rounds, seat: g.first.seat } });
}
function undoUI(snap) {
  const g = snap.game, u = g.undo_req, me = snap.me.seat;
  if (!(g.status === 'active' && !g.pause && u && u.state === 'pending' && u.by !== me)) return hideOv('undo');
  const e = S.hist.find(x => x.n === u.move_number), first = ovKind() !== 'undo', answer = accept => act('respond_undo', { accept });   // the card closes when the new snapshot arrives
  showOv({
    kind: 'undo', icon: 'undo', title: 'طلب تراجع',
    lines: [`${nameIso(u.by)} يطلب التراجع عن حركته الأخيرة${e ? ` (${e.total} نقطة)` : ''}.`, 'عند الموافقة تعود القطع واللوح والنقاط إلى ما قبل الحركة ويعود الدور إليه.'],
    actions: [{ id: 'yes', primary: true, label: '✔ موافقة', onClick: () => answer(true) }, { id: 'no', danger: true, label: '✖ رفض', onClick: () => answer(false) }],
    onEscape: () => answer(false)
  });
  if (first) haptic('tick');
}
// What the player who is waiting should be told when the answer (or a pause) arrives in a snapshot.
function notes(old, snap) {
  if (!old || old.game.id !== snap.game.id) return;
  const a = old.game.undo_req, b = snap.game.undo_req, me = snap.me.seat;
  if (a && a.state === 'pending' && a.by === me) {
    if (b && b.state === 'declined' && b.move_number === a.move_number) warn('رفض الخصم طلب التراجع.');
    else if (!b && snap.moves.find(m => m.n === a.move_number)?.st === 'void') notice('وافق الخصم: عادت حركتك ودورك.');
  }
  const ta = old.game.tahkim, tb = snap.game.tahkim;
  if (ta.state === 'discussion' && (tb.state === 'resolved_valid' || tb.state === 'resolved_invalid') && tb.move_number === ta.move_number)
    notice(tb.verdict === 'valid' ? 'اتفق اللاعبان: الكلمة صحيحة — تبقى الحركة وتُستأنف الساعتان.' : 'اتفق اللاعبان: الكلمة خطأ — أُلغيت الحركة وانتقل الدور.');
  else if (old.game.status === 'active' && snap.game.status === 'tahkim_pending' && tb.state === 'discussion' && tb.challenger_seat !== me) notice(`${nameIso(tb.challenger_seat)} طلب التحكيم: فُتح النقاش وتوقفت الساعتان.`);
  const pa = old.game.pause, pb = snap.game.pause;
  if (pa && !pb && snap.game.status === 'active') notice('استُؤنفت اللعبة');
}

// ---------- pause ----------
// The pause card: the same full-screen card as in local play. The pauser can resume at once; the other player's button counts down to the moment the server allows it.
function paintPauseOv() {
  const g = net.snap?.game, z = g && g.status === 'active' ? g.pause : null;
  if (!z) return hideOv('pause');
  const mine = z.by === net.seat, left = z.until - (Date.now() + (net.clock?.offset || 0)), first = ovKind() !== 'pause';
  showOv({
    kind: 'pause', icon: 'pause', title: 'اللعبة متوقفة مؤقتًا',
    lines: [`${mine ? 'أوقفتَ اللعبة' : `${nameIso(z.by)} أوقف اللعبة`} · الساعتان متوقفتان للاعبَين`, 'اللوح والرفوف مخفية حتى الاستئناف.', mine ? `تبقّى لك ${g.pauses_left[net.seat]} إيقاف في هذه المباراة.` : 'تُستأنف المباراة تلقائيًا عند انتهاء المهلة.'],
    time: left > 0 ? `تُستأنف تلقائيًا خلال ${mmss(left)}` : 'انتهت المهلة — تُستأنف الآن…',
    actions: [{ id: 'resume', primary: true, label: mine || left <= 0 ? 'استئناف' : `استئناف بعد ${mmss(left)}`, disabled: !mine && left > 0, onClick: () => net.pauseClick() }]
  });
  if (first) haptic('tick');
}
net.pauseClick = async function () {
  const g = net.snap?.game; if (!g || g.status !== 'active' || net.busy) return;
  if (!g.pause && net.peerOld) return void warn('الخصم يستخدم نسخة مختلفة من اللعبة ولن يرى الإيقاف. اطلب منه تحديث الصفحة أولًا.');
  const r = await act(g.pause ? 'resume_game' : 'pause_game');
  if (r?.ok && !g.pause) notice('أُوقفت اللعبة مؤقتًا — الساعتان متوقفتان');
};

// ---------- live preview of the opponent's tentative tiles ----------
// Sending: whenever the player on turn changes the tiles they are trying, a small "draft" is broadcast (debounced), and an empty one when they take them back.
// Receiving: validated like any untrusted input (see draft.js), drawn as dashed ghost tiles, and dropped as soon as a new revision arrives.
// Both sides only do this while the host's "live preview" rule is on. Nothing here is ever sent to the server's game logic.
const liveOn = () => !!net.snap?.game.live && livePref();   // the host's room rule AND my own preference (Settings)
function syncDraft() {
  const mine = liveOn() && net.myTurn(), sig = mine && S.move.length ? JSON.stringify(S.move.map(e => [e.r, e.c, e.t.blank ? e.t.as || '' : e.t.l])) : '';
  if (sig === net.draftSig) return;
  net.draftSig = sig; clearTimeout(net.draftTimer);
  net.draftTimer = setTimeout(() => {   // coalesced: presence is rate limited, and a drag passes through many squares
    const g = net.snap?.game; if (!g || !liveOn() || !net.myTurn()) return;
    const d = encodeDraft(g.revision, S.move);
    net.backend.track?.({ d: d.c.length ? d : null });
  }, 200);
}
function receiveDraft(p) {
  net.lastDraft = p;
  const g = net.snap?.game;
  if (!g || !liveOn() || g.status !== 'active' || g.pause || S.cur === net.seat) return;
  const cells = decodeDraft(p, { rev: g.revision, board: S.board });
  if (!cells) return;
  net.ghost = cells.length ? cells : null; paintGhosts(net.ghost);
}
function clearGhost() { if (net.ghost) { net.ghost = null; } paintGhosts(null); }

// ---------- end of game / rematch / claim / leaving ----------
// The same result card local play shows, filled from the server's settlement (so both players see identical numbers).
function showFinal(snap) {
  const g = snap.game;
  if (net.shownResult === net.key || !g.result) return;
  net.shownResult = net.key;
  try { localStorage.removeItem(RESUME); } catch { /* storage unavailable */ }
  const r = g.result, subject = r.loser_seat ?? r.subject_seat ?? 0;
  const rows = [0, 1].map(i => { const l = r.lines.find(x => x.seat === i) || { score: 0, raw: 0, ded: 0, mins: 0, bon: 0 }; return { name: nameOf(i), score: l.score, raw: l.raw, bonus: l.bon, mins: l.mins, ded: l.ded }; });
  showResult({ reason: (REASONS[r.reason] || (() => ''))(nameHtml(subject)), rows, winner: r.winner_seat == null ? -1 : r.winner_seat }, () => act('rematch'), 'إعادة المباراة', 'btn yes');
}
net.newButton = function () {   // reached only from the keyboard/legacy path: the button itself is hidden online
  if (!net.snap) return;
  if (S.ended) return net.rematch();
  ask('استسلام', 'سيُحسب الفوز لخصمك وتصبح نقاطك صفرًا.', 'استسلام', () => act('resign_game'));
};
net.claim = async function () {
  const r = await act('claim_abandon');
  if (r && !r.ok && r.code === 'NOT_ABANDONED') { net.oppIdle = { ms: 0, at: Date.now() }; paintStatus(); }
};
// Leaving. In a lobby the room is left; in a running match the button means RESIGN (the match ends and both players see the result card);
// once the match is over it simply goes back to the cover.
net.leave = async function (silent = false) {
  const g = net.snap?.game;
  const go = () => { try { localStorage.removeItem(RESUME); } catch { /* storage unavailable */ } location.href = location.pathname; };
  if (silent || !g || g.status === 'finished' || g.status === 'abandoned') return go();
  if (g.status === 'lobby') { await call({ action: 'leave_room', game_id: g.id, client_action_id: id6() }, { quiet: true, retries: 1 }); return go(); }
  ask('استسلام', 'سينتهي اللعب ويُحسب الفوز لخصمك وتصبح نقاطك صفرًا.', 'استسلام', () => act('resign_game'));
};
net.rematch = () => act('rematch');
net.lobbyAction = (action, extra = {}) => act(action, extra);
net.call = call;

// ---------- status bar / controls ----------
const NET_AR = { CONNECTING: 'جارٍ الاتصال…', CONNECTED: 'متصل', RECONNECTING: 'جارٍ إعادة الاتصال…', OFFLINE: 'لا يوجد اتصال', SYNCING: 'جارٍ المزامنة…' };
const waitingOnOpp = () => { const s = net.snap; return !!s && ['active', 'tahkim_pending'].includes(s.game.status) && s.waiting_seat === 1 - net.seat; };
const oppIdleNow = () => net.oppIdle.ms + (Date.now() - net.oppIdle.at);

// The bar is ONE fixed-height row that never wraps: a status line that ellipsizes, a coloured dot, and at most one contextual button (claim / rematch) plus the
// leave button. Nothing here changes the bar's box, so nothing around it moves (the CSS enforces it; see .netBar in css/online.css).
function paintStatus() {
  const bar = $('#netBar'), st = $('#netState'); if (!bar) return;
  if (bar.hidden) { bar.hidden = false; if (isFloating()) placeNetBar(); }
  const g = net.snap?.game, opp = 1 - net.seat, name = nameIso(opp), V = net.view;
  let t = V.state === 'CONNECTED' ? '' : NET_AR[V.state];
  if (!t && g && g.status === 'tahkim_pending') t = `التحكيم قيد المناقشة — الساعتان متوقفتان`;
  if (!t && g && g.status === 'active' && g.pause) t = g.pause.by === net.seat ? 'أوقفتَ اللعبة مؤقتًا — الساعتان متوقفتان' : `${nameIso(g.pause.by)} أوقف اللعبة مؤقتًا — الساعتان متوقفتان`;
  if (!t && g && g.status === 'active' && g.undo_req && g.undo_req.state === 'pending') t = g.undo_req.by === net.seat ? 'بانتظار موافقة الخصم على التراجع…' : `${nameIso(g.undo_req.by)} يطلب التراجع عن حركته`;
  if (!t && waitingOnOpp() && !V.opp) t = `${name} غير متصل — بانتظار عودته…`;
  if (!t && g && g.status === 'finished' && (g.rematch_seats || []).includes(opp)) t = `${name} يطلب إعادة المباراة`;
  const text = t || `متصل · الغرفة ${g?.room_code || ''}`;
  setText(st, text); setAttr(st, 'title', text);
  const bad = V.state !== 'CONNECTED' || (!!g && g.status === 'active' && !V.opp);
  setClass($('#netDot'), 'netDot ' + (bad ? 'warn' : 'on'));
  const over = !!g && (g.status === 'finished' || g.status === 'abandoned');
  setText($('#netLeave'), over ? 'خروج' : 'استسلام');
  const rm = $('#netRematch'); if (rm.hidden === over) rm.hidden = !over;
  paintClaim(); paintPause(); paintTahkimPresence();
  for (const i of [0, 1]) paintStat(i);
  // The result card is modal, so the "rematch" request must be visible ON it, not only in the bar behind it.
  const ok = document.querySelector('#dlg.result[open] #dF button[value="ok"]');
  if (ok && over) setText(ok, (g.rematch_seats || []).includes(opp) ? 'قبول إعادة المباراة' : 'إعادة المباراة');
}
function paintStatusText() { if (net.snap?.game.pause) { paintStatus(); paintPauseOv(); } }
// The pause button: "pause" while the match runs (hidden when the claim button is the one contextual button), "resume" while paused (the other player's button counts
// down to the moment the server lets them resume).
function paintPause() {
  const b = $('#netPause'); if (!b) return;
  const g = net.snap?.game, claim = waitingOnOpp() && !net.view.opp && net.view.state === 'CONNECTED';
  const show = !!g && g.status === 'active' && !claim;
  if (b.hidden === show) b.hidden = !show;
  if (!show) return;
  const nowS = Date.now() + (net.clock?.offset || 0);
  if (g.pause) {
    const mine = g.pause.by === net.seat, left = g.pause.until - nowS;
    setText(b, mine || left <= 0 ? 'استئناف' : `استئناف بعد ${mmss(left)}`); setDis(b, !mine && left > 0);
    setAttr(b, 'aria-label', mine || left <= 0 ? 'استئناف اللعبة' : `يمكنك الاستئناف بعد ${mmss(left)}`);
  } else {
    const n = g.pauses_left[net.seat];
    setText(b, `إيقاف مؤقت (${n})`); setDis(b, n <= 0 || net.busy || (g.undo_req && g.undo_req.state === 'pending'));
    setAttr(b, 'aria-label', n > 0 ? `إيقاف اللعبة مؤقتًا، تبقّى ${n}` : 'لا توجد مرات إيقاف متبقية');
  }
}
// The claim button appears only when the server's own silence measure can make it work, and counts down before that.
function paintClaim() {
  const b = $('#netClaim'); if (!b) return;
  const show = waitingOnOpp() && !net.view.opp && net.view.state === 'CONNECTED';
  if (b.hidden === show) b.hidden = !show;
  if (!show) return;
  const left = ABANDON_MS - oppIdleNow();
  setText(b, left <= 0 ? 'إنهاء المباراة والفوز' : `إنهاء بعد ${mmss(left)}`);
  setAttr(b, 'aria-label', left <= 0 ? 'إنهاء المباراة والفوز' : `يمكنك إنهاء المباراة بعد ${mmss(left)}`);
  setDis(b, left > 0);
}
function paintStat(i) {
  const head = document.querySelector(`#pn${i} .phead`); if (!head) return;
  let el = head.querySelector('.pstat');
  if (!el) { el = Object.assign(document.createElement('span'), { className: 'pstat' }); head.querySelector('.pname').after(el); }
  const on = i === net.seat ? net.view.state !== 'OFFLINE' && net.view.state !== 'RECONNECTING' : net.view.opp;
  setText(el, on ? '●' : '○'); setClass(el, 'pstat ' + (on ? 'on' : 'off'));
  el.title = on ? 'متصل' : 'غير متصل'; el.setAttribute('aria-label', el.title);
  const panel = $('#pn' + i), you = String(i === net.seat); if (panel.dataset.you !== you) panel.dataset.you = you;
}
net.paintControls = function () {
  const mine = net.canPlay(), g = net.snap?.game;
  const um = undoMode(), ub = $('#bUndo');   // online, Undo means "ask the opponent" (or withdraw the question)
  const ut = um === 'cancel' ? 'إلغاء طلب التراجع' : 'طلب التراجع';
  setText($('#bUndo .lbl'), ut); setAttr(ub, 'aria-label', ut); setAttr(ub, 'title', ut); setDis(ub, ub.disabled || !um || net.busy);
  syncDraft(); paintGhosts(net.ghost);
  const dis = (id, v) => { const b = $(id); setDis(b, b.disabled || v); };
  dis('#bSubmit', !mine); dis('#bCancel', !mine); dis('#bSwap', !mine); dis('#bPass', !mine);
  setDis($('#bJudge'), $('#bJudge').disabled || !mine);   // gameplay is locked during a discussion (the panel owns the screen); a challenge is the player on turn's
};
