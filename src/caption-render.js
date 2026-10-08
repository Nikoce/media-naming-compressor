import { wrapCaptionLines } from './caption-lines.js';
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

export function captionFontSize(width, height, options) {
  return Math.max(12, Math.round(Math.max(20, Math.min(width * 0.052, height * 0.064)) * options.fontSize / 100));
}

export function captionBandHeight(width, height, options) {
  return Math.min(height, Math.max(44, Math.round(height * 0.22 * options.fontSize / 100), Math.round(captionFontSize(width, height, options) * 3.5)));
}

export function captionY(height, bandHeight, positionY) {
  return clamp(Math.round(height * positionY / 100 - bandHeight / 2), 0, height - bandHeight);
}

function hexRgba(hex, opacity) {
  const values = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${values.join(',')},${opacity / 100})`;
}

export function drawCaption(context, cue, width, height, bandHeight, style, options) {
  let fontSize = captionFontSize(width, height, options);
  const families = { sans: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif', serif: 'Georgia, "Songti SC", "SimSun", serif', mono: 'Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace' };
  context.textAlign = options.textAlign || 'center';
  context.textBaseline = 'middle';
  const centerX = width * options.positionX / 100;
  const maxWidth = Math.max(width * 0.16, Math.min(width * 0.88, 2 * Math.min(centerX, width - centerX) - width * 0.04));
  const textX = centerX + (context.textAlign === 'left' ? -maxWidth / 2 : context.textAlign === 'right' ? maxWidth / 2 : 0);
  let visibleLines;
  do {
    context.font = `${options.bold ? 800 : 400} ${fontSize}px ${families[options.fontFamily] || families.sans}`;
    visibleLines = wrapCaptionLines(cue.text, maxWidth, (text) => context.measureText(text).width);
    if (visibleLines.length <= 3 || fontSize <= 12) break;
    fontSize = Math.max(12, Math.floor(fontSize * 0.9));
  } while (true);
  const lineHeight = Math.min(fontSize * 1.22, (bandHeight - 8) / Math.max(1, visibleLines.length));
  const top = Math.max(fontSize / 2 + 4, (bandHeight - visibleLines.length * lineHeight) / 2 + lineHeight / 2);
  if (style === 'boxed') {
    context.fillStyle = hexRgba(options.boxColor, options.boxOpacity);
    const textWidth = Math.min(maxWidth, Math.max(...visibleLines.map((text) => context.measureText(text).width), 0));
    const boxWidth = Math.min(width, textWidth + fontSize * 0.8);
    context.fillRect(clamp(centerX - boxWidth / 2, 0, width - boxWidth), Math.max(0, top - lineHeight * 0.65), boxWidth, Math.min(bandHeight, visibleLines.length * lineHeight + 14));
  }
  visibleLines.forEach((text, index) => {
    const y = top + index * lineHeight;
    context.lineWidth = fontSize * options.outline / 100;
    context.strokeStyle = options.outlineColor;
    context.lineJoin = 'round';
    if (options.outline > 0) context.strokeText(text, textX, y, maxWidth);
    context.fillStyle = options.textColor;
    context.fillText(text, textX, y, maxWidth);
  });
}

