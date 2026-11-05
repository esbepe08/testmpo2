// Two small personal preferences in Settings (each stored on this device only):
//   rack     local play:   'always' = both racks always face up (default); 'turn' = a rack is face up only while it is its player's turn (the other one shows card backs).
//   live     online play:  show the opponent's tentative tiles to me and mine to them (on by default; the host's room rule can also switch it off for the match).
import { S, app } from './state.js';

const K_RACK = 'scrabble.rack', K_LIVE = 'eas.live', K_FD = 'scrabble.firstdraw';
const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the choice lasts for this session */ } };

let rack = get(K_RACK, 'always') === 'turn' ? 'turn' : 'always', live = get(K_LIVE, '1') !== '0', draw = get(K_FD, 'on') !== 'off';
export const rackMode = () => rack;
export const firstDrawOn = () => draw;   // local play: decide who starts by drawing a tile each (on by default)
export const livePref = () => live;

// A rack is hidden only in local play, only in "turn" mode, only while the game runs, and only for the player who is not on turn.
export const rackHidden = i => !app.net && rack === 'turn' && !S.ended && i !== S.cur;

let rerender = () => {};
export function initPrefs(render) {
  rerender = render;
  const seg = (id, title, note, opts, value, set) => {
    const box = document.getElementById(id); if (!box) return;
    const draw = () => {
      box.innerHTML = `<div class="segRow"><div class="setRowHead">${title}</div><div class="seg" role="group" aria-label="${title}">`
        + opts.map(([v, t]) => `<button type="button" class="btn" data-v="${v}" aria-pressed="${value() === v}">${t}</button>`).join('')
        + `</div><p class="setNote">${note}</p></div>`;
    };
    draw();
    box.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b) return; set(b.dataset.v); draw(); });
  };
  seg('rkB', 'عرض الرفوف', 'تنطبق على اللعب المحلي. «في دوره فقط» تُظهر رفّ اللاعب صاحب الدور وتُخفي رفّ خصمه خلف ظهر القطع.',
    [['always', 'ظاهرة دائمًا'], ['turn', 'ظاهرة في دور صاحبها فقط']], () => rack, v => { rack = v === 'turn' ? 'turn' : 'always'; put(K_RACK, rack); rerender(); });
  seg('fdB', 'من يبدأ؟', 'اللعب المحلي: يسحب كل لاعب قطعة من الكيس ويبدأ صاحب القيمة الأعلى (التعادل يُعاد سحبه)، أو يبدأ اللاعب الأول دائمًا. عبر الإنترنت يسحب الخادم القطعتين دائمًا.',
    [['on', 'بسحب قطعة'], ['off', 'اللاعب الأول']], () => draw ? 'on' : 'off', v => { draw = v !== 'off'; put(K_FD, draw ? 'on' : 'off'); });
  seg('lvB', 'المعاينة المباشرة', 'اللعب عبر الإنترنت: يرى الخصم القطع التي تجرّبها قبل الاحتساب وترى قطعه (ظلال متقطعة). تعمل حين يسمح بها المضيف أيضًا.',
    [['1', 'مفعّلة'], ['0', 'مغلقة']], () => live ? '1' : '0', v => { live = v === '1'; put(K_LIVE, v); document.dispatchEvent(new CustomEvent('eas:livepref')); });
}
