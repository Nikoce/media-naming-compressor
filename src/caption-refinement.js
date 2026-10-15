import { appendCaptionText } from './caption-text.js';

export const MAX_REFINEMENT_SECONDS = 20;
export const MAX_REFINEMENT_WINDOWS = 3;
const CONTEXT_SECONDS = 2;

function tokens(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/’/gu, "'")
    .replace(/\[[^\]]*\]|【[^】]*】/gu, '')
    .match(/\p{Script=Han}|[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
}

export function timestampIssues(chunks, duration = Infinity) {
  let previousStart = -Infinity;
  return chunks.flatMap((chunk, index) => {
    const [start, end] = chunk.timestamp || [];
    const count = tokens(chunk.text).length;
    if (!count || (Number.isFinite(start) && start >= duration)) return [];
    const missing = !Number.isFinite(start) || !Number.isFinite(end);
    const backward = Number.isFinite(start) && start < previousStart - 0.04;
    const invalid = !missing && (start < 0 || end <= start);
    const inflated = !chunk.timingVerified && !missing && end - start > Math.max(1.4, count * 0.8);
    if (Number.isFinite(start)) previousStart = Math.max(previousStart, start);
    return missing || backward || invalid || inflated || chunk.timingSuspect ? [{ index, start, end, backward, invalid, missing }] : [];
  });
}

export function needsTimestampRefinement(chunks, duration) {
  return timestampIssues(chunks, duration).length > 0;
}

function neighbourTime(chunks, index, step, edge) {
  for (let i = index + step; i >= 0 && i < chunks.length; i += step) {
    const time = chunks[i].timestamp?.[edge];
    if (Number.isFinite(time) && time >= 0) return time;
  }
  return null;
}

export function mergeInstantaneousWords(chunks, duration = Infinity) {
  const result = chunks.map(chunk => ({ ...chunk, timestamp: chunk.timestamp?.slice() }));
  for (let index = result.length - 1; index >= 0; index--) {
    const chunk = result[index];
    const [start, end] = chunk.timestamp || [];
    if (!Number.isFinite(start) || start < 0 || start >= duration || end !== start) continue;
    const next = result[index + 1];
    const [nextStart, nextEnd] = next?.timestamp || [];
    // Tied tokens are a normal by-product of the decoder's finite time grid.
    // Keep their text with a timed neighbour; isolated zero spans still need ASR.
    if (Number.isFinite(nextStart) && nextStart >= 0 && nextStart < duration && Number.isFinite(nextEnd) && nextEnd > nextStart
      && Math.abs(nextStart - start) <= .04) {
      next.text = appendCaptionText(chunk.text.trim(), next.text);
      next.timingCompound = true;
      result.splice(index, 1);
      continue;
    }
    const previous = result[index - 1];
    if (previous && previous.timestamp?.[0] >= 0 && previous.timestamp[0] < duration
      && Number.isFinite(previous.timestamp?.[1]) && previous.timestamp[1] > previous.timestamp[0]
      && Math.abs(previous.timestamp[1] - start) <= .04) {
      previous.text = appendCaptionText(previous.text.trim(), chunk.text);
      previous.timingCompound = true;
      result.splice(index, 1);
    }
  }
  return result;
}

export function refineWithSpeech(chunks, speechRegions) {
  if (!speechRegions?.length) return { chunks, refinedCount: 0 };
  const invalid = new Set(timestampIssues(chunks).filter((issue) => issue.missing || issue.backward || issue.invalid).map((issue) => issue.index));
  let refinedCount = 0;
  const refined = chunks.map((chunk, index) => {
    const [start, end] = chunk.timestamp || [];
    if (invalid.has(index) || !tokens(chunk.text).length || !Number.isFinite(start) || !Number.isFinite(end)) return chunk;
    const overlaps = speechRegions.filter((region) => region.end > start && region.start < end);
    // Silence suppression follows word position: keep the end of a phrase's
    // first word, the start of its last word. Never stretch a word to a remote
    // speech event. Ambiguous intervals remain available for local ASR/review.
    if (!overlaps.length) return { ...chunk, timingSuspect: true };
    const nextStart = chunks[index + 1]?.timestamp?.[0];
    const previousEnd = chunks[index - 1]?.timestamp?.[1];
    const first = index === 0 || start - previousEnd > 0.5 || /[.!?。！？]$/u.test(chunks[index - 1]?.text?.trim() || '');
    const last = index === chunks.length - 1 || nextStart - end > 0.5 || /[.!?。！？]$/u.test(chunk.text.trim());
    const atEnd = overlaps.findLast((entry) => end >= entry.start && end <= entry.end);
    const atStart = overlaps.find((entry) => start >= entry.start && start <= entry.end);
    const inflated = end - start > Math.max(1.4, tokens(chunk.text).length * .8);
    let region = null;
    if (overlaps.length === 1) region = overlaps[0];
    else if (chunk.timingCompound && !inflated) region = { start: overlaps[0].start, end: overlaps.at(-1).end };
    else if (!chunk.timingCompound && inflated) region = last && !first ? atStart : first ? atEnd : null;
    if (!region) return { ...chunk, timingSuspect: true };
    let newStart = Math.max(start, region.start);
    const newEnd = Math.min(end, region.end);
    // A quantized short word can be collapsed onto the end of its utterance.
    // Recover only an utterance onset independently supported by VAD. A gap
    // between words inside continuous speech is not enough evidence to retime.
    if (end - start <= .16 && tokens(chunk.text).length === 1
      && (!Number.isFinite(previousEnd) || previousEnd <= region.start)) {
      const lower = region.start;
      if (newStart - lower > .25 && newStart - lower <= 1.2) newStart = lower;
    }
    if (newEnd - newStart < Math.min(.02, end - start) - 1e-6) return { ...chunk, timingSuspect: true };
    if (Math.abs(newStart - start) > 0.04 || end - newEnd > 0.04) refinedCount += 1;
    return { ...chunk, timestamp: [newStart, newEnd], timingVerified: true, timingSuspect: false,
      continuousSpeech: overlaps.length === 1 ? region.start : null };
  });
  return { chunks: refined, refinedCount };
}

export function planRefinementWindows(chunks, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const windows = timestampIssues(chunks, duration).flatMap((issue) => {
    const previous = neighbourTime(chunks, issue.index, -1, 1);
    const next = neighbourTime(chunks, issue.index, 1, 0);
    const times = [issue.start, issue.end].filter((time) => Number.isFinite(time) && time >= 0 && time <= duration);
    if (issue.backward || issue.missing || issue.invalid) {
      if (previous !== null && previous <= duration) times.push(previous);
      if (next !== null && next <= duration) times.push(next);
    }
    if (!times.length) return [];
    const high = Math.max(...times);
    const low = Math.min(...times);
    const start = Math.max(0, low - CONTEXT_SECONDS, high + CONTEXT_SECONDS - MAX_REFINEMENT_SECONDS);
    const end = Math.min(duration, start + MAX_REFINEMENT_SECONDS, high + CONTEXT_SECONDS);
    return end > start ? [{ start, end, indices: [issue.index], wordTimestamps: Boolean(issue.missing || issue.backward || issue.invalid || chunks[issue.index].timingSuspect) }] : [];
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end && window.end - previous.start <= MAX_REFINEMENT_SECONDS) {
      previous.end = Math.max(previous.end, window.end);
      previous.indices.push(...window.indices);
      previous.wordTimestamps ||= window.wordTimestamps;
    } else merged.push({ ...window, indices: [...window.indices] });
  }
  return merged.slice(0, MAX_REFINEMENT_WINDOWS);
}

// Local word alignment can repair a word in the middle of a sentence too.
// Match adjacent text on both sides rather than accepting an isolated repeated
// word. This is transcript matching, not phoneme-level forced alignment.
export function refineLocalWords(chunks, windows, duration) {
  const source = chunks.flatMap((chunk, index) => tokens(chunk.text).map(text => ({ text, index })));
  let refinedCount = 0;
  const refined = chunks.map((chunk, index) => {
    const positions = source.flatMap((entry, position) => entry.index === index ? [position] : []);
    if (!positions.length) return chunk;
    const begin = positions[0];
    const size = positions.length;
    const candidates = [];
    for (const window of windows.filter(window => window.indices.includes(index))) {
      const local = window.chunks.flatMap(word => tokens(word.text).map(text => ({ text, word })));
      for (let at = 0; at + size <= local.length; at++) {
        if (!source.slice(begin, begin + size).every((entry, j) => entry.text === local[at + j].text)) continue;
        let before = 0;
        let after = 0;
        while (before < 3 && begin - before > 0 && at - before > 0
          && source[begin - before - 1].text === local[at - before - 1].text) before++;
        while (after < 3 && begin + size + after < source.length && at + size + after < local.length
          && source[begin + size + after].text === local[at + size + after].text) after++;
        const start = local[at].word.timestamp?.[0];
        const end = local[at + size - 1].word.timestamp?.[1];
        const available = Math.min(2, source.length - size);
        if (before + after < available || !Number.isFinite(start) || !Number.isFinite(end)
          || start < 0 || end <= start || end > duration) continue;
        candidates.push({ start, end, score: before + after });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || candidates.some(entry => entry !== best && entry.score === best.score && Math.abs(entry.start - best.start) > .1)) return chunk;
    const previous = neighbourTime(chunks, index, -1, 1);
    const next = neighbourTime(chunks, index, 1, 0);
    const start = Math.max(best.start, previous !== null && previous < best.end ? previous : 0);
    const end = Math.min(best.end, next !== null && next > start ? next : duration);
    if (end <= start) return chunk;
    refinedCount++;
    return { ...chunk, timestamp: [start, end], timingVerified: true, timingSuspect: false };
  });
  return { chunks: refined, refinedCount };
}

// Use independent sentence boundaries only when the leading words and their
// context agree. Recognition text and unaffected timestamps remain unchanged.
export function refineWordTimestamps(chunks, segments, duration = Infinity) {
  const issues = new Map(timestampIssues(chunks, duration).map((issue) => [issue.index, issue]));
  let refinedCount = 0;
  let unresolvedCount = 0;
  const refined = chunks.map((chunk, index) => {
    const issue = issues.get(index);
    const original = { ...chunk, timestamp: chunk.timestamp?.slice() };
    if (!issue) return original;
    const { start, end } = issue;
    const wordTokens = tokens(chunk.text);
    const following = chunks.slice(index, index + 6).flatMap((word) => tokens(word.text));
    const previousEnd = neighbourTime(chunks, index, -1, 1);
    const nextStart = neighbourTime(chunks, index, 1, 0);
    const candidates = segments.flatMap((segment) => {
      if (segment.indices && !segment.indices.includes(index)) return [];
      const [segmentStart, segmentEnd] = segment.timestamp || [];
      const sentence = tokens(segment.text);
      if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)
        || segmentStart < 0 || segmentEnd <= segmentStart || segmentStart >= duration
        || !wordTokens.every((token, i) => token === sentence[i])) return [];
      if (!issue.backward && !issue.invalid && !issue.missing
        && (segmentStart >= end - 0.02 || segmentEnd <= start)) return [];
      let matches = 0;
      while (matches < following.length && following[matches] === sentence[matches]) matches += 1;
      return [{ start: segmentStart, end: segmentEnd, matches, tokens: sentence.length }];
    }).sort((a, b) => b.matches - a.matches || b.start - a.start);
    const best = candidates[0];
    const requiredMatches = Math.min(following.length, wordTokens.length + 1);
    const ambiguous = candidates.some((candidate) => candidate !== best && candidate.matches === best?.matches
      && Math.abs(candidate.start - best.start) > 0.1);
    const anchor = best?.matches >= requiredMatches && !ambiguous ? best : null;
    if (anchor) {
      const trustworthyEnd = Number.isFinite(end) && end > anchor.start && !issue.backward && !issue.invalid;
      const lower = previousEnd !== null && previousEnd < anchor.end ? previousEnd : 0;
      const newStart = Math.max(anchor.start, issue.backward || issue.invalid || !Number.isFinite(start) ? lower : start);
      const upper = nextStart !== null && nextStart > newStart ? nextStart : duration;
      const newEnd = Math.min(trustworthyEnd ? end : anchor.end, anchor.end, upper, duration);
      const changed = !Number.isFinite(start) || !Number.isFinite(end)
        || Math.abs(newStart - start) > 0.04 || Math.abs(end - newEnd) > 0.04;
      const hasWordEnd = trustworthyEnd || anchor.tokens === wordTokens.length || upper < anchor.end;
      if (hasWordEnd && newEnd > newStart && (changed || anchor.tokens === wordTokens.length)) {
        if (changed) refinedCount += 1;
        return { ...chunk, timestamp: [newStart, newEnd], timingVerified: true, timingSuspect: false };
      }
    }
    unresolvedCount += 1;
    return original;
  });
  return { chunks: refined, refinedCount, unresolvedCount };
}
