export function normalizeTheme(value) {
  return String(value ?? '')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .map((word) => word.replace(/^\p{L}/u, (letter) => letter.toUpperCase()))
    .join('');
}

export function durationPart(duration) {
  if (duration === '' || duration == null) return 'VL-S-时长';
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds < 0) return 'VL-S-时长';
  const category = seconds <= 10 ? 'S' : seconds <= 20 ? 'M' : 'L';
  return `VL-${category}-${duration}`;
}

// Only recognize the complete naming format, so ordinary titles remain untouched.
export function parseMediaName(fileName) {
  const base = String(fileName ?? '').trim().replace(/\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg)$/i, '');
  const match = base.match(/^(\d{6})_P-(.+?)_H-(.+?)_VL-(?:[SML]-)?(\d+(?:\.\d+)?)_S-(\d+)_L-([a-z]{2,3}(?:-[a-z0-9]+)*)_D-(.+?)_M-(.+)$/i);
  if (!match) return null;
  const [, date, product, rawTheme, duration, ratio, language, maker, productionTime] = match;
  const year = 2000 + Number(date.slice(0, 2));
  const month = Number(date.slice(2, 4));
  const day = Number(date.slice(4, 6));
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day) return null;
  const theme = normalizeTheme(rawTheme.replace(/-\d{2,}$/, ''));
  if (!theme) return null;
  return { date, product, theme, duration, ratio, language: language.toLowerCase(), maker, productionTime };
}

export function resolveNamingValues(namedValues, defaults, overrides = new Set()) {
  return Object.fromEntries(['date', 'product', 'theme', 'language', 'maker', 'productionTime']
    .map((key) => [key, namedValues && !overrides.has(key) ? namedValues[key] : defaults[key]]));
}
