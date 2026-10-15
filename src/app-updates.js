import { RELEASE } from './release-notes.js';

export const SEEN_RELEASE_KEY = 'mediaWorkbench.seenRelease.v1';
const ATTEMPTED_BUILD_KEY = 'mediaWorkbench.attemptedBuild.v1';
const AUTO_REFRESH_SECONDS = 15;

function readStorage(storage, key) {
  try { return window[storage].getItem(key); } catch { return null; }
}
function writeStorage(storage, key, value) {
  try { window[storage].setItem(key, value); } catch { /* Storage can be disabled. */ }
}

export function parseReleaseManifest(value) {
  if (value?.schema !== 1 || typeof value.buildId !== 'string' || !value.buildId || value.buildId.length > 160
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)
    || typeof value.title !== 'string' || !value.title || value.title.length > 100
    || !Array.isArray(value.features) || !value.features.length || value.features.length > 12
    || value.features.some((feature) => typeof feature?.title !== 'string' || !feature.title || feature.title.length > 100
      || typeof feature.description !== 'string' || feature.description.length > 500)) return null;
  return value;
}

export function canAutoRefresh({ hasWork, processing, visible, dismissed, attempted }) {
  return !hasWork && !processing && visible && !dismissed && !attempted;
}

export function setupAppUpdates({ hasWork, isProcessing }) {
  const buildId = __APP_BUILD_ID__;
  const $ = (id) => document.getElementById(id);
  const dialog = $('appUpdateDialog');
  const trigger = $('appUpdateTrigger');
  const confirm = $('appUpdateConfirm');
  const hint = $('appUpdateHint');
  const countdown = $('appUpdateCountdown');
  let pending = null;
  let dismissedBuild = null;
  let deadline = null;
  let checking = false;

  function setHint(message) {
    if (hint.textContent !== message) hint.textContent = message;
  }

  function renderNotes(release) {
    $('appUpdateVersion').textContent = `v${release.version}`;
    $('appUpdateTitle').textContent = release.title;
    $('appUpdateFeatures').replaceChildren(...release.features.map((feature) => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      const description = document.createElement('p');
      title.textContent = feature.title;
      description.textContent = feature.description;
      item.append(title, description);
      return item;
    }));
  }

  function updateActions() {
    if (!dialog.open) { deadline = null; return; }
    if (!pending) {
      setHint('已是当前版本，可以开始使用了。');
      confirm.textContent = '开始使用';
      confirm.disabled = false;
      countdown.hidden = true;
      return;
    }
    const processing = isProcessing();
    const work = hasWork();
    const attempted = readStorage('sessionStorage', ATTEMPTED_BUILD_KEY) === pending.buildId
      || new URL(window.location.href).searchParams.get('_app_update') === pending.buildId;
    const auto = canAutoRefresh({ hasWork: work, processing, visible: !document.hidden,
      dismissed: dismissedBuild === pending.buildId, attempted });
    confirm.disabled = processing;
    confirm.textContent = processing ? '等待任务完成' : work ? '已保存，刷新更新' : '立即刷新更新';
    setHint(processing ? '视频正在处理中，完成后再刷新，不会中断当前任务。'
      : work ? '当前有视频、字幕或导出结果。请先下载所需文件，刷新会清空当前页面。'
        : attempted ? '更新暂未生效，请稍后重试刷新。'
          : '当前没有视频任务，页面将在倒计时结束后自动刷新。');
    countdown.hidden = !auto;
    if (!auto) { deadline = null; return; }
    deadline ??= Date.now() + AUTO_REFRESH_SECONDS * 1000;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    countdown.textContent = `${seconds} 秒后自动刷新`;
    if (!seconds) refresh(true);
  }

  function show() {
    dismissedBuild = null;
    renderNotes(pending || RELEASE);
    $('appUpdateEyebrow').textContent = pending ? '发现新版本' : '本次更新';
    $('appUpdateLater').textContent = pending ? '稍后更新' : '关闭';
    deadline = null;
    if (!dialog.open) dialog.showModal();
    updateActions();
  }

  function dismiss() {
    if (pending) dismissedBuild = pending.buildId;
    else writeStorage('localStorage', SEEN_RELEASE_KEY, RELEASE.version);
    deadline = null;
    dialog.close();
  }

  function refresh(automatic = false) {
    // Recheck at the moment of navigation: a queued timer must never erase a
    // newly started job. Explicit clicks acknowledge any saved work.
    if (!pending || isProcessing() || (automatic && (hasWork() || document.hidden))) return;
    writeStorage('sessionStorage', ATTEMPTED_BUILD_KEY, pending.buildId);
    const url = new URL(window.location.href);
    url.searchParams.set('_app_update', pending.buildId);
    window.location.replace(url.href);
  }

  async function check() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const url = new URL(`${import.meta.env.BASE_URL}version.json`, window.location.href);
      url.searchParams.set('t', String(Date.now()));
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const release = parseReleaseManifest(await response.json());
      if (!release || release.buildId === buildId || release.buildId === pending?.buildId) return;
      pending = release;
      dismissedBuild = null;
      trigger.textContent = '发现新版本';
      trigger.classList.add('has-update');
      show();
    } catch { /* Offline or an older deployment without a manifest: keep working. */ }
    finally { checking = false; }
  }

  trigger.addEventListener('click', show);
  $('appUpdateLater').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
  confirm.addEventListener('click', () => pending ? refresh() : dismiss());
  window.setInterval(updateActions, 1000);
  window.setInterval(check, 60000);
  const onVisible = () => { deadline = null; updateActions(); if (!document.hidden) check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  trigger.textContent = `更新说明 · v${RELEASE.version}`;
  if (readStorage('localStorage', SEEN_RELEASE_KEY) !== RELEASE.version) show();
  check();
}
