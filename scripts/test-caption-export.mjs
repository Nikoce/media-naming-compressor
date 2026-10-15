// Run against npm run dev. Set PLAYWRIGHT_MODULE to a bundled playwright/index.mjs if needed.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { RELEASE } from '../src/release-notes.js';
import { SEEN_RELEASE_KEY } from '../src/app-updates.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(({ key, version }) => localStorage.setItem(key, version), { key: SEEN_RELEASE_KEY, version: RELEASE.version });
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173';
const errors = [];
const page = await context.newPage();
let loadCount = 0;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (msg) => { if (msg.type() === 'warning' && msg.text().includes('字幕极速')) console.log(msg.text()); });
page.on('dialog', async (dialog) => { errors.push(dialog.message()); console.error('Dialog:', dialog.message()); await dialog.dismiss(); });

async function load() {
  await page.goto(`${base}/?regression=${++loadCount}#subtitles`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    window.mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
  });
}

async function editCaptions() {
  await page.evaluate(() => {
    document.querySelector('#subtitleCues').value = '0.123 | 1.123 | 中文字幕 First\n1.567 | 2.234 | Second caption';
  });
  // The serialized textarea is internal storage; commit through the editor's normal save path.
  await page.locator('#subtitleAddCue').click();
  await page.locator('#subtitleDeleteCue').click();
}

async function inspectOutput(url, expectedEngine) {
  const stats = await page.evaluate(async ({ url }) => {
    const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = window.mb;
    const input = new Input({ source: new BlobSource(await (await fetch(url)).blob()), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      const frames = [];
      for await (const sample of new VideoSampleSink(track).samples()) {
        sample.draw(ctx, 0, 0, 320, 240);
        const pixels = ctx.getImageData(0, 150, 320, 90).data;
        let white = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 170 && pixels[i + 1] > 170 && pixels[i + 2] > 170) white++;
        frames.push({ t: sample.timestamp, white }); sample.close();
      }
      return { frames, duration: await input.computeDuration(), audio: !!await input.getPrimaryAudioTrack(), width: await track.getDisplayWidth(), height: await track.getDisplayHeight() };
    } finally { input.dispose(); }
  }, { url });
  assert.equal(stats.width, 320); assert.equal(stats.height, 240);
  assert.equal(stats.audio, true, `${expectedEngine}: preserve audio`);
  assert.ok(Math.abs(stats.duration - 2.6) < 0.12, `duration ${stats.duration}`);
  assert.ok(stats.frames.length >= 76 && stats.frames.length <= 81, `frame count ${stats.frames.length}`);
  for (const frame of stats.frames) {
    // Ignore one frame around a cue boundary for codec timestamp rounding.
    if ([0.123, 1.123, 1.567, 2.234].some((t) => Math.abs(t - frame.t) < 0.04)) continue;
    const visible = (frame.t > 0.123 && frame.t < 1.123) || (frame.t > 1.567 && frame.t < 2.234);
    assert.ok(visible ? frame.white > 40 : frame.white < 10,
      `${expectedEngine} frame ${frame.t.toFixed(4)} white=${frame.white} expected caption=${visible}`);
  }
  console.log(JSON.stringify({ engine: expectedEngine, frames: stats.frames.length, duration: stats.duration, audio: stats.audio, captionPersistence: 'passed' }));
}

try {
  await load();
  const source = await page.evaluate(async () => {
    const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } = window.mb;
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 320, 240);
    const target = new BufferTarget();
    const output = new Output({ target, format: new Mp4OutputFormat() });
    const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 250000 });
    output.addVideoTrack(video, { frameRate: 30 });
    await output.start();
    for (let i = 0; i < 78; i++) await video.add(i / 30, 1 / 30);
    video.close(); await output.finalize();
    // Chromium on Windows does not necessarily provide an AAC encoder. Make an AAC fixture with WASM.
    const { FFmpeg } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js');
    const ffmpeg = new FFmpeg();
    try {
      await ffmpeg.load({ coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`, wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm` });
      await ffmpeg.writeFile('source.mp4', new Uint8Array(target.buffer));
      const code = await ffmpeg.exec(['-y', '-i', 'source.mp4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', '2.6', 'fixture.mp4']);
      if (code) throw new Error(`Fixture failed ${code}`);
      return Array.from(await ffmpeg.readFile('fixture.mp4'));
    } finally { ffmpeg.terminate(); }
  });
  const file = { name: 'caption_L-en.mp4', mimeType: 'video/mp4', buffer: Buffer.from(source) };
  for (const engine of ['webcodecs', 'ffmpeg']) {
    if (engine === 'ffmpeg') { await load(); await page.evaluate(() => { window.VideoEncoder = undefined; }); }
    let ffmpegRequests = 0;
    const listener = (request) => { if (request.url().includes('/ffmpeg/')) ffmpegRequests++; };
    page.on('request', listener);
    await page.locator('#subtitleFile').setInputFiles(file);
    await page.waitForFunction(() => document.querySelector('#subtitleVideo').videoWidth === 320);
    await editCaptions();
    // Hold a second window's lock. Sending should finish even while encoding is unavailable.
    const second = await context.newPage(); await second.goto(base); await second.waitForLoadState('networkidle');
    await second.evaluate(() => {
      window.testLock = navigator.locks.request('media-naming-compressor.encoding.v1', async () => {
        window.lockHeld = true; await new Promise((resolve) => { window.releaseLock = resolve; });
      });
    });
    await second.waitForFunction(() => window.lockHeld);
    const start = performance.now();
    await page.locator('#subtitleNameExportBtn').click();
    await page.waitForFunction(() => location.hash === '#naming', { timeout: 5000 });
    assert.equal(ffmpegRequests, 0, 'send must not load FFmpeg or encode');
    assert.match(await page.locator('#videoList').innerText(), /2 条字幕/);
    console.log(`send ${engine}: ${Math.round(performance.now() - start)}ms, no FFmpeg requests`);
    // Editing source cues afterwards must not change the already sent snapshot.
    await page.locator('#subtitleNav').click();
    await page.locator('.subtitle-cue-text').first().fill('Changed after send');
    await page.locator('#namingNav').click();
    if (engine === 'webcodecs') {
      for (const [id, value] of [['product', 'Test'], ['theme', 'Hook'], ['maker', 'QA'], ['productionTime', '1']]) await page.locator(`#${id}`).fill(value);
    }
    const button = engine === 'webcodecs' ? '#processBtn' : '#compressOnlyBtn';
    await page.locator(button).click();
    await page.waitForFunction(() => document.querySelector('#videoList').textContent.includes('等待其他视频处理任务'));
    assert.equal(await page.locator('#results .download-button').count(), 0, 'job must wait for other window');
    await second.evaluate(() => window.releaseLock()); await second.close();
    await page.locator('#results .download-button').waitFor({ timeout: 120000 });
    assert.equal(await page.locator('#videoList .status-chip').innerText(), '已输出');
    const label = await page.locator('#results .result-meta').innerText();
    assert.match(label, engine === 'webcodecs' ? /WebCodecs/ : /FFmpeg/);
    // Read blob URL from the real download initiated by the result button.
    const downloadEvent = page.waitForEvent('download'); await page.locator('#results .download-button').click();
    const download = await downloadEvent; await inspectOutput(download.url(), engine);
    page.off('request', listener);
  }
  // Batch sends duplicate source names independently and reports the video with no captions.
  await load();
  await page.locator('#subtitleFile').setInputFiles([file, file, file]);
  await page.waitForFunction(() => document.querySelector('#subtitleVideo').videoWidth === 320);
  await editCaptions();
  await page.locator('.subtitle-batch-item').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#subtitleVideo').readyState >= 1);
  await editCaptions();
  await page.locator('#subtitleBatchSendBtn').click();
  await page.waitForFunction(() => location.hash === '#naming', { timeout: 5000 });
  assert.equal(await page.locator('#fileCount').innerText(), '2 个文件');
  assert.match(await page.locator('#subtitleTransferReport').innerText(), /没有字幕/);
  await page.locator('#compressOnlyBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('#results .download-button').length === 2, { timeout: 120000 });
  const names = await page.locator('#results .result-name').allTextContents();
  assert.notEqual(names[0], names[1], 'duplicate source names get unique output names');
  for (let i = 0; i < 2; i++) {
    const downloadEvent = page.waitForEvent('download'); await page.locator('#results .download-button').nth(i).click();
    await inspectOutput((await downloadEvent).url(), `batch-${i + 1}`);
  }
  // The standalone MP4 export uses the same verified burning path.
  await page.locator('#subtitleNav').click();
  const directEvent = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#subtitleExportBtn').click();
  await inspectOutput((await directEvent).url(), 'standalone');
  const zipEvent = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#subtitleBatchExportBtn').click();
  const zipDownload = await zipEvent;
  const zipFiles = await page.evaluate(async (url) => {
    const JSZip = (await import('/node_modules/.vite/deps/jszip.js')).default;
    const zip = await JSZip.loadAsync(await (await fetch(url)).arrayBuffer());
    const files = [];
    for (const file of Object.values(zip.files)) if (!file.dir) files.push({ name: file.name, url: URL.createObjectURL(await file.async('blob')) });
    return files;
  }, zipDownload.url());
  assert.equal(zipFiles.length, 2);
  assert.notEqual(zipFiles[0].name, zipFiles[1].name);
  for (const file of zipFiles) { await inspectOutput(file.url, `zip ${file.name}`); await page.evaluate((url) => URL.revokeObjectURL(url), file.url); }
  assert.deepEqual(errors, [], 'no runtime errors or error dialogs');
} finally { await browser.close(); }
