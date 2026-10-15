import { ASR_SAMPLE_RATE, transcriptionOptions } from './caption-audio.js';
import { cuesFromWords } from './caption-timing.js';
import { needsTimestampRefinement, refineWordTimestamps } from './caption-refinement.js';

function isNonSpeechAnnotation(text) {
  return /^\s*(?:\[|\(|【)\s*(?:music(?: playing)?|instrumental(?: music)?|silence|applause|laughter|noise|background noise|音乐|背景音乐|掌声|笑声|静音)\s*(?:\]|\)|】)\s*$/iu.test(String(text || ''));
}

export async function recognizeCaptions(transcriber, audio, onRefine = () => {}) {
  const words = await transcriber(audio, transcriptionOptions());
  let chunks = (words.chunks || []).filter((chunk) => !isNonSpeechAnnotation(chunk.text));
  let refinedCount = 0;
  let reviewNeeded = false;
  if (needsTimestampRefinement(chunks)) {
    onRefine();
    const sentences = await transcriber(audio, { ...transcriptionOptions(), return_timestamps: true });
    const refinement = refineWordTimestamps(chunks, sentences.chunks || []);
    chunks = refinement.chunks;
    refinedCount = refinement.refinedCount;
    reviewNeeded = refinement.unresolvedCount > 0;
  }
  return { cues: cuesFromWords(chunks, { duration: audio.length / ASR_SAMPLE_RATE }), refinedCount, reviewNeeded };
}
