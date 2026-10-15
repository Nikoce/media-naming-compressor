// Real FFmpeg audio extraction + deterministic ASR stub: no model download needed.
// Run against npm run dev; PLAYWRIGHT_MODULE/TEST_BROWSER_CHANNEL are optional.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { RELEASE } from '../src/release-notes.js';
import { SEEN_RELEASE_KEY } from '../src/app-updates.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(({ key, version }) => localStorage.setItem(key, version), { key: SEEN_RELEASE_KEY, version: RELEASE.version });
const errors = [];
// This test isolates transport/UI from acoustic-model accuracy. The opt-in
// real-ASR regression separately runs the actual browser VAD and ASR models.
await page.route('**/src/caption-speech.js', route => route.fulfill({ contentType: 'text/javascript', body: `
  export async function detectSpeechRegions(audio) { return [{ start: 0, end: audio.length / 16000 }]; }
` }));
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', async (dialog) => { errors.push(dialog.message()); await dialog.dismiss(); });
await page.route(/(?:@huggingface_transformers|transformers\.web).*\.js/, (route) => route.fulfill({
  contentType: 'text/javascript', body: `
    export async function pipeline(task, model) {
      (window.modelLoads ||= []).push(model);
      const transcribe = async (audio, options) => {
        const onset = audio.findIndex(value => Math.abs(value) > 0.01) / 16000;
        const calls = window.recognitionCalls ||= [];
        calls.push({ model, onset, duration: audio.length / 16000, options });
        return { chunks: [
          { text: '[MUSIC', timestamp: [0, onset / 2] },
          { text: 'PLAYING]', timestamp: [onset / 2, onset] },
          { text: 'Video' + calls.length, timestamp: [onset, onset + 0.2] },
          { text: ' caption.', timestamp: [onset, onset + 0.5] },
          { text: 'More words.', timestamp: [onset + 0.5, onset + 0.7] },
          { text: 'Outside.', timestamp: [audio.length / 16000 + 1, null] },
        ] };
      };
      transcribe.dispose = async () => { window.disposedModels = (window.disposedModels || 0) + 1; };
      return transcribe;
    }
  `,
}));

try {
  await page.goto(`${process.env.TEST_BASE_URL || 'http://127.0.0.1:5173'}/#subtitles`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#subtitleRecognitionModel').inputValue(), 'tiny');
  assert.match(await page.locator('#subtitleModelCapability').textContent(), /Tiny.*清晰人声.*错词/);
  // Two files with different input sample rates and different track start delays.
  const sources = await page.evaluate(async () => {
    const { FFmpeg } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js');
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({ coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`, wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm` });
    try {
      const sources = [];
      for (const [index, rate, offset] of [[1, 44100, 1.2], [2, 48000, 0.4]]) {
        const path = `delayed-${index}.mp4`;
        const code = await ffmpeg.exec(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=4',
          '-itsoffset', String(offset), '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=0.8`,
          '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-t', '4', path]);
        if (code) throw new Error(`Fixture failed: ${code}`);
        // Measure the old path too, so this regression proves a real improvement.
        await ffmpeg.exec(['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'old.f32']);
        const old = await ffmpeg.readFile('old.f32');
        const samples = new Float32Array(old.buffer.slice(old.byteOffset, old.byteOffset + old.byteLength));
        sources.push({ bytes: Array.from(await ffmpeg.readFile(path)), oldOnset: samples.findIndex(x => Math.abs(x) > 0.01) / 16000 });
      }
      return sources;
    } finally { ffmpeg.terminate(); }
  });
  await page.locator('#subtitleFile').setInputFiles(sources.map(({ bytes }, index) => ({
    name: `delayed-${index + 1}.mp4`, mimeType: 'video/mp4', buffer: Buffer.from(bytes),
  })));
  await page.waitForFunction(() => document.querySelector('#subtitleVideo').videoWidth === 320);
  await page.locator('#transcribeAllBtn').click();
  await page.waitForFunction(() => document.querySelector('#subtitleStatus').textContent.includes('2 个成功'), { timeout: 60000 });
  const calls = await page.evaluate(() => window.recognitionCalls);
  assert.equal(calls.length, 2);
  for (const [index, onset] of [[0, 1.2], [1, 0.4]]) {
    assert.ok(Math.abs(calls[index].onset - onset) < 0.04, `onset ${calls[index].onset}, expected ${onset}`);
    assert.ok(sources[index].oldOnset < 0.05, `old onset ${sources[index].oldOnset}`);
    assert.equal(calls[index].model, 'Xenova/whisper-tiny.en');
    assert.equal(calls[index].options.language, undefined);
    assert.equal(calls[index].options.task, undefined);
    assert.equal(calls[index].options.stride_length_s, 5);
    await page.locator('.subtitle-batch-item').nth(index).click();
    await page.waitForFunction((i) => document.querySelector('#subtitleActiveName').textContent === `delayed-${i + 1}.mp4`, index);
    assert.deepEqual(await page.locator('.subtitle-cue-text').evaluateAll(nodes => nodes.map(node => node.value)), [`Video${index + 1} caption.`, 'More words.']);
    const serialized = await page.locator('#subtitleCues').inputValue();
    assert.ok(Math.abs(Number(serialized.split('|')[0]) - onset) < 0.04, serialized);
    await page.locator('#subtitleFontFamily').selectOption(index === 0 ? 'impact' : 'yahei');
  }
  assert.equal(await page.locator('#subtitleFontFamily option').count(), 16);
  await page.locator('.subtitle-batch-item').first().click();
  assert.equal(await page.locator('#subtitleFontFamily').inputValue(), 'impact');
  await page.locator('.subtitle-batch-item').last().click();
  assert.equal(await page.locator('#subtitleFontFamily').inputValue(), 'yahei');
  await page.locator('#subtitleRecognitionLanguage').selectOption('zh');
  assert.match(await page.locator('#subtitleModelCapability').textContent(), /Tiny 多语言.*中文/);
  await page.locator('#transcribeBtn').click();
  assert.equal(await page.locator('#subtitleRecognitionLanguage').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('#subtitleStatus').textContent.startsWith('已生成'));
  assert.equal(await page.evaluate(() => window.recognitionCalls.at(-1).options.language), 'zh');
  await page.locator('#subtitleRecognitionLanguage').selectOption('en');
  await page.locator('#subtitleRecognitionModel').selectOption('base');
  assert.match(await page.locator('#subtitleModelCapability').textContent(), /Base.*较慢.*内存/);
  await page.locator('#transcribeBtn').click();
  await page.waitForFunction(() => document.querySelector('#subtitleStatus').textContent.startsWith('已生成'));
  assert.deepEqual(await page.evaluate(() => window.modelLoads), ['Xenova/whisper-tiny.en', 'Xenova/whisper-tiny', 'Xenova/whisper-base']);
  assert.equal(await page.evaluate(() => window.disposedModels), 2);
  assert.equal(await page.evaluate(() => window.recognitionCalls.at(-1).model), 'Xenova/whisper-base');
  assert.equal(await page.evaluate(() => window.recognitionCalls.at(-1).options.language), 'en');
  assert.deepEqual(errors, []);
  await mkdir('output', { recursive: true });
  await page.screenshot({ path: 'output/caption-recognition.png', fullPage: true });
  console.log(JSON.stringify({ batchFiles: calls.length, onsets: calls.map(x => x.onset), oldOnsets: sources.map(x => x.oldOnset),
    fonts: 16, modelSwitch: 'passed', captionOwnership: 'passed', timestampRepair: 'passed' }));
} finally { await browser.close(); }
