import { appendCaptionText as appendWord, continuesCaptionUnit } from './caption-text.js';

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

function alignChunks(chunks, duration) {
  const words = [];
  let prefix = '';
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  for (const chunk of chunks) {
    const text = cleanText(chunk.text);
    if (!text) continue;
    const [rawStart, rawEnd] = chunk.timestamp || [];
    const previous = words.at(-1);
    const hasStart = typeof rawStart === 'number' && Number.isFinite(rawStart);
    const hasEnd = typeof rawEnd === 'number' && Number.isFinite(rawEnd);
    // Missing timestamps are unknown, not zero. Keep their text with an anchored
    // neighbour instead of moving it to the beginning of the video.
    if (!hasStart) {
      if (previous) {
        previous.text = appendWord(previous.text, text);
        if (hasEnd) previous.end = Math.min(limit, Math.max(previous.end, rawEnd));
      } else prefix = appendWord(prefix, text);
      continue;
    }
    if (rawStart >= limit) continue;
    // Preserve transcript order even when overlap decoding returns tied/backward
    // starts. Sorting first can reorder words, and hard-cutting ties loses text.
    const start = Math.max(0, rawStart, previous?.start ?? 0);
    const end = Math.min(limit, hasEnd && rawEnd > start ? rawEnd : start + (hasEnd ? .02 : .6));
    const wordText = appendWord(prefix, text);
    prefix = '';
    if (previous && start === previous.start) {
      previous.text = appendWord(previous.text, wordText);
      previous.end = Math.max(previous.end, end);
    } else words.push({ text: wordText, start, end, continuousSpeech: chunk.continuousSpeech });
  }
  const units = [];
  for (const [index, word] of words.entries()) {
    const previous = units.at(-1);
    if (previous && word.start - previous.end <= MAX_SPEECH_GAP
      && continuesCaptionUnit(previous.text, word.text, words[index + 1]?.text)) {
      previous.text = appendWord(previous.text, word.text);
      previous.end = Math.max(previous.end, word.end);
    } else units.push({ ...word });
  }
  return units.flatMap(splitLongWord);
}

export function cuesFromWords(chunks, { duration } = {}) {
  const alignedWords = alignChunks(chunks, duration);

  const words = alignedWords.map((word, index) => {
    const nextStart = alignedWords[index + 1]?.start;
    let end = word.end;
    // Silence is checked against audio before grouping. A duration cap alone
    // cannot tell which end is wrong and can erase the actual spoken interval.
    if (nextStart !== undefined) end = Math.min(end, Math.max(word.start + .001, nextStart));
    return { ...word, end };
  });

  const groups = [];
  let groupWords = [];
  for (const word of words) {
    const group = groupWords.length ? cueFromWords(groupWords) : null;
    const nextText = group ? appendWord(group.text, word.text) : cleanText(word.text);
    // Avoid an unreadable 20 ms cue at the end of an otherwise continuous
    // utterance. This changes grouping only, never the word's audio timestamp.
    const collapsedInVoice = group && word.end - word.start <= .16 && word.start - group.end <= .85
      && word.continuousSpeech != null && word.continuousSpeech === groupWords.at(-1).continuousSpeech;
    if (group && word.start - group.end > MAX_SPEECH_GAP && !collapsedInVoice) {
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
