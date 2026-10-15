// Opt-in regression for the two user-provided CatBand clips. No video is uploaded.
// Start npm run dev, set CAPTION_FIXTURE_DIR and (optionally) PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { recognizeCaptions } from '../src/caption-recognition.js';

const directory = process.env.CAPTION_FIXTURE_DIR;
if (!directory) throw Error('Set CAPTION_FIXTURE_DIR to the folder containing the two CatBand test videos.');
const sources = (await readdir(directory)).filter((name) => /_H-CatBand-0[12]_.*\.mp4$/i.test(name)).sort();
assert.equal(sources.length, 2, 'expected the two CatBand 01/02 regression clips');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const page = await browser.newPage();
const audios = [];
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:5173');
  for (const name of sources) {
    const bytes = await readFile(join(directory, name));
    const samples = await page.evaluate(async (bytes) => {
      const { FFmpeg } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js');
      const { transcriptionAudioArgs, decodeTranscriptionPcm } = await import('/src/caption-audio.js');
      const ffmpeg = new FFmpeg();
      try {
        await ffmpeg.load({ coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`, wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm` });
        await ffmpeg.writeFile('source.mp4', new Uint8Array(bytes));
        assertCode(await ffmpeg.exec(transcriptionAudioArgs('source.mp4', 'audio.f32')));
        return Array.from(decodeTranscriptionPcm(await ffmpeg.readFile('audio.f32')));
      } finally { ffmpeg.terminate(); }
      function assertCode(code) { if (code !== 0) throw Error(`Audio extraction failed: ${code}`); }
    }, Array.from(bytes));
    audios.push({ name, audio: new Float32Array(samples) });
  }
} finally { await browser.close(); }

env.cacheDir = process.env.ASR_MODEL_CACHE || 'output/asr-model-cache';
const report = [];
for (const model of ['base', 'tiny']) {
  const transcriber = await pipeline('automatic-speech-recognition', `Xenova/whisper-${model}`, { dtype: 'q8' });
  try {
    for (const { name, audio } of audios) {
      const start = performance.now();
      const result = await recognizeCaptions(transcriber, audio);
      // Both clips begin with music; spoken dialogue begins after 3 seconds.
      assert.ok(result.cues[0].start >= 3 && result.cues[0].start < 4.2, `${name}: first spoken cue follows the intro`);
      const text = result.cues.map((cue) => cue.text).join(' ');
      for (const phrase of [/Guys/i, /seriously/i, /Go away/i, /I just wanted/i, /five minutes/i, /of peace/i]) assert.match(text, phrase);
      assert.doesNotMatch(text, /\[music/i);
      assert.equal(result.reviewNeeded, false);
      if (model === 'base') assert.equal(result.refinedCount, 1);
      assert.ok(result.cues.every((cue, i) => cue.end <= audio.length / 16000 && (!i || cue.start >= result.cues[i - 1].end)));
      report.push({ name, model, elapsedMs: Math.round(performance.now() - start), ...result });
      console.log(JSON.stringify(report.at(-1)));
    }
  } finally { await transcriber.dispose(); }
}
await mkdir('output', { recursive: true });
await writeFile('output/caption-real-asr-report.json', JSON.stringify(report, null, 2));
