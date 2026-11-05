import { showFloat, gameInert, lockGame } from './float.js';
// DOM rendering, toasts and dialogs. Reads state; never mutates game rules.
import { SIZE, DURATIONS, BINGO, TOAST_MS, LAYOUT, GLYPH, FACE, LABEL, MIN_BAG_SWAP, TIME_BONUS_PER_MIN, INCREMENT_MS } from './config.js';
import { TILE_MODES } from './modes.js';
import { $, S, app, fmt, inMove, cur, profile, bagCount } from './state.js';
import { nameOf, nameHtml, nameIso, esc, onNamesChange } from './names.js';
import { haptic } from './haptics.js';
import { rulesHtml } from './wordrules.js';
import { rackHidden } from './prefs.js';

let cells = [], toastTimer = 0, dlgCb = null, dlgCancel = null;
const hs = {id: -1, v: -1};   // last rendered history (game id / version)

// ---------- Static DOM construction ----------
export function buildDom() {
  const board = $('#board');
  for (let i = 0; i < SIZE * SIZE; i++) {
    const d = document.createElement('div'); d.dataset.r = i / SIZE | 0; d.dataset.c = i % SIZE; d.tabIndex = 0; d.setAttribute('role', 'gridcell'); cells.push(d); board.append(d);
  }
  bindDlg();
  // The name is a small control (js/nameedit.js: press and hold, double-click or Enter edits it in place); its text and the rack's accessible name are filled in by syncNames().
  $('#players').innerHTML = [0, 1].map(i => `<div class="panel" id="pn${i}"><div class="phead"><span class="pname" tabindex="0" role="button"><bdi></bdi></span><span class="ptime" id="t${i}">25:00</span><span class="pscore" id="sc${i}">0</span></div><div class="rack" id="rk${i}"></div></div>`).join('');
  syncNames(); onNamesChange(syncNames);
  $('#wrB').innerHTML = rulesHtml();   // the word rules, in Settings
  $('#sf').innerHTML = DURATIONS.map(m => `<button class="btn" value="${m}"><b>${m}</b><span>دقيقة</span></button>`).join('');
  $('#mf').innerHTML = Object.values(TILE_MODES).map(m => `<button class="btn modeBtn" value="${m.id}"><span class="mAr">${m.labelAr}</span><span class="mEn">${m.labelEn}</span><span class="mDesc">${m.descAr}</span></button>`).join('');
}
// Names are a device preference (js/names.js). When one changes, the panels, the racks' accessible names and the history (which prints names) follow.
export function syncNames() {
  [0, 1].forEach(i => {
    const n = nameOf(i), el = $('#pn' + i + ' .pname'), t = el.firstElementChild;
    if (t.textContent !== n) t.textContent = n;
    el.setAttribute('aria-label', `تعديل اسم اللاعب: ${n}`);
    el.title = 'اضغط مطولًا أو انقر مرتين لتعديل الاسم';
    $('#rk' + i).setAttribute('aria-label', 'رفّ ' + n);
  });
  if (S.hist) { hs.v = -1; renderHist(); }
}
// The blank picker only offers the letters of the active tile mode (rebuilt for every new game).
export function buildBlankPicker() {
  $('#bf').innerHTML = [...profile().alpha].map(l => `<button class="btn" value="${l}">${FACE[l] || l}</button>`).join('');
}

// ---------- Feedback & dialogs ----------
// Messages. Use notice() for a result or confirmation and warn() for a refused action or a hint; toast() is the low-level form they share
// (ok === false gives the success look, anything else the warning look plus a haptic), kept exported for the tests.
export const notice = msg => toast(msg, false);
export const warn = msg => toast(msg, true);
export function toast(msg, ok) {
  if (ok !== false) haptic('bad');   // an error or a hint: the same condition that gives the toast its warning look
  const el = $('#toast'); el.textContent = msg; el.className = ok === false ? 'ok' : 'bad';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, TOAST_MS);
}
export function fail(msg) {
  warn(msg);
  const b = $('#board'); b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
}
// Gameplay confirmations float as a light panel (css/float.css, js/float.js) instead of a blocking centred modal; the game behind stays frozen
// by lockGame('dlg') + S.paused, so the look and the input lock are separate concerns. Rich results (end of game) and every dialogue shown
// before the match has started (cover, setup flow, resume prompt) stay conventional modals.
let dlgFocus = null;
const dlgFloats = () => $('#dlg').open && !$('#dlg').classList.contains('dlgModal');
export function ask(title, msg, okLabel, fn, onCancel = null, okCls = 'btn danger', cancelLabel = null) {
  const rich = typeof msg !== 'string', d = $('#dlg'), floating = !rich && !app.firstRun && $('#cover').hidden;
  $('#dT').textContent = title; d.classList.toggle('result', rich);
  if (rich) $('#dM').replaceChildren(msg); else $('#dM').textContent = msg;
  const f = $('#dF'); f.innerHTML = '';
  for (const [label, val, cls] of [[okLabel, 'ok', okCls], [cancelLabel || (onCancel ? 'رجوع' : 'إغلاق'), '', 'btn']]) {
    const b = document.createElement('button'); b.className = cls; b.value = val; b.textContent = label; f.append(b);
  }
  S.paused = true; dlgCb = fn; dlgCancel = onCancel; d.returnValue = '';
  d.classList.toggle('dlgModal', !floating);
  $('#dT').title = floating ? 'اسحب لتحريك النافذة · مزدوج النقر لإعادة الموضع' : '';
  if (!floating) {   // a modal is centred by the browser: coordinates left over from the floating form of this same dialogue (a confirm shown earlier) would push the result card off-screen
    for (const k of ['left', 'top', 'right', 'bottom', 'width']) d.style.removeProperty(k);
    return d.showModal();
  }
  dlgFocus = document.activeElement; lockGame('dlg', true); d.show(); showFloat('dlg'); $('#dT').focus({preventScroll: true});
}
function bindDlg() {
  const d = $('#dlg');
  d.addEventListener('close', () => {   // registered before input.js, so the lock is released before any callback can open the next dialogue
    lockGame('dlg', false);
    const f = dlgFocus; dlgFocus = null;
    if (f && f.isConnected && !f.closest('[inert]') && f.focus) f.focus({preventScroll: true});
  });
  d.addEventListener('keydown', e => {   // a non-modal dialog ignores Esc natively and does not trap Tab
    if (!dlgFloats()) return;
    if (e.key === 'Escape') { e.preventDefault(); d.close(); return; }
    if (e.key !== 'Tab') return;
    const ok = [...d.querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(n => n.offsetParent !== null);
    if (!ok.length) return;
    const i = ok.indexOf(document.activeElement), n = e.shiftKey ? (i <= 0 ? ok.length - 1 : i - 1) : (i === ok.length - 1 ? 0 : i + 1);
    e.preventDefault(); ok[n].focus();
  });
}
// End of game: centred announcement (winner line + one score card per player). rows: [{name, score, ded, bon}], winner: 0 | 1 | -1 (draw).
const TROPHY = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 01-8 0zM8 6H5v1a3 3 0 003 3M16 6h3v1a3 3 0 01-3 3M12 13v4M9 20h6M10 17h4"/></svg>';
export function showResult({reason, rows, winner}, onNew, okLabel = 'لعبة جديدة', okCls = 'btn danger') {
  const box = document.createElement('div'); box.className = 'res';
  box.innerHTML = `<p class="resWhy">${reason}</p>`
    + `<p class="resWin${winner < 0 ? ' draw' : ''}">${winner < 0 ? 'تعادل!' : `${TROPHY}<span>الفائز: <bdi>${esc(rows[winner].name)}</bdi></span>`}</p>`
    + `<div class="resCards">${rows.map((r, i) => `<div class="resCard${i === winner ? ' win' : ''}"><span class="resName"><bdi>${esc(r.name)}</bdi></span><b class="resScore">${r.score}</b>`
      + `<span class="resNote">النقاط <span class="num">${r.raw}</span></span>`
      + `<span class="resNote">مكافأة وقت <span class="num">+${r.bonus}</span> <span class="resSub">(<span class="num">${r.mins} × ${TIME_BONUS_PER_MIN}</span> د)</span></span>`
      + `<span class="resNote">خصم <span class="num">${r.ded}</span></span></div>`).join('')}</div>`;
  haptic('end');
  ask('انتهت اللعبة', box, okLabel, onNew, null, okCls);
}
// Called by the dialog 'close' listener: returns and clears the pending callbacks.
export function takeDialogCallbacks() { const r = {ok: dlgCb, cancel: dlgCancel}; dlgCb = dlgCancel = null; return r; }

// Setup flow: chooseMode -> chooseDuration -> confirmation (input.js) -> newGame. The mode is only applied at the end.
export function chooseMode() {
  if (S.board) S.paused = true;
  $('#mCancel').hidden = app.firstRun;   // the very first prompt cannot be skipped
  $('#md').returnValue = ''; $('#md').showModal();
}
export function chooseDuration() {
  if (S.board) S.paused = true;
  for (const b of $('#sf').children) b.setAttribute('aria-current', String(+b.value === app.minutes));   // marks the length in use
  $('#sd').returnValue = ''; $('#sd').showModal();
}
export function openBlankPicker() { $('#bd').returnValue = ''; $('#bd').showModal(); }
export function openSettings() { S.paused = true; gameInert(true); $('#ad').show(); showFloat('settings'); $('#aT').focus(); }

// ---------- Rendering (DOM is only touched when a cell/rack/list actually changed) ----------
const sqHTML = k => {
  if (!LABEL[k]) return '';
  const [m, w] = LABEL[k].split(' ');
  return k === 5 ? '<span class="pl"><span>نجمة</span></span>' : `<span class="pl"><span class="m">${m}</span><span>${w}</span></span>`;
};
function tileHTML(t) {
  if (t.hidden) return '<div class="tile back" aria-hidden="true"></div>';   // the opponent's tiles online: only their number is known
  const L = t.blank ? (t.as || '') : t.l, v = t.blank ? 0 : t.v;
  const mine = cur().rack.includes(t), mv = inMove(t);
  // Online, a tile's look follows TURN OWNERSHIP only: a request in flight or a background sync must never restyle (and so rebuild) every tile.
  const ok = !S.ended && (!app.net || app.net.myTurn()) && (S.swap ? mine : (mine || mv));
  const own = (mine || mv) ? S.cur : t.o;   // tiles on the rack or in the move being built belong to the player shown; placed tiles keep their placer's colour
  const cls = ['tile', t.blank && 'blank', mv && 'cur', S.pick === t && 'pick', S.sel.has(t) && 'swp', S.land === t && 'land', !ok && 'dim'].filter(Boolean).join(' ');
  return `<div class="${cls}"${own === 0 || own === 1 ? ` data-o="${own}"` : ''} data-id="${t.id}" draggable="${ok && !S.swap}" tabindex="0" role="button"${ok ? '' : ' aria-disabled="true"'} aria-label="${L || 'قطعة فارغة'} قيمة ${v}"><b${GLYPH[L] ? ` style="transform:translate(${GLYPH[L][0]}em,${GLYPH[L][1]}em)"` : ''}>${FACE[L] || L}</b><i>${v}</i></div>`;
}
function renderBoard() {
  cells.forEach((el, i) => {
    const r = i / SIZE | 0, c = i % SIZE, t = S.board[r][c], k = LAYOUT[r][c];
    const h = t ? tileHTML(t) : sqHTML(k), lm = !!(t && S.lastMove && S.lastMove.has(i)), key = lm ? h + '\u0001' : h;   // lm: part of the move just played (online), a small corner mark
    if (el._h === key) return;
    el._h = key; el.innerHTML = h;
    el.className = 'sq k' + k + (t ? ' has' + (inMove(t) ? ' mv' : '') + (S.pick === t || S.land === t ? ' up' : '') + (S.land === t ? ' fall' : '') + (lm ? ' lm' : '') : '');
    el.setAttribute('aria-label', t ? (t.blank ? t.as : t.l) : (LABEL[k] ? (k === 5 ? 'مربع نجمة' : 'مربع ' + LABEL[k]) : 'مربع فارغ'));
  });
}
function renderPlayers() {
  S.players.forEach((p, i) => {
    const on = i === S.cur && !S.ended, panel = $('#pn' + i);
    if (panel.classList.contains('on') !== on) panel.classList.toggle('on', on);   // classList, not className: other classes (flActive, ...) must survive a render
    setAttr(panel, 'aria-current', on);
    const sc = $('#sc' + i); setText(sc, String(p.score));
    if (S.pop === i) { sc.classList.remove('pop'); void sc.offsetWidth; sc.classList.add('pop'); }
    // Local play, "visible on its owner's turn only": the other rack shows card backs (and no letters anywhere in the DOM)
    const hide = rackHidden(i), rk = $('#rk' + i), h = p.rack.map((t, k) => `<div class="slot" data-p="${i}" data-i="${k}">${t ? (hide ? '<div class="tile back" aria-hidden="true"></div>' : tileHTML(t)) : ''}</div>`).join('');
    if (rk._h !== h) { rk._h = h; rk.innerHTML = h; }
  });
  S.pop = null;
}
// Every DOM write is guarded: an unchanged value is never written again (a rewrite repaints, and online it shows as flicker).
export function renderControls() {
  const mv = S.move.length > 0, E = S.ended;
  const sub = S.swap ? `تأكيد التبديل (${S.sel.size})` : 'احتساب';   // visually a checkmark only (css/float.css); the words live in the accessible name
  setText($('#bSubmit .lbl'), sub); setAttr($('#bSubmit'), 'aria-label', sub);
  setDis($('#bSubmit'), E || (S.swap ? !S.sel.size : !mv));
  setText($('#bCancel .lbl'), S.swap ? 'إلغاء التبديل' : 'إلغاء الحركة');
  setDis($('#bCancel'), E || (!S.swap && !mv));
  setDis($('#bSwap'), E || S.swap || mv);
  setDis($('#bPass'), E || S.swap || mv);
  setDis($('#bUndo'), E || S.swap || mv || !S.undo);   // online, net.paintControls narrows it further (undo = ask the opponent)
  const lastE = S.hist[S.hist.length - 1];   // a ruling concerns the last move, and only while nobody has ruled on it
  setDis($('#bJudge'), E || S.swap || mv || !S.undo || !(lastE && lastE.type === 'move' && !lastE.st));
  if (app.net) app.net.paintControls();   // online: only the player on turn may act
  renderBag();
}

// The bag count: in the info bar (when shown), in the word log, and on the swap button, the one action it limits. Text is only rewritten when it changes, so nothing is re-announced.
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const setAttr = (el, k, v) => { v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
const setClass = (el, cn) => { if (el.className !== cn) el.className = cn; };
const setDis = (el, v) => { v = !!v; if (el.disabled !== v) el.disabled = v; };
export { setText, setAttr, setClass, setDis };
function renderBag() {
  const n = bagCount(), info = `${profile().labelAr} · الكيس: ${n}`, canSwap = n >= MIN_BAG_SWAP;
  setText($('#bagInfo'), info); setText($('#hBag'), info);
  const badge = $('#bagBadge'), sw = $('#bSwap');
  badge.dataset.s = n === 0 || !canSwap ? 'stop' : n <= MIN_BAG_SWAP ? 'low' : 'ok';
  const sub = `الكيس: ${n}`;
  if (sw.dataset.sub !== sub) sw.dataset.sub = sub;
  setText(badge, String(n));
  setText($('#bagSr'), n === 0 ? '، الكيس فارغ' : canSwap ? `، في الكيس ${n} قطعة` : `، في الكيس ${n} قطعة فقط، لا يمكن التبديل`);
}
// Said once, when a move takes the bag down to 7 or fewer tiles (swapping ends below 7) and when it empties, added to that move's toast. Only when the info bar is hidden.
export function bagNote(before, after) {
  if (document.documentElement.dataset.binfo === 'on') return '';
  if (after === 0 && before > 0) return ' · نفد الكيس — تنتهي اللعبة عندما يستخدم أحد اللاعبين كل قطعه أو ينتهي وقته';
  if (after <= MIN_BAG_SWAP && before > MIN_BAG_SWAP) return ` · ${after === 1 ? 'بقيت قطعة واحدة' : after === 2 ? 'بقيت قطعتان' : `بقي ${after} قطع`} في الكيس`;
  return '';
}
// Chess clock: a short "+5" rises from the clock of the player who has just earned it (the class is removed again by a timer, so nothing stays on screen).
export function bumpClock(i) {
  const el = $('#t' + i); if (!el) return;
  el.dataset.inc = '+' + INCREMENT_MS / 1000; el.classList.remove('inc'); void el.offsetWidth; el.classList.add('inc');
  clearTimeout(el._incT); el._incT = setTimeout(() => el.classList.remove('inc'), 1400);
}
export function tickUI() {
  S.players.forEach((p, i) => {
    const el = $('#t' + i), tx = fmt(p.ms);
    if (el.textContent !== tx) el.textContent = tx;
    const cn = 'ptime' + (p.ms < 60000 ? ' low' : '') + (p.ms < 10000 ? ' crit' : '') + (p.ms === 0 ? ' out' : '') + (!S.started && !S.ended ? ' wait' : '');
    if (el.className !== cn) el.className = cn + (el.classList.contains('inc') ? ' inc' : '');
  });
}
// Word chips shared by the history list and the judge dialog.
export const chips = e => `<div class="jw">${e.words.map(w => `<span class="chip">${w.w} <b>${w.pts}</b></span>`).join('')}${e.bingo ? '<span class="chip bingo">+' + BINGO + '</span>' : ''}</div>`;
// Online: the recorded Tahkim of a move (disputed words, the challenger's reason, the verdict both players agreed on, when it was settled). Collapsed by default.
const stamp = at => { try { return new Date(at).toLocaleString('ar-u-nu-latn', {dateStyle: 'short', timeStyle: 'medium'}); } catch { return ''; } };
function tkRecord(e) {
  const k = e.tk; if (!k) return '';
  return `<details class="hj tkRec"><summary>سجل التحكيم · الحكم المتفق عليه: <b>${k.verdict === 'valid' ? 'صحيح' : 'خطأ'}</b></summary>`
    + `<p>الكلمات المتنازع عليها: ${(k.words || []).map(w => `<bdi class="chip">${esc(w)}</bdi>`).join(' ') || '—'}</p>`
    + `<p>طالب التحكيم: ${nameHtml(k.by)}</p><p>السبب: «${esc(k.reason)}»</p>`
    + `<p>الحكم النهائي: ${k.verdict === 'valid' ? 'صحيح' : 'خطأ'} (باتفاق اللاعبين)${k.pen ? ` · غرامة −${k.pen}` : ''}</p><p>وقت الحسم: <span class="num">${stamp(k.at)}</span></p></details>`;
}
function histItem(e) {
  const cls = 'hi p' + e.p + (e.st === 'void' ? ' void' : ''), who = nameHtml(e.p);
  if (e.type !== 'move')
    return `<li class="${cls}"><div class="hh"><span class="hn">${e.n}</span><span>${who} — ${e.type === 'pass' ? 'مرّر الدور' : `بدّل ${e.cnt} قطع`}</span></div></li>`;
  const j = e.st ? `<div class="hj ${e.st}">${e.st === 'ok' ? '✔ صحيح' : '✖ خطأ'}${e.pen ? ` · غرامة التحدي −${e.pen}` : ''}</div>` : '';
  return `<li class="${cls}"><div class="hh"><span class="hn">${e.n}</span><span>${who}</span><b class="hp">${e.st === 'void' ? 0 : '+' + e.total}</b></div>${chips(e)}${j}${tkRecord(e)}</li>`;
}
function renderHist() {
  if (hs.id === app.gameId && hs.v === S.hv) return;
  hs.id = app.gameId; hs.v = S.hv;
  const best = S.hist.filter(e => e.type === 'move' && e.st !== 'void')
    .flatMap(e => e.words.map(w => ({...w, p: e.p}))).reduce((b, w) => !b || w.pts > b.pts ? w : b, null);
  $('#hList').innerHTML = S.hist.length ? S.hist.map(histItem).reverse().join('') : '<li class="hempty">لم تُسجَّل أي حركة بعد.</li>';
  $('#hBest').textContent = best ? `أعلى كلمة: ${best.w} (${best.pts} نقطة — ${nameIso(best.p)})` : '';
}
// Optional observer called after every render (js/persist.js uses it to save the match); the UI itself does not depend on it.
let afterRender = null;
export const onAfterRender = fn => { afterRender = fn; };
export function render() {
  if (S.pick && !(cur().rack.includes(S.pick) || inMove(S.pick))) S.pick = null;
  renderBoard(); renderPlayers(); renderControls(); renderHist(); tickUI(); S.land = null;
  if (afterRender) afterRender();
}
