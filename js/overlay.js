// A full-screen notice card, like the "game paused" screen of an online tournament: one card on a dimmed, blurred backdrop, a big icon, a title, a few lines,
// an optional running time, and the buttons that matter. While it is up the game behind it is inert (lockGame), so nothing can be played or tapped by accident.
// One module serves the offline pause, the online pause and the online undo request. Updating it (a countdown, a button label) never rebuilds the card or steals focus.
import { lockGame } from './float.js';

const ICON = {
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>',
  judge: '<svg viewBox="0 0 24 24"><path d="M12 4v16M7 20h10M5 8h14M5 8l-3 7a3 3 0 006 0zM19 8l-3 7a3 3 0 006 0z"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/></svg>'
};
const root = () => document.getElementById('mOv');
let acts = [], escape = null, back = null, ready = false;

export const ovKind = () => { const r = root(); return r && !r.hidden ? r.dataset.kind : ''; };

export function showOv({ kind, icon = 'pause', title, lines = [], time = '', actions = [], onEscape = null }) {
  const r = root(); if (!r) return;
  const sig = JSON.stringify([kind, icon, title, lines, actions.map(a => [a.id || '', !!a.primary, !!a.danger])]);
  acts = actions; escape = onEscape;
  if (r.hidden || r._sig !== sig) {
    const wasHidden = r.hidden;
    r._sig = sig; r.dataset.kind = kind; r.dataset.tone = icon;
    document.getElementById('mOvIc').innerHTML = ICON[icon] || '';
    document.getElementById('mOvT').textContent = title;
    document.getElementById('mOvB').replaceChildren(...lines.map(t => Object.assign(document.createElement('p'), { textContent: t })));
    document.getElementById('mOvAct').replaceChildren(...actions.map((a, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.i = i;
      b.className = 'btn' + (a.primary ? ' main' : '') + (a.danger ? ' danger' : '');
      return b;
    }));
    if (wasHidden) { back = document.activeElement; r.hidden = false; lockGame('overlay', true); }
    wire();
    const first = r.querySelector('button.main:not(:disabled)') || r.querySelector('button:not(:disabled)');
    requestAnimationFrame(() => (first || r.querySelector('.mOvCard')).focus({ preventScroll: true }));
  }
  actions.forEach((a, i) => setOvAction(i, a));
  setOvTime(time);
}
export function setOvAction(i, { label, disabled = false }) {
  const b = root()?.querySelector(`#mOvAct button[data-i="${i}"]`); if (!b) return;
  if (b.textContent !== label) b.textContent = label;
  if (b.disabled !== !!disabled) b.disabled = !!disabled;
}
export function setOvTime(t) { const e = document.getElementById('mOvTime'); if (e && e.textContent !== t) { e.textContent = t; e.hidden = !t; } }
export function hideOv(kind) {
  const r = root(); if (!r || r.hidden || (kind && r.dataset.kind !== kind)) return;
  r.hidden = true; r._sig = ''; lockGame('overlay', false); acts = []; escape = null;
  const b = back; back = null; if (b && b.isConnected && b.focus) b.focus({ preventScroll: true });
}
function wire() {
  if (ready) return; ready = true;
  const r = root();
  r.addEventListener('click', e => { const b = e.target.closest('#mOvAct button'); if (b && !b.disabled) acts[+b.dataset.i]?.onClick?.(); });
  r.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); escape?.(); return; }
    if (e.key !== 'Tab') return;
    const bs = [...r.querySelectorAll('#mOvAct button:not(:disabled)')];
    if (!bs.length) { e.preventDefault(); return; }
    const i = bs.indexOf(document.activeElement), n = e.shiftKey ? (i <= 0 ? bs.length - 1 : i - 1) : (i + 1) % bs.length;
    e.preventDefault(); bs[n].focus();
  });
}
