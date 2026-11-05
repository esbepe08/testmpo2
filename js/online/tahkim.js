// The Tahkim discussion (online): ONE shared chat box for both players, opened by the server's state (game.status === 'tahkim_pending', game.tahkim.state === 'discussion').
// The server owns everything that matters (the chat history, both players' current choices, the verdict, the frozen clocks). This module only DRAWS that state and sends two kinds of
// request: a chat message and "my choice is valid / invalid / none". It decides nothing, so a refresh or a reconnection simply draws the same panel again from the snapshot.
//   - The panel cannot be dismissed: it closes only when the server says the dispute is settled (or the match ended), never by a button, Esc or a click outside.
//   - Everything else in the game is inert behind it (lockGame('tahkim')); surrender and "the opponent has gone" stay available inside it.
//   - The Rules Reference is a LOCAL view setting: opening or closing it touches no server state, no clock, no game state and nothing the other player sees (js/tahkimrules.js).
import { $ } from '../state.js';
import { nameIso } from '../names.js';
import { lockGame } from '../float.js';
import { ABANDON_MS, TAHKIM_CHAT_MAX_CHARS } from '../config.js';
import { gameRulesHtml, wordRulesHtml } from '../tahkimrules.js';
import { haptic } from '../haptics.js';

const K_RULES = 'scrabble.tkRules';
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the choice lasts for this session */ } };
const VERDICT_AR = { valid: 'صحيح', invalid: 'خطأ' };
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(s / 60 | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const clockText = at => { try { return new Date(at).toLocaleTimeString('ar-u-nu-latn', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let host = null, root = null, ui = null, shown = false, seenId = 0, gameKey = '', sending = false, confirmResign = false, rulesOpen = get(K_RULES) === 'open', tab = 'game', pending = [];

// host: { snap(), seat(), oppHere(), oppIdleNow(), online(), say(text) -> Promise<boolean>, choose(verdict|null) -> Promise, resign(), claim() }
export function initTahkim(h) { host = h; }

function build() {
  root = el('section', 'tkPanel'); root.id = 'tkPanel'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'tkTitle');
  root.innerHTML = `<div class="tkCard" id="tkCard" tabindex="-1">
<header class="tkHead"><h2 id="tkTitle">مناقشة التحكيم</h2><span class="tkFrozen" id="tkFrozen">الساعتان متوقفتان</span>
<button type="button" class="btn tkRulesBtn" id="tkRulesBtn" aria-expanded="false" aria-controls="tkRules">📖 مرجع القواعد</button></header>
<div class="tkCase" id="tkCase"></div>
<div class="tkBody" id="tkBody">
<div class="tkChat"><ol class="tkLog" id="tkLog" role="log" aria-live="polite" aria-label="رسائل التحكيم" tabindex="0"></ol>
<div class="tkForm" id="tkForm"><label class="vh" for="tkText">رسالتك</label><input id="tkText" class="tkText" type="text" maxlength="${TAHKIM_CHAT_MAX_CHARS}" autocomplete="off" enterkeyhint="send" placeholder="اكتب رسالتك للخصم…"><button type="button" class="btn main tkSend" id="tkSend">إرسال</button></div></div>
<aside class="tkRules" id="tkRules" hidden aria-label="مرجع القواعد"><div class="seg tkTabs" role="group" aria-label="قسم القواعد"><button type="button" class="btn" data-tab="game">قواعد اللعبة</button><button type="button" class="btn" data-tab="words">قواعد الكلمات</button></div><div class="tkRulesText" id="tkRulesText" tabindex="0"></div></aside>
</div>
<footer class="tkDecide"><p class="tkState" id="tkState" role="status" aria-live="polite"></p>
<div class="tkPick" role="group" aria-label="حكمك النهائي"><button type="button" class="btn yes" id="tkValid" data-v="valid" aria-pressed="false">✔ صحيح</button><button type="button" class="btn danger" id="tkInvalid" data-v="invalid" aria-pressed="false">✖ خطأ</button></div>
<p class="tkNote" id="tkOpp"></p>
<div class="tkSafe"><button type="button" class="btn" id="tkClaim" hidden disabled></button><button type="button" class="btn danger" id="tkResign">استسلام</button></div></footer></div>`;
  document.body.append(root);
  ui = { card: $('#tkCard'), case: $('#tkCase'), log: $('#tkLog'), text: $('#tkText'), send: $('#tkSend'), state: $('#tkState'), opp: $('#tkOpp'), claim: $('#tkClaim'), resign: $('#tkResign'),
    valid: $('#tkValid'), invalid: $('#tkInvalid'), rules: $('#tkRules'), rulesBtn: $('#tkRulesBtn'), rulesText: $('#tkRulesText') };
  ui.rulesBtn.addEventListener('click', () => setRules(!rulesOpen));
  $('#tkRules .tkTabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { tab = b.dataset.tab; paintRules(true); } });
  ui.send.addEventListener('click', send);
  ui.text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  for (const b of [ui.valid, ui.invalid]) b.addEventListener('click', () => pick(b.dataset.v));
  ui.claim.addEventListener('click', () => host.claim());
  ui.resign.addEventListener('click', () => { confirmResign = !confirmResign; paintSafety(); });
  root.addEventListener('click', e => { const b = e.target.closest('[data-rs]'); if (!b) return; if (b.dataset.rs === 'yes') host.resign(); else { confirmResign = false; paintSafety(); } });
  root.addEventListener('keydown', e => {   // the panel cannot be dismissed: Esc does nothing; Tab stays inside
    if (e.key === 'Escape') { e.preventDefault(); return; }
    if (e.key !== 'Tab') return;
    const ok = [...root.querySelectorAll('button:not(:disabled),input,[tabindex="0"]')].filter(n => !n.closest('[hidden]') && n.offsetParent !== null);
    if (!ok.length) return;
    const i = ok.indexOf(document.activeElement), n = e.shiftKey ? (i <= 0 ? ok.length - 1 : i - 1) : (i === ok.length - 1 ? 0 : i + 1);
    e.preventDefault(); ok[n].focus();
  });
}

// ---- the rules reference: a personal view setting. Nothing here is sent anywhere and nothing in the game reads it. ----
function setRules(open) {
  rulesOpen = !!open; put(K_RULES, rulesOpen ? 'open' : 'closed'); paintRules();
}
let rulesFor = '';
function paintRules(force = false) {
  const g = host?.snap()?.game;
  root.dataset.rules = rulesOpen ? 'open' : 'closed';
  ui.rules.hidden = !rulesOpen;
  ui.rulesBtn.setAttribute('aria-expanded', String(rulesOpen));
  ui.rulesBtn.textContent = rulesOpen ? '✕ إخفاء القواعد' : '📖 مرجع القواعد';
  for (const b of ui.rules.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  if (!rulesOpen) return;
  const key = tab + ':' + (g?.tile_mode || '');
  if (force || rulesFor !== key) { rulesFor = key; ui.rulesText.innerHTML = tab === 'game' ? gameRulesHtml(g?.tile_mode) : wordRulesHtml(); ui.rulesText.scrollTop = 0; }
}

// ---- chat ----
function scrolledToEnd() { const l = ui.log; return l.scrollHeight - l.scrollTop - l.clientHeight < 48; }
function addMsg(m, me) {
  const li = el('li', 'tkMsg ' + (me ? 'me' : 'opp')); li.dataset.i = m.i;
  li.append(el('span', 'tkWho', nameIso(m.s)), el('p', 'tkTxt', m.t), el('time', 'tkTime', clockText(m.at)));
  return li;
}
function paintChat(t, me) {
  const stick = scrolledToEnd(), msgs = t.chat || [];
  const have = new Set([...ui.log.querySelectorAll('li[data-i]')].map(n => +n.dataset.i));
  const first = msgs.length ? msgs[0].i : 0;
  for (const n of ui.log.querySelectorAll('li[data-i]')) if (+n.dataset.i < first) n.remove();   // the server dropped the oldest ones
  let added = false, fromOpp = false;
  for (const m of msgs) {
    if (have.has(m.i)) continue;
    if (m.s === me) { const k = pending.findIndex(p => p.text === m.t); if (k >= 0) { pending[k].li.remove(); pending.splice(k, 1); } }
    else if (seenId && m.i > seenId) fromOpp = true;
    ui.log.insertBefore(addMsg(m, m.s === me), ui.log.querySelector('li.pending')); added = true;   // pending echoes stay at the end
  }
  seenId = Math.max(seenId, t.chat_n || 0);
  if (added && stick) ui.log.scrollTop = ui.log.scrollHeight;
  if (fromOpp) haptic('tick');
  if (!ui.log.children.length) { if (!ui.log.dataset.empty) { ui.log.dataset.empty = '1'; } } else delete ui.log.dataset.empty;
}
async function send() {
  const text = ui.text.value.replace(/\s+/g, ' ').trim();
  if (!text || [...text].length > TAHKIM_CHAT_MAX_CHARS) return;
  ui.text.value = '';
  const li = addMsg({ i: 0, s: host.seat(), t: text, at: Date.now() }, true); li.classList.add('pending'); li.removeAttribute('data-i'); ui.log.append(li);
  const p = { text, li }; pending.push(p); ui.log.scrollTop = ui.log.scrollHeight;
  const ok = await host.say(text);
  if (!ok) { li.remove(); const k = pending.indexOf(p); if (k >= 0) pending.splice(k, 1); if (!ui.text.value) ui.text.value = text; }   // not sent: the text goes back into the box
  else if (pending.includes(p)) { /* the snapshot that carries the message replaces the echo (paintChat) */ }
  ui.text.focus({ preventScroll: true });
}

// ---- decision ----
async function pick(v) {
  const g = host.snap()?.game, t = g?.tahkim; if (!t || t.state !== 'discussion' || sending) return;
  const mine = (t.choices || [])[host.seat()];
  sending = true; paintDecide();
  try { await host.choose(mine === v ? null : v); } finally { sending = false; paintDecide(); }   // pressing your current choice takes it back
}
function paintDecide() {
  const snap = host.snap(), g = snap?.game, t = g?.tahkim; if (!t) return;
  const me = host.seat(), opp = 1 - me, c = t.choices || [null, null], mine = c[me], theirs = c[opp], on = g.status === 'tahkim_pending' && t.state === 'discussion';
  for (const [b, v] of [[ui.valid, 'valid'], [ui.invalid, 'invalid']]) { b.setAttribute('aria-pressed', String(mine === v)); b.disabled = !on || sending; b.classList.toggle('sel', mine === v); }
  let s;
  if (!mine && !theirs) s = 'اتفقا على حكم واحد لإنهاء التحكيم. لم يختر أحدكما بعد.';
  else if (mine && !theirs) s = `اخترتَ «${VERDICT_AR[mine]}». بانتظار اختيار ${nameIso(opp)}.`;
  else if (!mine && theirs) s = `${nameIso(opp)} اختار «${VERDICT_AR[theirs]}». اختر حكمك أنت.`;
  else s = `اختياراكما مختلفان («${VERDICT_AR[mine]}» و«${VERDICT_AR[theirs]}»): تابعا النقاش. لكل منكما أن يغيّر اختياره.`;
  if (ui.state.textContent !== s) ui.state.textContent = s;
  ui.state.dataset.diff = String(!!mine && !!theirs && mine !== theirs);
  const o = theirs ? `اختيار ${nameIso(opp)}: ${VERDICT_AR[theirs]}` : `${nameIso(opp)} لم يختر بعد`;
  if (ui.opp.textContent !== o) ui.opp.textContent = o;
}
function paintCase(snap) {
  const g = snap.game, t = g.tahkim, e = snap.moves.find(x => x.n === t.move_number);
  const sig = JSON.stringify([t.move_number, t.reason, t.challenger_seat, t.words]);
  if (ui.case.dataset.sig === sig) return;
  ui.case.dataset.sig = sig; ui.case.replaceChildren();
  const top = el('div', 'tkCaseTop');
  top.append(el('span', 'tkBy', `${nameIso(t.challenger_seat)} يطلب تحكيم حركة ${nameIso(1 - t.challenger_seat)} (الحركة ${t.move_number}${e ? ` · ${e.total} نقطة` : ''})`));
  const words = el('div', 'tkWords');
  for (const w of t.words || []) words.append(el('span', 'chip', w));
  ui.case.append(top, words, Object.assign(el('p', 'tkWhy'), { textContent: `السبب: «${t.reason}»` }));
}

// ---- safety: surrender and "the opponent has gone" (a discussion is only ever ended by agreement, surrender, or this explicit claim) ----
function paintSafety() {
  const box = ui.resign.parentElement;
  box.querySelector('.tkConfirm')?.remove();
  ui.resign.hidden = confirmResign;
  if (confirmResign) {
    const c = el('div', 'tkConfirm'); c.setAttribute('role', 'alertdialog'); c.setAttribute('aria-label', 'تأكيد الاستسلام');
    c.append(el('span', null, 'تصبح نقاطك صفرًا ويفوز خصمك. متأكد؟'));
    const y = el('button', 'btn danger', 'نعم، أستسلم'), n = el('button', 'btn', 'رجوع'); y.type = n.type = 'button'; y.dataset.rs = 'yes'; n.dataset.rs = 'no';
    c.append(y, n); box.append(c);
  }
  const show = !host.oppHere() && host.online();
  if (ui.claim.hidden === show) ui.claim.hidden = !show;
  if (!show) return;
  const left = ABANDON_MS - host.oppIdleNow(), t = left <= 0 ? 'إنهاء المباراة والفوز' : `الخصم غائب · يمكنك الإنهاء بعد ${mmss(left)}`;
  if (ui.claim.textContent !== t) ui.claim.textContent = t;
  ui.claim.disabled = left > 0;
}

// ---- entry points called by the session ----
export function tahkimOpen() { return shown; }
export function paintTahkim(snap) {
  if (!host) return;
  const g = snap.game, t = g.tahkim, open = g.status === 'tahkim_pending' && t && t.state === 'discussion';
  if (!open) return closeTahkim();
  if (!root) build();
  const key = g.id + ':' + g.round + ':' + t.move_number;
  if (key !== gameKey) { gameKey = key; ui.log.replaceChildren(); seenId = 0; pending = []; confirmResign = false; ui.case.dataset.sig = ''; ui.text.value = ''; }
  if (!shown) { shown = true; root.hidden = false; lockGame('tahkim', true); document.documentElement.dataset.tahkim = 'true'; requestAnimationFrame(() => ui.card.focus({ preventScroll: true })); haptic('tick'); }
  paintCase(snap); paintChat(t, snap.me.seat); paintDecide(); paintRules(); paintSafety();
  if (!ui.log.dataset.scrolled) { ui.log.scrollTop = ui.log.scrollHeight; ui.log.dataset.scrolled = '1'; }
}
export function closeTahkim() {
  if (!shown) return;
  shown = false; if (root) { root.hidden = true; delete ui.log.dataset.scrolled; } lockGame('tahkim', false); delete document.documentElement.dataset.tahkim; confirmResign = false;
}
export const tickTahkim = () => { if (shown) paintSafety(); };
export const paintTahkimPresence = () => { if (shown) paintSafety(); };
