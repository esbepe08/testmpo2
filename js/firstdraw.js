// "Who starts?": each player draws one tile, the higher value starts (a blank counts 0), a tie is drawn again: the way a real game of Scrabble begins.
//   Local play : interactive. Each player taps their own tile to draw it; the tiles come from the bag (js/firstdraw.js → startLocalDraw).
//   Online     : the SERVER draws (engine.drawFirst) and both browsers play the same recorded draw, so neither player can influence it; auto-played, skippable.
// One card on a dimmed, blurred backdrop (like the pause card): tiles rise in, tiles flip, the winner lifts and glows, the loser steps back. Nothing else moves.
// Reduced motion keeps every state and drops the movement.
import { S, app } from './state.js';
import { lockGame } from './float.js';
import { GLYPH, FACE } from './config.js';
import { haptic } from './haptics.js';
import { nameIso } from './names.js';
import { notice, render } from './ui.js';
import { firstDrawOn } from './prefs.js';

const val = t => t.blank ? 0 : t.v;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const front = t => {   // the same tile look as the board and racks (css/style.css .tile), at a fixed size
  const L = t.blank ? '' : t.l, g = GLYPH[L];
  const d = el('div', 'tile' + (t.blank ? ' blank' : '')), b = el('b', '', FACE[L] || L), i = el('i', '', String(val(t)));
  if (g) b.style.transform = `translate(${g[0]}em,${g[1]}em)`;
  d.append(b, i); return d;
};
const pts = t => t.blank ? 'قطعة فارغة · 0' : `${val(t)} ${val(t) === 1 ? 'نقطة' : 'نقاط'}`;

export function firstDraw({ names, auto = null, pick = null, onDone }) {
  if (document.getElementById('fdOv')) return;   // one draw at a time
  const back = document.activeElement, still = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const root = el('div', 'fdOv'); root.id = 'fdOv';
  const card = el('div', 'fdCard'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'fdT'); card.tabIndex = -1;
  const title = el('h2', '', 'من يبدأ؟'); title.id = 'fdT';
  const sub = el('p', 'fdSub'), stage = el('div', 'fdStage'), msg = el('p', 'fdMsg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
  const go = el('button', 'btn main', 'ابدأ اللعب'); go.type = 'button'; go.hidden = true;
  const skip = el('button', 'btn', auto ? 'تخطّي' : 'تخطّي (قرعة عشوائية)'); skip.type = 'button';
  const act = el('div', 'fdAct'); act.append(go, skip);
  card.append(title, sub, stage, msg, act); root.append(card); document.body.append(root); lockGame('overlay', true);
  requestAnimationFrame(() => { root.classList.add('on'); (auto ? skip : card).focus({ preventScroll: true }); });

  let alive = true, roundNo = 0, pair = null, shown = [false, false], tiles = [], winner = null;
  const timers = new Set(), later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, still ? Math.min(ms, 250) : ms); timers.add(t); };
  const finish = (seat, how) => {
    if (!alive) return; alive = false; timers.forEach(clearTimeout); document.removeEventListener('keydown', onKey, true); lockGame('overlay', false);
    root.classList.remove('on'); root.classList.add('out'); setTimeout(() => root.remove(), still ? 0 : 260);
    if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
    onDone?.(seat, how);
  };

  function build(p) {
    pair = p; shown = [false, false]; winner = null; stage.replaceChildren(); tiles = []; go.hidden = true;
    sub.textContent = auto ? (roundNo ? 'تعادل — سحبة جديدة' : 'يسحب كل لاعب قطعة، وصاحب القيمة الأعلى يبدأ') : (roundNo ? 'تعادل — اسحبا من جديد' : 'اضغط على قطعتك لتسحبها، وصاحب القيمة الأعلى يبدأ');
    msg.textContent = '';
    [0, 1].forEach(i => {
      const slot = el('div', 'fdSlot'), nm = el('div', 'fdName', names[i]);
      const t = el('button', 'fdTile'); t.type = 'button'; t.setAttribute('aria-label', `قطعة ${names[i]}${auto ? '' : ' — اضغط للسحب'}`);
      const inn = el('div', 'fdIn'), bk = el('div', 'fdFace fdBack'), fr = el('div', 'fdFace fdFront');
      bk.append(el('div', 'tile back')); fr.append(front(p[i])); inn.append(bk, fr); t.append(inn);
      const v = el('div', 'fdVal', ' ');
      t.style.setProperty('--d', `${i * 0.12}s`);
      if (!auto) { t.classList.add('ready'); t.onclick = () => reveal(i); } else t.tabIndex = -1;
      slot.append(nm, t, v); stage.append(slot); tiles.push({ slot, t, v });
      if (i === 0) stage.append(el('div', 'fdVs', '؟'));
    });
    if (auto) { later(750, () => reveal(0)); later(1450, () => reveal(1)); }
  }
  function reveal(i) {
    if (!alive || shown[i]) return; shown[i] = true;
    const { t, v } = tiles[i]; t.classList.remove('ready'); t.classList.add('flip'); t.disabled = true; v.textContent = pts(pair[i]); haptic('tick');
    msg.textContent = shown[0] && shown[1] ? '' : `${names[i]} سحب ${pair[i].blank ? 'قطعة فارغة' : `«${pair[i].l}»`}`;
    if (shown[0] && shown[1]) later(800, judge);
  }
  function judge() {
    const a = val(pair[0]), b = val(pair[1]);
    if (a === b) {
      tiles.forEach(x => x.t.classList.add('tie'));
      const more = auto ? roundNo + 1 < auto.rounds.length : true;
      msg.textContent = more ? 'تعادل! نسحب من جديد' : 'تعادل متكرر — القرعة تختار';
      if (more) { later(1500, () => { roundNo++; build(auto ? auto.rounds[roundNo] : pick()); rise(); }); return; }
      return decide(auto.seat);
    }
    decide(a > b ? 0 : 1);
  }
  function decide(seat) {
    winner = seat; tiles.forEach((x, i) => x.slot.classList.add(i === seat ? 'win' : 'lose'));
    msg.textContent = `${names[seat]} يبدأ اللعب`; sub.textContent = ''; haptic('score');
    go.hidden = false; skip.hidden = true;
    if (auto) later(2600, () => finish(seat, 'draw'));
    requestAnimationFrame(() => go.focus({ preventScroll: true }));
  }
  const rise = () => { stage.classList.remove('rise'); void stage.offsetWidth; stage.classList.add('rise'); };

  go.onclick = () => finish(winner, 'draw');
  skip.onclick = () => finish(auto ? auto.seat : (Math.random() < 0.5 ? 0 : 1), 'skip');
  // On the document, not on the card: focus can be on the page for a moment (a tile that was just tapped is disabled), and Escape / Tab must still work.
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); if (winner != null) finish(winner, 'draw'); else skip.click(); }
    else if (e.key === 'Tab') {
      const bs = [...card.querySelectorAll('button:not([hidden]):not(:disabled)')]; e.preventDefault(); if (!bs.length) return;
      const i = bs.indexOf(document.activeElement); bs[e.shiftKey ? (i <= 0 ? bs.length - 1 : i - 1) : (i + 1) % bs.length].focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  build(auto ? auto.rounds[0] : pick()); rise();
}

// ---------- local play ----------
// Two tiles taken at random from the bag (not removed: they go back, as in a real game). EAS_FIRSTDRAW_PICK is a test hook, like EAS_BACKEND_FACTORY.
const pickLocal = () => {
  const hooked = window.EAS_FIRSTDRAW_PICK?.(); if (Array.isArray(hooked) && hooked.length === 2) return hooked;   // test hook; anything else falls back to real bag tiles
  const bag = S.bag, i = Math.floor(Math.random() * bag.length); let j = Math.floor(Math.random() * (bag.length - 1)); if (j >= i) j++;
  return [bag[i], bag[j]].map(t => ({ l: t.blank ? '' : t.l, v: t.blank ? 0 : t.v, blank: !!t.blank }));
};
// Called right after a new local game has been created. A display is needed (no overlay in a headless test harness) and the setting must be on (Settings → بداية المباراة).
export function startLocalDraw() {
  if (app.net || !S.board || typeof matchMedia !== 'function' || !firstDrawOn()) return;
  S.hold = true;
  firstDraw({
    names: [nameIso(0), nameIso(1)], pick: pickLocal,
    onDone: seat => { S.hold = false; S.cur = seat; S.last = performance.now(); S.sel.clear(); render(); notice(`${nameIso(seat)} يبدأ اللعب`); }
  });
}
