// Local-play pause button. It belongs to the SCREEN, not to the game layout: a fixed button anchored to a viewport corner, so it is never positioned relative to a player panel,
// a rack, the board or a control module and cannot move when a rack is resized, the layout changes, the device rotates or the viewport changes size.
// Default: bottom-left corner (above the safe area; the Floating Workspace's minimized tools button lives top-left, the match bar top-right). It can be dragged (a short press pauses, a drag moves it); the spot is stored as "nearest corner + distance from it",
// so after a rotation or a window resize it stays in the same corner at the same distance (clamped inside the screen), never somewhere unrelated.
// Hidden online (the match bar has its own pause), while a dialog or the cover is up, and once the game is over. Pure UI.
import { S, app } from './state.js';
import { pauseGame } from './pause.js';

const KEY = 'scrabble.pausefab', SIZE = 44, EDGE = 8;
const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); if (v && /^[tb][lr]$/.test(v.c) && Number.isFinite(v.dx) && Number.isFinite(v.dy)) return v; } catch { /* default */ } return { c: 'bl', dx: 0, dy: 0 }; };
let pos = read(), btn = null;

const inset = side => { const p = document.createElement('div'); p.style.cssText = `position:fixed;visibility:hidden;padding-${side}:env(safe-area-inset-${side})`; document.body.append(p); const v = parseFloat(getComputedStyle(p)['padding' + side[0].toUpperCase() + side.slice(1)]) || 0; p.remove(); return v; };
function place() {
  if (!btn) return;
  const sa = { top: inset('top'), bottom: inset('bottom'), left: inset('left'), right: inset('right') };
  const w = innerWidth, h = innerHeight;
  const maxX = Math.max(0, w - SIZE - 2 * EDGE - sa.left - sa.right), maxY = Math.max(0, h - SIZE - 2 * EDGE - sa.top - sa.bottom);
  const dx = Math.min(Math.max(0, pos.dx), maxX), dy = Math.min(Math.max(0, pos.dy), maxY);
  const L = pos.c[1] === 'l', T = pos.c[0] === 't';
  btn.style.left = L ? sa.left + EDGE + dx + 'px' : 'auto'; btn.style.right = L ? 'auto' : sa.right + EDGE + dx + 'px';
  btn.style.top = T ? sa.top + EDGE + dy + 'px' : 'auto'; btn.style.bottom = T ? 'auto' : sa.bottom + EDGE + dy + 'px';
}
function store() {   // nearest corner + distance from it
  const r = btn.getBoundingClientRect(), w = innerWidth, h = innerHeight, sa = { top: inset('top'), bottom: inset('bottom'), left: inset('left'), right: inset('right') };
  const L = r.left + SIZE / 2 < w / 2, T = r.top + SIZE / 2 < h / 2;
  pos = { c: (T ? 't' : 'b') + (L ? 'l' : 'r'), dx: Math.max(0, L ? r.left - sa.left - EDGE : w - r.right - sa.right - EDGE), dy: Math.max(0, T ? r.top - sa.top - EDGE : h - r.bottom - sa.bottom - EDGE) };
  try { localStorage.setItem(KEY, JSON.stringify(pos)); } catch { /* storage unavailable */ }
}
export function paintPauseFab() {
  if (!btn) return;
  const show = !app.net && !!S.board && !S.ended && !S.hold && $cover();
  if (btn.hidden === show) btn.hidden = !show;
}
const $cover = () => { const c = document.getElementById('cover'); return !c || c.hidden; };
export function initPauseFab() {
  btn = document.createElement('button'); btn.type = 'button'; btn.id = 'pauseFab'; btn.className = 'pauseFab'; btn.hidden = true;
  btn.setAttribute('aria-label', 'إيقاف اللعبة مؤقتًا'); btn.title = 'إيقاف مؤقت (P) · اسحب لتغيير مكان الزر';
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>';
  document.body.append(btn); place();
  let d = null, swallow = false;
  btn.addEventListener('pointerdown', e => { if (e.button) return; const r = btn.getBoundingClientRect(); d = { x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false }; try { btn.setPointerCapture(e.pointerId); } catch { /* not capturable */ } });
  btn.addEventListener('pointermove', e => {
    if (!d) return;
    if (!d.moved) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return; d.moved = true; btn.classList.add('drag'); }
    const x = Math.min(Math.max(EDGE, e.clientX - d.ox), innerWidth - SIZE - EDGE), y = Math.min(Math.max(EDGE, e.clientY - d.oy), innerHeight - SIZE - EDGE);
    btn.style.left = x + 'px'; btn.style.top = y + 'px'; btn.style.right = btn.style.bottom = 'auto';
  });
  const end = () => { if (!d) return; const m = d.moved; d = null; btn.classList.remove('drag'); if (m) { swallow = true; setTimeout(() => { swallow = false; }, 0); store(); place(); } };
  btn.addEventListener('pointerup', end); btn.addEventListener('pointercancel', end);
  btn.addEventListener('click', () => { if (swallow) { swallow = false; return; } pauseGame(); });
  btn.addEventListener('keydown', e => {
    if (!e.key.startsWith('Arrow') || !e.shiftKey) return;   // Shift + arrows nudge it (plain Enter / Space pause)
    e.preventDefault(); const s = 16, r = btn.getBoundingClientRect();
    btn.style.left = Math.min(Math.max(EDGE, r.left + (e.key === 'ArrowRight' ? s : e.key === 'ArrowLeft' ? -s : 0)), innerWidth - SIZE - EDGE) + 'px';
    btn.style.top = Math.min(Math.max(EDGE, r.top + (e.key === 'ArrowDown' ? s : e.key === 'ArrowUp' ? -s : 0)), innerHeight - SIZE - EDGE) + 'px'; btn.style.right = btn.style.bottom = 'auto'; store(); place();
  });
  addEventListener('resize', place); addEventListener('orientationchange', () => setTimeout(place, 50));
  setInterval(paintPauseFab, 400);   // the visibility rules (cover, online, game over, held) have many sources: one cheap check is simpler and safer than hooking each
}
