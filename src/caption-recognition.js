import { ASR_SAMPLE_RATE, transcriptionOptions } from './caption-audio.js';
import { cuesFromWords } from './caption-timing.js';
import { MAX_REFINEMENT_SECONDS, mergeInstantaneousWords, planRefinementWindows, refineWordTimestamps, refineWithSpeech, refineLocalWords, timestampIssues } from './caption-refinement.js';

function isNonSpeechAnnotation(text) {
  return /^\s*(?:\[[^\]]*\]|【[^】]*】)\s*$/u.test(String(text || ''))
    || /^\s*\(\s*(?:music(?: playing)?|instrumental(?: music)?|silence|blank[_ ]audio|applause|laughter|laughs?|laughing|noise|background noise|音乐|背景音乐|掌声|笑声|静音)\s*\)\s*$/iu.test(String(text || ''));
}

export function speechChunks(chunks) {
  // Inspect the combined annotation spans, then remove only those characters
  // from their original chunks so inline dialogue and its timing survive.
  const text = chunks.map(chunk => String(chunk.text || '')).join(' ');
  const ranges = [...text.matchAll(/\[[^\]]*\]|【[^】]*】|\([^)]*\)/gu)]
    .filter(match => isNonSpeechAnnotation(match[0])).map(match => [match.index, match.index + match[0].length]);
  let offset = 0;
  return chunks.flatMap(chunk => {
    const original = String(chunk.text || '');
    let cleaned = original;
    const removed = ranges.filter(([start, end]) => start < offset + original.length && end > offset);
    for (const [start, end] of removed.reverse()) {
      cleaned = cleaned.slice(0, Math.max(0, start - offset)) + cleaned.slice(Math.min(original.length, end - offset));
    }
    offset += original.length + 1;
    cleaned = cleaned.replace(/[♪♫]/gu, '');
    if (!cleaned.trim() || removed.length && /^[\s.,;:!?，。！？；：]*$/u.test(cleaned)) return [];
    return [{ ...chunk, text: cleaned }];
  });
}

export async function recognizeCaptions(transcriber, audio, onRefine = () => {}, { speechRegions = null, language = 'en', englishOnly = false } = {}) {
  const options = transcriptionOptions({ language, englishOnly });
  const words = await transcriber(audio, options);
  const duration = audio.length / ASR_SAMPLE_RATE;
  let chunks = mergeInstantaneousWords(speechChunks(words.chunks || []), duration);
  const speechRefinement = refineWithSpeech(chunks, speechRegions);
  chunks = speechRefinement.chunks;
  const windows = planRefinementWindows(chunks, duration);
  const segments = [];
  const localWords = [];
  for (const [index, window] of windows.entries()) {
    onRefine(index + 1, windows.length);
    const startSample = Math.floor(window.start * ASR_SAMPLE_RATE);
    const endSample = Math.min(audio.length, startSample + MAX_REFINEMENT_SECONDS * ASR_SAMPLE_RATE, Math.ceil(window.end * ASR_SAMPLE_RATE));
    const offset = startSample / ASR_SAMPLE_RATE;
    try {
      const sentences = await transcriber(audio.subarray(startSample, endSample), { ...options, return_timestamps: window.wordTimestamps ? 'word' : true });
      const absolute = [];
      for (const segment of sentences.chunks || []) {
        const [start, end] = segment.timestamp || [];
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
          || start >= (endSample - startSample) / ASR_SAMPLE_RATE) continue;
        absolute.push({ ...segment, timestamp: [start + offset, Math.min(end + offset, endSample / ASR_SAMPLE_RATE)], indices: window.indices });
      }
      if (window.wordTimestamps) localWords.push({ indices: window.indices, chunks: mergeInstantaneousWords(speechChunks(absolute), duration) });
      else segments.push(...absolute);
    } catch {
      // One failed optional repair must not discard a usable transcript or fail
      // the rest of the batch. The unresolved interval is marked for review.
    }
  }
  const localRefinement = refineLocalWords(chunks, localWords, duration);
  const refinement = refineWordTimestamps(localRefinement.chunks, segments, duration);
  const finalSpeech = refineWithSpeech(refinement.chunks, speechRegions);
  return { cues: cuesFromWords(finalSpeech.chunks, { duration }),
    refinedCount: speechRefinement.refinedCount + localRefinement.refinedCount + refinement.refinedCount + finalSpeech.refinedCount,
    reviewNeeded: timestampIssues(finalSpeech.chunks, duration).length > 0
      || (speechRegions?.length === 0 && chunks.length > 0) };
}
