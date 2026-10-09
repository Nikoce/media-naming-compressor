export function durationPart(duration) {
  if (duration === '' || duration == null) return 'VL-S-时长';
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds < 0) return 'VL-S-时长';
  const category = seconds <= 10 ? 'S' : seconds <= 20 ? 'M' : 'L';
  return `VL-${category}-${duration}`;
}
