export const CAPTION_LANGUAGES = [
  ['en', '英语'], ['zh', '中文'], ['ja', '日语'], ['ko', '韩语'],
  ['es', '西班牙语'], ['fr', '法语'], ['de', '德语'], ['pt', '葡萄牙语'],
];

export function captionModelConfig(mode = 'tiny', language = 'en') {
  const selected = CAPTION_LANGUAGES.find(([code]) => code === language) || CAPTION_LANGUAGES[0];
  const englishOnly = mode !== 'base' && selected[0] === 'en';
  const model = mode === 'base' ? 'Xenova/whisper-base' : englishOnly ? 'Xenova/whisper-tiny.en' : 'Xenova/whisper-tiny';
  const description = mode === 'base'
    ? `Base 多语言模型：按${selected[1]}转写，通常能减少错词漏词；识别较慢、占用内存更多，噪声、口音及多人重叠语音仍需校对。`
    : `${englishOnly ? 'Tiny.en 英文专用' : 'Tiny 多语言'}轻量模型：按${selected[1]}转写，速度快，适合清晰人声和批量素材；强噪声、重口音或多人同时说话时可能错词、漏词。`;
  return { model, language: selected[0], englishOnly, description };
}
