// Keep words and punctuation together, then choose the most readable break.
export function wrapCaptionLines(text, maxWidth, measure) {
  const chunks = String(text || '').trim().match(/[A-Za-z0-9]+(?:['’._-][A-Za-z0-9]+)*\s*|./gu) || [];
  if (!chunks.length) return [];
  const full = chunks.join('').trim();
  if (measure(full) <= maxWidth) return [full];

  const best = Array(chunks.length + 1).fill(null);
  best[chunks.length] = { cost: 0, lines: [] };
  for (let start = chunks.length - 1; start >= 0; start -= 1) {
    let raw = '';
    for (let end = start + 1; end <= chunks.length; end += 1) {
      raw += chunks[end - 1];
      const line = raw.trim();
      if (!line) continue;
      const width = measure(line);
      if (width > maxWidth && end > start + 1) break;
      const tail = best[end];
      if (!tail) continue;
      const next = chunks[end]?.trimStart() || '';
      const badBreak = end < chunks.length && (/^[，。！？、；：,.!?;:）】」』]/u.test(next)
        || /^(?:a|an|the|to|of|in|on|at|for|with|and|or|but)$/iu.test(line.split(/\s+/u).at(-1)));
      const punctuationBonus = /[,，;；:：]$/u.test(line) ? -0.16 : 0;
      const cost = tail.cost + 1 + (width / maxWidth - 0.72) ** 2 * 0.25
        + (badBreak ? 3 : 0) + punctuationBonus;
      const candidate = { cost, lines: [line, ...tail.lines] };
      if (!best[start] || candidate.cost < best[start].cost) best[start] = candidate;
    }
  }
  return best[0]?.lines || [full];
}
