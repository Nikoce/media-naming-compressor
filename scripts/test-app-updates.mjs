// Run against npm run dev. Uses virtual time and mocked future release manifests.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { RELEASE } from '../src/release-notes.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173';
const current = await (await fetch(`${base}/version.json`)).json();
const future = { ...current, buildId: 'test-next-build', version: '0.10.0', title: '下一次更新',
  features: [{ title: '新功能介绍', description: '更新说明用文字展示 <img src=x>，不会执行 HTML。' }] };
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (error) => errors.push(error.message));
let remote = current;
let manifestRequests = 0;
await page.route('**/version.json?*', (route) => {
  manifestRequests++;
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(remote) });
});
await page.clock.install();
try {
  await page.goto(`${base}/#subtitles`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#appUpdateTitle').innerText(), RELEASE.title);
  assert.equal(await page.locator('#appUpdateFeatures li').count(), RELEASE.features.length);
  assert.equal(await page.locator('#appUpdateCountdown').isVisible(), false);
  await mkdir('output', { recursive: true });
  await page.screenshot({ path: 'output/app-updates-desktop.png' });
  await page.setViewportSize({ width: 375, height: 812 });
  const bounds = await page.locator('#appUpdateDialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 812);
  for (const id of ['#appUpdateLater', '#appUpdateConfirm']) {
    const button = await page.locator(id).boundingBox();
    assert.ok(button.x >= bounds.x && button.x + button.width <= bounds.x + bounds.width, `${id} stays inside mobile dialog`);
  }
  await page.screenshot({ path: 'output/app-updates-mobile.png' });
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#appUpdateDialog').isVisible(), false, 'intro only appears once');
  await page.locator('#appUpdateTrigger').click();
  await page.locator('#appUpdateConfirm').click();

  // A future deployment is found on focus; defer cancels the countdown.
  remote = future;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('#appUpdateCountdown').waitFor();
  assert.equal(await page.locator('#appUpdateFeatures img').count(), 0);
  await page.clock.fastForward(5000);
  assert.match(await page.locator('#appUpdateCountdown').innerText(), /10 秒/);
  await page.locator('#appUpdateLater').click();
  await page.clock.fastForward(20000);
  assert.equal(new URL(page.url()).searchParams.has('_app_update'), false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#appUpdateDialog').isVisible(), false, 'same deferred update does not reopen');

  // A queued file added during the countdown cancels automatic navigation.
  await page.locator('#appUpdateTrigger').click();
  await page.locator('#subtitleFile').setInputFiles({ name: 'queued.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(64) });
  await page.clock.fastForward(2000);
  assert.equal(await page.locator('#appUpdateCountdown').isVisible(), false);
  assert.match(await page.locator('#appUpdateHint').innerText(), /刷新会清空/);
  await page.clock.fastForward(20000);
  assert.equal(new URL(page.url()).searchParams.has('_app_update'), false);
  await page.locator('#appUpdateLater').click();
  await page.locator('.subtitle-remove-button').click();

  // Idle pages refresh once, preserving their route. Cached old HTML cannot loop.
  await page.locator('#appUpdateTrigger').click();
  const navigated = page.waitForURL((url) => url.searchParams.get('_app_update') === future.buildId);
  await page.clock.fastForward(15000);
  await navigated;
  await page.waitForLoadState('networkidle');
  assert.equal(new URL(page.url()).hash, '#subtitles');
  await page.locator('#appUpdateDialog').waitFor();
  assert.match(await page.locator('#appUpdateHint').innerText(), /暂未生效/);
  assert.equal(await page.locator('#appUpdateCountdown').isVisible(), false);
  let reloads = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloads++; });
  await page.clock.fastForward(60000);
  assert.equal(reloads, 0, 'no refresh loop after a stale deployment');

  // Busy subtitle jobs stay alive and the explicit refresh action is disabled.
  const busyPage = await browser.newPage();
  busyPage.on('pageerror', (error) => errors.push(error.message));
  await busyPage.route('**/version.json?*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(remote) }));
  await busyPage.route(/(?:@huggingface_transformers|transformers\.web).*\.js/, (route) => route.fulfill({
    contentType: 'text/javascript', body: 'export async function pipeline() { return () => new Promise(() => {}); }',
  }));
  remote = current;
  await busyPage.clock.install();
  await busyPage.goto(`${base}/#subtitles`);
  await busyPage.waitForLoadState('networkidle');
  await busyPage.locator('#appUpdateLater').click();
  await busyPage.locator('#subtitleFile').setInputFiles({ name: 'busy.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(64) });
  await busyPage.evaluate(() => {
    navigator.locks.request('media-naming-compressor.encoding.v1', async () => {
      window.lockHeld = true;
      await new Promise(() => {});
    });
  });
  await busyPage.waitForFunction(() => window.lockHeld);
  await busyPage.locator('#transcribeBtn').click();
  remote = future;
  await busyPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await busyPage.locator('#appUpdateDialog').waitFor();
  assert.equal(await busyPage.locator('#appUpdateConfirm').isDisabled(), true);
  assert.match(await busyPage.locator('#appUpdateHint').innerText(), /正在处理中/);
  await busyPage.clock.fastForward(30000);
  assert.equal(new URL(busyPage.url()).searchParams.has('_app_update'), false);
  await busyPage.close();
  // GitHub Pages serves this app from a repository subdirectory.
  const subpathPage = await browser.newPage();
  const subpathRequests = [];
  // Vite's dev server normalizes BASE_URL to '/'; production builds use './'.
  await subpathPage.route('**/src/app-updates.js*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replaceAll('import.meta.env.BASE_URL', JSON.stringify('./')) });
  });
  await subpathPage.route('**/version.json?*', (route) => {
    subpathRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(future) });
  });
  await subpathPage.goto(`${base}/project/#subtitles`);
  await subpathPage.waitForLoadState('networkidle');
  assert.deepEqual(subpathRequests, ['/project/version.json']);
  assert.equal(await subpathPage.locator('#appUpdateEyebrow').innerText(), '发现新版本');
  await subpathPage.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ introOnce: true, mobileLayout: 'passed', defer: 'passed',
    queuedFileProtection: 'passed', busyProtection: 'passed', autoRefresh: 'passed', noRefreshLoop: true,
    githubPagesSubpath: 'passed', manifestRequests }));
} finally { await browser.close(); }
