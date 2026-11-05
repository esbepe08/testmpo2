import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');   // project root
export function boot(storage = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  // <dialog> polyfill: showModal sets `open`, close fires the 'close' event like a browser would
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };   // the in-game dialogue is non-modal now
  w.HTMLDialogElement.prototype.close = function (rv) {
    if (rv !== undefined) this.returnValue = rv;
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open'); this.dispatchEvent(new w.Event('close'));
  };
  for (const k of ['window', 'document', 'localStorage', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'DragEvent', 'Node'])
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k] ?? class {}, configurable: true, writable: true });
  return w;
}
// Click a <button value=...> inside a method=dialog form: sets returnValue and closes, like the browser does.
export const choose = (sel, value) => { const d = document.querySelector(sel); d.close(value); };
