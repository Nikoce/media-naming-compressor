import test from 'node:test';
import assert from 'node:assert/strict';
import { captionModelConfig, CAPTION_LANGUAGES } from './caption-models.js';

test('English fast mode uses the same-sized English specialist and explains its limitations', () => {
  const config = captionModelConfig();
  assert.equal(config.model, 'Xenova/whisper-tiny.en');
  assert.equal(config.englishOnly, true);
  assert.match(config.description, /Tiny.en.*英文专用.*速度快.*错词/);
});

test('every non-English selection uses a multilingual decoder and its explicit language', () => {
  for (const [language] of CAPTION_LANGUAGES.filter(([code]) => code !== 'en')) {
    const config = captionModelConfig('tiny', language);
    assert.equal(config.model, 'Xenova/whisper-tiny');
    assert.equal(config.language, language);
    assert.equal(config.englishOnly, false);
    assert.equal(captionModelConfig('base', language).model, 'Xenova/whisper-base');
  }
  assert.equal(captionModelConfig('unknown', 'invalid').language, 'en');
});
