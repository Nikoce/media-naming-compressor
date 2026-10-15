function tokens(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/\[[^\]]*\]|【[^】]*】/gu, '')
    .match(/\p{Script=Han}|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function isInflatedWord(chunk) {
  const [start, end] = chunk.timestamp || [];
  return Number.isFinite(start) && Number.isFinite(end) && end - start > 1.4
    && tokens(chunk.text).length > 0 && [...String(chunk.text).trim()].length <= 16;
}

export function needsTimestampRefinement(chunks) {
  return chunks.some(isInflatedWord);
}

// Word attention can assign the first spoken word to the beginning of a music
// intro. Sentence timestamp tokens provide an independent boundary. Only use a
// boundary when the sentence's leading words match the transcript in order.
export function refineWordTimestamps(chunks, segments) {
  let refinedCount = 0;
  let unresolvedCount = 0;
  const refined = chunks.map((chunk, index) => {
    if (!isInflatedWord(chunk)) return { ...chunk, timestamp: chunk.timestamp?.slice() };
    const [start, end] = chunk.timestamp;
    const wordTokens = tokens(chunk.text);
    const following = chunks.slice(index, index + 6).flatMap((word) => tokens(word.text));
    const candidates = segments.flatMap((segment) => {
      const [segmentStart, segmentEnd] = segment.timestamp || [];
      const sentence = tokens(segment.text);
      if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)
        || segmentStart >= end - 0.02 || segmentEnd <= start
        || !wordTokens.every((token, i) => token === sentence[i])) return [];
      let matches = 0;
      while (matches < following.length && following[matches] === sentence[matches]) matches += 1;
      return [{ start: segmentStart, end: segmentEnd, matches }];
    }).sort((a, b) => b.matches - a.matches || b.start - a.start);
    const anchor = candidates[0];
    if (anchor) {
      const nextStart = Math.max(start, anchor.start);
      const nextEnd = Math.min(end, anchor.end);
      if (nextEnd > nextStart && (nextStart - start > 0.1 || end - nextEnd > 0.1)) {
        refinedCount += 1;
        return { ...chunk, timestamp: [nextStart, nextEnd] };
      }
    }
    unresolvedCount += 1;
    return { ...chunk, timestamp: chunk.timestamp.slice() };
  });
  return { chunks: refined, refinedCount, unresolvedCount };
}
