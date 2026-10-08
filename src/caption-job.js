import { hardCutCues } from './caption-timing.js';

export function fitCuesToDuration(cues, duration) {
  const fitted = hardCutCues(cues).map((cue) => ({
    ...cue,
    end: Number.isFinite(duration) && duration > 0 ? Math.min(cue.end, duration) : cue.end,
  })).filter((cue) => cue.end > cue.start);
  if (!fitted.length) throw new Error('没有位于视频时长范围内的字幕，请检查字幕时间。');
  return fitted;
}

// Capture edits at send time so later edits/switching videos cannot change the export.
export function createCaptionJob(source, cues, style, options, metadata = {}) {
  return Object.freeze({
    source,
    cues: Object.freeze(fitCuesToDuration(cues, metadata.duration).map(Object.freeze)),
    style,
    options: Object.freeze({ ...options }),
    metadata: Object.freeze({ ...metadata }),
  });
}

export function cueAtTime(cues, time) {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].start <= time) low = mid + 1; else high = mid;
  }
  const cue = cues[low - 1];
  return cue && time < cue.end ? cue : null;
}
