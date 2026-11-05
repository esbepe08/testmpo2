// The game rules a Tahkim discussion refers to, written for the two players who must agree on a verdict.
// EVERY number and rule below is read from the same modules the engine runs on (config.js, modes.js, rules.js), never typed in by hand, so this panel cannot drift from the game:
// change PENALTY, the clock increment or a tile value and the reference changes with it (tests/online/tahkim-rules.mjs checks it against the engine). Word rules come from wordrules.js.
// Pure: no DOM access, no state. Used by the Tahkim discussion (js/online/tahkim.js).
import { RACK, BINGO, PENALTY, MIN_BAG_SWAP, INCREMENT_MS, TIME_BONUS_PER_MIN, PAUSE_MS, PAUSES_EACH, ABANDON_MS, LAYOUT, LABEL, CENTER } from './config.js';
import { TILE_MODES } from './modes.js';
import { challengePenalty } from './rules.js';
import { rulesHtml } from './wordrules.js';

const L = (ar, id) => `<li><span class="wrAr" lang="ar">${ar}</span>${id ? `<span class="wrId" lang="id" dir="ltr">${id}</span>` : ''}</li>`;
const N = n => `<span class="num">${n}</span>`;
const mins = ms => ms / 60000;

// Facts as data (the tests compare these with the engine); the HTML below is built from the same object.
export function ruleFacts(modeId) {
  const mode = TILE_MODES[modeId] || Object.values(TILE_MODES)[0];
  const count = k => LAYOUT.flat().filter(x => x === k).length;
  const byValue = {};
  for (const [l, v, n] of mode.tiles) { (byValue[v] ||= []).push({ l, n }); }
  return {
    mode: mode.id, modeLabel: mode.labelAr, rack: RACK, bingo: BINGO, penalty: PENALTY, penaltyOf: challengePenalty, minBagSwap: MIN_BAG_SWAP,
    incrementSec: INCREMENT_MS / 1000, timeBonusPerMin: TIME_BONUS_PER_MIN, pauseMin: mins(PAUSE_MS), pausesEach: PAUSES_EACH, abandonMin: mins(ABANDON_MS),
    center: CENTER, premium: { DL: count(1), TL: count(2), DW: count(3) + count(5), TW: count(4) }, label: LABEL, byValue,
    totalTiles: mode.tiles.reduce((s, [, , n]) => s + n, 0)
  };
}

export function gameRulesHtml(modeId) {
  const f = ruleFacts(modeId);
  const vals = Object.keys(f.byValue).map(Number).sort((a, b) => a - b).map(v => {
    const letters = f.byValue[v].map(x => x.l ? `${x.l}${x.n > 1 ? `<small>×${x.n}</small>` : ''}` : `<i>فارغة${x.n > 1 ? `×${x.n}` : ''}</i>`).join(' ');
    return `<li class="tkVal"><b class="num">${v}</b><span lang="ar">${letters}</span></li>`;
  }).join('');
  return `<div class="wr tkDoc">
<h4 class="wrH">كيف يُحسم التحكيم · Cara Tahkim diputuskan</h4>
<ul class="wrList">
${L('عند طلب التحكيم تتوقف الساعتان ويُجمَّد اللعب كله (اللوح والنقاط والأدوار) حتى يتفق اللاعبان.', 'Saat Tahkim diminta, kedua jam berhenti dan permainan dibekukan sampai kedua pemain sepakat.')}
${L('يختار كل لاعب حكمه بنفسه: «صحيح» أو «خطأ». لا يستطيع أي لاعب إنهاء التحكيم وحده.', 'Setiap pemain memilih sendiri: «صحيح» (sah) atau «خطأ» (salah). Tidak ada yang bisa memutuskan sendirian.')}
${L('إن اختلف الاختياران يستمر النقاش، ويجوز لكل لاعب تغيير اختياره قبل الاتفاق. لا يوجد حد زمني للنقاش.', 'Jika pilihan berbeda, diskusi berlanjut; pemain boleh mengubah pilihan. Tidak ada batas waktu.')}
${L(`حكم «صحيح»: تبقى الحركة، ويدفع صاحب الطلب غرامة ${N(f.penalty)} نقاط (أو نقاطه كلها إن كانت أقل: غرامة ${N(f.penaltyOf(3))} عند ${N(3)} نقاط)، وتستأنف الساعتان.`, `Putusan «صحيح»: langkah tetap, pengaju membayar denda ${f.penalty} poin (atau seluruh poinnya bila kurang).`)}
${L(`حكم «خطأ»: تُلغى الحركة، فتعود القطع واللوح والنقاط إلى ما قبلها، ويخسر صاحبها دوره، ولا يحصل على الـ${N(f.incrementSec)} ثوانٍ الإضافية.`, `Putusan «خطأ»: langkah dibatalkan, papan/rak/poin kembali, pemain kehilangan giliran dan tidak mendapat tambahan ${f.incrementSec} detik.`)}
${L(`الاستسلام ممكن في أي وقت: تصبح نقاط المستسلم صفرًا ويفوز الخصم. وإن غاب الخصم عن الاتصال ${N(f.abandonMin)} دقائق أو أكثر يمكنك طلب إنهاء المباراة لصالحك.`, `Menyerah bisa kapan saja (poin menjadi 0, lawan menang).`)}
</ul>
<h4 class="wrH">سير اللعب والاحتساب · Jalannya permainan</h4>
<ul class="wrList">
${L(`الرفّ ${N(f.rack)} قطع. الحركة الأولى تغطي مربع «نجمة» (الصف والعمود ${N(f.center + 1)}). كل كلمة جديدة تتصل بما على اللوح.`, '')}
${L(`قيمة الكلمة = مجموع قيم حروفها؛ مربعات الحرف تضاعف قيمة الحرف (${N('x2')} و${N('x3')}) ومربعات الكلمة تضاعف الكلمة كلها (${N('x2')} و${N('x3')}) ولا تُحسب إلا للقطع الموضوعة في هذه الحركة. القطعة الفارغة قيمتها ${N(0)}.`, '')}
${L(`على اللوح: ${N(f.premium.DL)} مربعات «${f.label[1]}» و${N(f.premium.TL)} «${f.label[2]}» و${N(f.premium.DW)} «${f.label[3]}» (منها النجمة) و${N(f.premium.TW)} «${f.label[4]}».`, '')}
${L(`استعمال القطع السبع كلها في حركة واحدة يضيف ${N(f.bingo)} نقطة.`, '')}
${L(`التمرير غير محدود. التبديل مسموح فقط حين يبقى في الكيس ${N(f.minBagSwap)} قطع أو أكثر.`, '')}
${L(`الساعة على نمط الشطرنج: تُضاف ${N(f.incrementSec)} ثوانٍ لساعتك بعد كل حركة تضع فيها قطعًا (لا في التمرير ولا التبديل ولا الحركة الأخيرة).`, '')}
${L(`الإيقاف المؤقت: لكل لاعب ${N(f.pausesEach)} مرات في المباراة، وكل مرة ${N(f.pauseMin)} دقائق على الأكثر. لا إيقاف أثناء التحكيم لأن الساعتين متوقفتان أصلًا.`, '')}
${L(`نهاية المباراة: ينتهي وقت أحد اللاعبين أو يستخدم أحدهما كل قطعه بعد نفاد الكيس. النتيجة النهائية = النقاط + (الدقائق المتبقية × ${N(f.timeBonusPerMin)}) − قيمة القطع المتبقية.`, '')}
</ul>
<h4 class="wrH">قيم الحروف في نمط «${f.modeLabel}» (${N(f.totalTiles)} قطعة)</h4>
<ul class="wrList tkVals">${vals}</ul>
</div>`;
}

export { rulesHtml as wordRulesHtml };
