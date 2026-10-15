import test from 'node:test';
import assert from 'node:assert/strict';
import { ASR_SAMPLE_RATE, decodeTranscriptionPcm, transcriptionOptions } from './caption-audio.js';

test('PCM decoding preserves samples, duration and a sliced FFmpeg buffer', () => {
  const bytes = new Uint8Array(8 + ASR_SAMPLE_RATE * 4);
  const view = new DataView(bytes.buffer);
  [0, 0.25, -0.5, 1].forEach((sample, index) => view.setFloat32(4 + index * 4, sample, true));
  const audio = decodeTranscriptionPcm(bytes.subarray(4, bytes.length - 4));
  assert.deepEqual([...audio.slice(0, 4)], [0, 0.25, -0.5, 1]);
  assert.equal(audio.length / ASR_SAMPLE_RATE, 1);
  assert.throws(() => decodeTranscriptionPcm(new Uint8Array()), /为空/);
  assert.throws(() => decodeTranscriptionPcm(new Uint8Array(3)), /不完整/);
});

test('each video gets independent transcription settings and overlap context', () => {
  const first = transcriptionOptions();
  first.language = 'english';
  assert.equal(transcriptionOptions().language, 'en');
  assert.equal(transcriptionOptions().task, 'transcribe');
  assert.ok(transcriptionOptions().stride_length_s >= 5);
});

test('English-only and multilingual decoders receive compatible language settings', () => {
  const english = transcriptionOptions({ englishOnly: true, language: 'en' });
  assert.equal('task' in english, false);
  assert.equal('language' in english, false);
  assert.equal(transcriptionOptions({ language: 'zh' }).language, 'zh');
  assert.equal(transcriptionOptions({ language: 'fr' }).task, 'transcribe');
});
