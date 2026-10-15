export function appendCaptionText(text, value) {
  const next = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text) return next;
  const attach = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text)
    || /[-’'“「『（([{£€$¥₹]$/u.test(text)
    || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：,.!?;:—–\-’'%‰°)\]}）】」』”]/u.test(next)
    || /\p{N}[,.:/]$/u.test(text) && /^\p{N}/u.test(next);
  return attach ? text + next : `${text} ${next}`;
}

// Decoder chunks are not always complete display units. Protect decimals,
// grouped numbers, currencies, contractions and closing punctuation before
// either cue splitting or visual line wrapping gets a chance to separate them.
export function continuesCaptionUnit(previous, next, following = '') {
  return /\p{N}$/u.test(previous) && /^[,.:/]\p{N}/u.test(next)
    || /\p{N}[,.:/]$/u.test(previous) && /^\p{N}/u.test(next)
    || /\p{N}$/u.test(previous) && /^[,.:/]$/u.test(next) && /^\p{N}/u.test(following)
    || /^[£€$¥₹(（[「『“]+$/u.test(previous)
    || /^[-’']/u.test(next)
    || /[-’']$/u.test(previous)
    || /^[,.;:!?，。！？、；：%‰°)\]}）】」』”]+$/u.test(next)
    || /\p{N}$/u.test(previous) && /^[%‰°]/u.test(next);
}
