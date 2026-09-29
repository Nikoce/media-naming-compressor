const MAX_CAPTION_SECONDS = 2.3;
const MAX_CAPTION_WIDTH = 36;
const MAX_SPEECH_GAP = 0.5;
const CLAUSE_STARTS = new Set(['and', 'but', 'or']);
const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.']);
const ATTACH_TO_NEXT = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our',
  'too', 'very', 'so', 'really', 'quite', 'no', 'not', 'many', 'much',
  'few', 'little', 'more', 'most', 'less', 'and', 'or', 'but', 'to', 'of',
  'for', 'with', 'in', 'on', 'at', 'by', 'from',
]);

function textWidth(text) {
  return [...text].reduce((width, char) => width + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}，。！？、；：]/u.test(char) ? 2 : 1), 0);
}

function cleanText(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}

function appendWord(text, word) {
  const next = cleanText(word);
  if (!text) return next;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text)
    || /[-’']$/u.test(text)
    || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：,.!?;:—–-]/u.test(next)
    ? text + next : `${text} ${next}`;
}

function cueFromWords(words) {
  return {
    start: words[0].start,
    end: words.at(-1).end,
    text: words.reduce((text, word) => appendWord(text, word.text), ''),
  };
}

function attachesToNext(word) {
  const text = cleanText(word.text);
  return !/[。！？!?；;.,，]$/u.test(text) && ATTACH_TO_NEXT.has(text.toLowerCase());
}

function splitBeforeOverflow(words, nextWord) {
  for (const isBoundary of [
    (index) => /[,，]$/u.test(cleanText(words[index - 1].text)),
    (index) => CLAUSE_STARTS.has(cleanText(words[index].text).toLowerCase()),
  ]) {
    for (let index = words.length - 1; index > 0; index -= 1) {
      if (!isBoundary(index)) continue;
      const before = cueFromWords(words.slice(0, index));
      const after = cueFromWords([...words.slice(index), nextWord]);
      if (before.end - before.start >= 0.6
        && textWidth(before.text) >= 10
        && after.end - after.start <= MAX_CAPTION_SECONDS
        && textWidth(after.text) <= MAX_CAPTION_WIDTH) return index;
    }
  }
  let index = words.length;
  while (index > 1 && words.length - index < 3 && attachesToNext(words[index - 1])) index -= 1;
  return index;
}

function splitLongWord(word) {
  const text = cleanText(word.text);
  if (textWidth(text) <= MAX_CAPTION_WIDTH) return [{ ...word, text }];
  const parts = [];
  let part = '';
  for (const char of text) {
    part += char;
    while (textWidth(part) > MAX_CAPTION_WIDTH && part.length > 1) {
      const fitted = part.slice(0, -1);
      const punctuation = Math.max(fitted.lastIndexOf('，'), fitted.lastIndexOf('。'), fitted.lastIndexOf('！'), fitted.lastIndexOf('？'), fitted.lastIndexOf('、'));
      const split = punctuation >= 0 && textWidth(part.slice(0, punctuation + 1)) >= MAX_CAPTION_WIDTH * 0.45
        && punctuation + 1 < part.length ? punctuation + 1 : part.length - 1;
      parts.push(part.slice(0, split).trim());
      part = part.slice(split);
    }
  }
  if (part.trim()) parts.push(part.trim());
  const totalWidth = parts.reduce((sum, value) => sum + textWidth(value), 0);
  let offset = 0;
  return parts.map((value) => {
    const start = word.start + (word.end - word.start) * offset / totalWidth;
    offset += textWidth(value);
    return { text: value, start, end: word.start + (word.end - word.start) * offset / totalWidth };
  });
}

export function cuesFromWords(chunks) {
  const alignedWords = chunks.flatMap((chunk) => {
    const start = Number(chunk.timestamp?.[0]);
    const end = chunk.timestamp?.[1] == null ? start + 0.6 : Number(chunk.timestamp[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !cleanText(chunk.text)) return [];
    return splitLongWord({ text: chunk.text, start: Math.max(0, start), end: Math.max(start + 0.05, end) });
  }).sort((a, b) => a.start - b.start);

  const durations = alignedWords.map((word) => word.end - word.start)
    .filter((duration) => duration >= 0.05 && duration <= 1.2).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0.4;
  const anomalousDuration = Math.max(1.4, Math.min(2, median * 3));
  const words = alignedWords.map((word, index) => {
    const nextStart = alignedWords[index + 1]?.start;
    let end = word.end;
    // Only trim a clearly inflated final-word timestamp; normal word ends stay aligned.
    if (end - word.start > anomalousDuration
      && (nextStart === undefined || nextStart - word.start > anomalousDuration + MAX_SPEECH_GAP)) {
      end = word.start + anomalousDuration;
    }
    if (nextStart !== undefined) end = Math.min(end, Math.max(word.start + 0.05, nextStart));
    return { ...word, end };
  });

  const groups = [];
  let groupWords = [];
  for (const word of words) {
    const group = groupWords.length ? cueFromWords(groupWords) : null;
    const nextText = group ? appendWord(group.text, word.text) : cleanText(word.text);
    if (group && word.start - group.end > MAX_SPEECH_GAP) {
      groups.push(group);
      groupWords = [];
    } else if (group && (word.end - group.start > MAX_CAPTION_SECONDS
      || textWidth(nextText) > MAX_CAPTION_WIDTH)) {
      const split = splitBeforeOverflow(groupWords, word);
      groups.push(cueFromWords(groupWords.slice(0, split)));
      groupWords = groupWords.slice(split);
    }
    groupWords.push(word);
    const current = cueFromWords(groupWords);
    if ((/[。！？!?；;.]$/u.test(current.text) && !ABBREVIATIONS.has(cleanText(word.text).toLowerCase()))
      || (/[，,]$/u.test(current.text) && current.end - current.start >= 1 && textWidth(current.text) >= 18)) {
      groups.push(current);
      groupWords = [];
    }
  }
  if (groupWords.length) groups.push(cueFromWords(groupWords));

  return hardCutCues(groups);
}

export function hardCutCues(cues) {
  const sorted = cues.map((cue) => ({ ...cue })).sort((a, b) => a.start - b.start);
  return sorted.map((cue, index) => ({
    ...cue,
    end: index + 1 < sorted.length ? Math.min(cue.end, sorted[index + 1].start) : cue.end,
  })).filter((cue) => cue.end > cue.start);
}
