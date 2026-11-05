// Pause for local play: either player stops both clocks, the board and the racks are hidden (so a pause cannot be used to plan a move for free), and a full-screen card
// says so until someone resumes. Press the pause button, or the P key; Settings has a button too. Online play has its own pause (js/online/session.js), same card.
import { $, S, app } from './state.js';
import { tick } from './game.js';
import { showOv, hideOv, setOvTime, ovKind } from './overlay.js';
import { nameIso } from './names.js';
import { haptic } from './haptics.js';
import { notice } from './ui.js';
import { initPauseFab } from './pausefab.js';

let t0 = 0, timer = 0;
export const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${s / 60 | 0}:${String(s % 60).padStart(2, '0')}`; };
const busy = () => !!document.querySelector('dialog[open]') || !!S.pending;

export function pauseGame() {
  if (app.net || !S.board || S.ended || S.hold || busy() || ovKind()) return;
  tick(); if (S.ended) return;   // time may have run out this very moment
  S.hold = true; t0 = performance.now();
  document.documentElement.dataset.paused = 'true';
  const draw = () => showOv({
    kind: 'pause', icon: 'pause', title: 'اللعبة متوقفة مؤقتًا',
    lines: [`الساعتان متوقفتان · الدور على ${nameIso(S.cur)}`, 'اللوح والرفوف مخفية حتى الاستئناف.'],
    time: `مدة الإيقاف ${mmss(performance.now() - t0)}`,
    actions: [{ id: 'resume', primary: true, label: 'استئناف اللعب', onClick: resumeGame }]
  });
  draw(); clearInterval(timer); timer = setInterval(() => setOvTime(`مدة الإيقاف ${mmss(performance.now() - t0)}`), 500);
  haptic('tick');
}
export function resumeGame() {
  if (!S.hold) return;
  clearInterval(timer); S.hold = false; S.last = performance.now();   // the time spent paused is never charged
  delete document.documentElement.dataset.paused;
  hideOv('pause'); notice('استُؤنفت اللعبة'); haptic('tick');
}
// v5.5: a clock is only a clock. (It used to be the pause button, which tied the button to the player panel and so to the rack's size; the button now lives on the screen: js/pausefab.js.)
// Kept as a function because online play calls it; it only makes sure no clock still claims to be a button.
export function clockButtons() {
  for (const i of [0, 1]) { const el = document.getElementById('t' + i); if (!el) continue; for (const a of ['role', 'tabindex', 'aria-label', 'title']) el.removeAttribute(a); }
  document.documentElement.removeAttribute('data-clockpause');
}
export function initPause() {
  clockButtons();
  initPauseFab();
  document.addEventListener('keydown', e => {
    if ((e.key !== 'p' && e.key !== 'P') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    pauseGame();
  });
  const b = document.getElementById('pauseNow');
  if (b) b.onclick = () => { document.getElementById('aClose')?.click(); setTimeout(pauseGame, 0); };
}
