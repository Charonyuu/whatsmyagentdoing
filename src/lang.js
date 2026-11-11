'use strict';

// Guess the UI language from what the user actually types to their agents.
// Returns a code from SUPPORTED, or null when there isn't enough text.

const SUPPORTED = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru'];

// Characters that differ between Traditional and Simplified Chinese.
const TRAD = '們這個說會來時為麼發對後還開過們國學實現點頭樣讓進與東車問題當經動種長門關應這給從點'.split('');
const SIMP = '们这个说会来时为么发对后还开过们国学实现点头样让进与东车问题当经动种长门关应这给从点'.split('');
const TRAD_SET = new Set(TRAD.filter((c, i) => c !== SIMP[i]));
const SIMP_SET = new Set(SIMP.filter((c, i) => c !== TRAD[i]));

// Frequent short words, to tell Latin-script languages apart.
const STOP = {
  en: ['the', 'and', 'is', 'to', 'it', 'this', 'that', 'with', 'for', 'you', 'can', 'please', 'what', 'add', 'fix', 'make'],
  es: ['el', 'la', 'que', 'los', 'las', 'por', 'para', 'una', 'con', 'esto', 'puedes', 'hacer', 'está', 'pero'],
  fr: ['le', 'les', 'est', 'et', 'des', 'une', 'pour', 'avec', 'pas', 'que', 'peux', 'faire', 'cette', 'dans'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'ein', 'eine', 'bitte', 'kannst', 'auch', 'für', 'auf'],
  pt: ['não', 'que', 'uma', 'com', 'para', 'isso', 'você', 'pode', 'fazer', 'está', 'mas', 'os', 'as', 'do', 'da'],
};

function guessLanguage(texts, minWeight = 40) {
  let han = 0, kana = 0, hangul = 0, latin = 0, cyrillic = 0, russian = 0, trad = 0, simp = 0;
  const words = [];
  for (const t of texts) {
    if (!t) continue;
    for (const ch of t) {
      const c = ch.codePointAt(0);
      if (c >= 0x3040 && c <= 0x30ff) kana++;
      else if (c >= 0xac00 && c <= 0xd7af) hangul++;
      else if (c >= 0x4e00 && c <= 0x9fff) {
        han++;
        if (TRAD_SET.has(ch)) trad++;
        else if (SIMP_SET.has(ch)) simp++;
      } else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++;
      else if (/\p{Script=Cyrillic}/u.test(ch)) {
        cyrillic++;
        if (/[а-яё]/iu.test(ch)) russian++;
      }
    }
    // Skip code-ish tokens (paths, flags, identifiers) for word counts.
    for (const w of t.toLowerCase().split(/[^a-zà-ÿ]+/)) if (w.length > 1 && w.length < 12) words.push(w);
  }
  // A CJK character carries roughly a word's worth of meaning; weigh it up
  // so English identifiers sprinkled in Chinese prompts don't win.
  const cjk = han + kana + hangul;
  const cjkWeight = cjk * 4;
  if (cjkWeight + latin + russian < minWeight) return null;
  if (cyrillic > cjkWeight && cyrillic > latin) return russian === cyrillic ? 'ru' : null;
  if (cjkWeight > latin) {
    if (kana > cjk * 0.1) return 'ja';
    if (hangul > cjk * 0.3) return 'ko';
    return simp > trad ? 'zh-CN' : 'zh-TW';
  }
  const score = {};
  for (const [lang, list] of Object.entries(STOP)) {
    const set = new Set(list);
    score[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : 'en';
}

// Each distinct prompt gets one vote, so a scheduled job that sends the
// same English prompt fifty times doesn't outvote what the person types.
function guessFromPrompts(prompts) {
  const votes = {};
  const seen = new Set();
  for (const p of prompts) {
    const key = (p || '').trim().slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const lang = guessLanguage([p], 6);
    if (lang) votes[lang] = (votes[lang] || 0) + 1;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

module.exports = { guessLanguage, guessFromPrompts, SUPPORTED };
