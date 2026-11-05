// Scaling of the board and of the text around it.
//
// 1. Whole-pixel cells. The board is 15 equal columns inside a border and a padding. When its width is not a multiple of 15 the cells are fractions of a pixel,
//    so square borders, tile edges and letters land on different sub-pixels from one cell to the next and shimmer while the window is resized. The board's own box is
//    left exactly as the layout made it; only its padding absorbs the remainder, so the content box (and so every cqw unit used by the tiles) is a multiple of 15 px.
// 2. --ui: one number derived from the board's width (1 at 720 px, kept between 0.85 and 1.2). Names, clocks, scores, button labels and the word log multiply their type by it,
//    so the text around the board grows and shrinks with the board instead of staying at one fixed size on a huge display and a tiny window.
// No rule, state or layout formula lives here: without ResizeObserver (or without this module) the CSS defaults apply and the game looks as it did.
const CELLS = 15, MIN_PAD = 0.012, UI_MIN = 0.85, UI_MAX = 1.2, UI_REF = 720;

export function fitBoard(board, root = document.documentElement) {
  const w = board.getBoundingClientRect().width;
  if (!(w > 0)) return;
  const cs = getComputedStyle(board), border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) || 0;
  const inner = Math.max(CELLS, Math.floor((w - border - 2 * w * MIN_PAD) / CELLS) * CELLS), pad = (w - border - inner) / 2;
  const p = pad.toFixed(3) + 'px', ui = Math.min(UI_MAX, Math.max(UI_MIN, w / UI_REF)).toFixed(3);
  if (board.style.getPropertyValue('--bpad') !== p) board.style.setProperty('--bpad', p);
  if (root.style.getPropertyValue('--ui') !== ui) root.style.setProperty('--ui', ui);
}

export function initScale() {
  const board = document.getElementById('board');
  if (!board || typeof ResizeObserver === 'undefined') return;
  let raf = 0;
  const run = () => { raf = 0; fitBoard(board); };
  new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(run); }).observe(board, { box: 'border-box' });
  run();
}
