// Opt-in regression for any folder of local speech videos. No video is uploaded.
// Start npm run dev, set CAPTION_FIXTURE_DIR and (optionally) PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { recognizeCaptions, speechChunks } from '../src/caption-recognition.js';
import { captionModelConfig } from '../src/caption-models.js';
import { createSpeechDetector } from '../src/caption-speech.js';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const directory = process.env.CAPTION_FIXTURE_DIR;
const requested = process.argv.slice(2);
if (!directory && !requested.length) throw Error('Pass local video paths or set CAPTION_FIXTURE_DIR.');
const sources = requested.length ? requested.map(path => resolve(path))
  : (await readdir(directory)).filter((name) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(name)).sort().map(name => join(directory, name));
assert.ok(sources.length, 'expected at least one speech video');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const page = await browser.newPage();
const audios = [];
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:5173');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'realAsrSource'; input.hidden = true; document.body.append(input);
  });
  for (const source of sources) {
    const name = basename(source);
    await page.locator('#realAsrSource').setInputFiles(source);
    const extracted = await page.evaluate(async () => {
      const { FFmpeg } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js');
      const { transcriptionAudioArgs, decodeTranscriptionPcm } = await import('/src/caption-audio.js');
      const ffmpeg = new FFmpeg();
      try {
        await ffmpeg.load({ coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`, wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm` });
        await ffmpeg.writeFile('source.mp4', new Uint8Array(await document.querySelector('#realAsrSource').files[0].arrayBuffer()));
        assertCode(await ffmpeg.exec(transcriptionAudioArgs('source.mp4', 'audio.f32')));
        const audio = decodeTranscriptionPcm(await ffmpeg.readFile('audio.f32'));
        // Initialise the same browser runtime configuration as the actual ASR
        // pipeline, then exercise the real detector (not a deterministic stub).
        await import('/node_modules/@huggingface/transformers/dist/transformers.web.js');
        const { detectSpeechRegions } = await import('/src/caption-speech.js');
        const start = performance.now();
        const speechRegions = await detectSpeechRegions(audio);
        return { samples: Array.from(audio), speechRegions, vadMs: Math.round(performance.now() - start) };
      } finally { ffmpeg.terminate(); }
      function assertCode(code) { if (code !== 0) throw Error(`Audio extraction failed: ${code}`); }
    });
    audios.push({ name, audio: new Float32Array(extracted.samples), speechRegions: extracted.speechRegions, vadMs: extracted.vadMs });
    console.log(JSON.stringify({ name, browserVadMs: extracted.vadMs, speechRegions: extracted.speechRegions.length }));
  }
} finally { await browser.close(); }

env.cacheDir = process.env.ASR_MODEL_CACHE || 'output/asr-model-cache';
const report = [];
const vadSession = await InferenceSession.create('src/assets/silero-vad.onnx', { intraOpNumThreads: 1, interOpNumThreads: 1 });
const detect = createSpeechDetector(vadSession, Tensor);
for (const entry of audios) {
  const nodeRegions = await detect(entry.audio);
  assert.equal(nodeRegions.length, entry.speechRegions.length, `${entry.name}: browser and native detector agree`);
  for (const [i, region] of nodeRegions.entries()) {
    assert.ok(Math.abs(region.start - entry.speechRegions[i].start) < .065);
    assert.ok(Math.abs(region.end - entry.speechRegions[i].end) < .065);
  }
}
await vadSession.release();
for (const model of (process.env.ASR_TEST_MODELS || 'tiny,base').split(',')) {
  const config = captionModelConfig(model, process.env.ASR_TEST_LANGUAGE || 'en');
  const transcriber = await pipeline('automatic-speech-recognition', config.model, { dtype: 'q8' });
  try {
    for (const { name, audio, speechRegions, vadMs } of audios) {
      const start = performance.now();
      const calls = [];
      let primary;
      const result = await recognizeCaptions(async (samples, options) => {
        calls.push({ seconds: samples.length / 16000, timestamps: options.return_timestamps });
        const output = await transcriber(samples, options);
        if (calls.length === 1) primary = output;
        return output;
      }, audio, () => {}, { speechRegions, ...config });
      assert.ok(result.cues.length, `${name}: nonempty transcript`);
      const text = result.cues.map((cue) => cue.text).join(' ');
      const words = value => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const originalText = speechChunks(primary.chunks).map(chunk => chunk.text).join(' ');
      assert.deepEqual(words(text), words(originalText), `${name}: timing repair preserves the primary transcript`);
      assert.doesNotMatch(text, /\[music/i);
      assert.ok(result.cues.every((cue, i) => cue.start >= 0 && cue.end > cue.start && cue.end <= audio.length / 16000 && (!i || cue.start >= result.cues[i - 1].end)));
      assert.ok(calls.length <= 4 && calls.slice(1).every(call => call.seconds <= 20), 'bounded local inference');
      assert.ok(result.reviewNeeded || result.cues.every(cue => speechRegions.some(region => region.start < cue.end && region.end > cue.start)), 'unsupported speech intervals require review');
      report.push({ name, model: config.model, language: config.language, browserVadMs: vadMs, elapsedMs: Math.round(performance.now() - start), calls, speechRegions, primary: primary.chunks, ...result });
      console.log(JSON.stringify({ name, model, elapsedMs: report.at(-1).elapsedMs, calls: calls.length,
        cues: result.cues.length, refinedCount: result.refinedCount, reviewNeeded: result.reviewNeeded }));
    }
  } finally { await transcriber.dispose(); }
}
await mkdir('output', { recursive: true });
await writeFile(process.env.ASR_REPORT_PATH || 'output/caption-real-asr-report.json', JSON.stringify(report, null, 2));
