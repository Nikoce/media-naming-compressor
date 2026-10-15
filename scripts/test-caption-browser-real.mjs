// Opt-in end-to-end regression using local videos and cached original models.
// Pass video paths, start the app, and set PLAYWRIGHT_MODULE if needed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE } from '../src/release-notes.js';
import { SEEN_RELEASE_KEY } from '../src/app-updates.js';
const sources = process.argv.slice(2).map(path => resolve(path));
if (!sources.length) throw Error('Pass local speech video paths.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(({ key, version }) => localStorage.setItem(key, version), { key: SEEN_RELEASE_KEY, version: RELEASE.version });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
// Fulfil model requests from the unchanged model files cached by the native
// real-ASR test. No user video is sent to the model host or any remote server.
await page.route('https://huggingface.co/Xenova/whisper-*/resolve/main/**', async route => {
  const match = new URL(route.request().url()).pathname.match(/^\/Xenova\/(whisper-(?:tiny(?:\.en)?|base))\/resolve\/main\/(.+)$/);
  if (!match) return route.continue();
  await route.fulfill({ path: join(process.env.ASR_MODEL_CACHE || 'output/asr-model-cache', 'Xenova', match[1], match[2]),
    contentType: match[2].endsWith('.json') ? 'application/json' : 'application/octet-stream' });
});
try {
  const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173';
  await page.goto(`${base.replace(/\/$/u, '')}/#subtitles`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#subtitleRecognitionModel').inputValue(), 'tiny');
  assert.equal(await page.locator('#subtitleRecognitionLanguage').inputValue(), 'en');
  assert.match(await page.locator('#subtitleModelCapability').textContent(), /Tiny.en.*英文专用/);
  await page.locator('#subtitleFile').setInputFiles(sources);
  await page.waitForFunction(() => document.querySelector('#subtitleVideo').videoWidth > 0);
  const start = performance.now();
  await page.locator('#transcribeAllBtn').click();
  await page.waitForFunction(count => document.querySelector('#subtitleStatus').textContent.includes(`${count} 个成功`), sources.length, { timeout: 180000 });
  const elapsedMs = Math.round(performance.now() - start);
  const results = [];
  for (const [index, source] of sources.entries()) {
    const name = basename(source);
    await page.locator('.subtitle-batch-item').nth(index).click();
    await page.waitForFunction(value => document.querySelector('#subtitleActiveName').textContent === value, name);
    const cues = (await page.locator('#subtitleCues').inputValue()).split('\n').map(line => {
      const [start, end, ...text] = line.split('|');
      return { start: Number(start), end: Number(end), text: text.join('|').trim() };
    });
    assert.ok(cues.length > 0);
    assert.ok(cues.every((cue, i) => cue.start >= 0 && cue.end > cue.start && (!i || cue.start >= cues[i - 1].end)));
    assert.ok(cues.every(cue => !/^[,.;%]/u.test(cue.text)), 'no stranded closing punctuation or numeric separators');
    assert.ok(cues.every(cue => !/[\[\]【】♪♫]/u.test(cue.text)), 'no generated sound annotations reach the preview/export cues');
    const status = await page.locator('.subtitle-batch-item').nth(index).textContent();
    results.push({ name, status, cues });
  }
  assert.deepEqual(errors, []);
  await mkdir('output', { recursive: true });
  await writeFile('output/caption-browser-real-report.json', JSON.stringify({ elapsedMs, results }, null, 2));
  await page.screenshot({ path: 'output/caption-browser-real.png', fullPage: true });
  await page.locator('#subtitleRecognitionModel').selectOption('base');
  assert.match(await page.locator('#subtitleModelCapability').textContent(), /Base.*较慢/);
  await page.locator('#subtitleRecognitionModel').selectOption('tiny');
  await page.locator('#subtitleRecognitionLanguage').selectOption('zh');
  assert.match(await page.locator('#subtitleModelCapability').textContent(), /Tiny 多语言.*中文/);
  await page.locator('#subtitleRecognitionLanguage').selectOption('en');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('.subtitle-recognition-panel').screenshot({ path: 'output/caption-model-mobile.png' });
  console.log(JSON.stringify({ videos: sources.length, elapsedMs, reviewCount: results.filter(row => row.status.includes('需校对')).length,
    model: 'Tiny.en', ownership: 'passed', mobileLayout: 'passed', errors }));
} finally { await browser.close(); }
