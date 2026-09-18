import './styles.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import JSZip from 'jszip';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeVideo,
} from 'mediabunny';

const state = {
  files: [],
  history: {},
  onlyIssues: false,
  completedOutputs: [],
  ffmpeg: null,
  ffmpegLoading: null,
  fastEngineSupported: null,
  fastEngineChecking: null,
  currentProcessingId: null,
  currentBatchIndex: 0,
  lastProgressPercent: -1,
  processing: false,
  translating: false,
  activeProcessButton: null,
  themeTranslators: new Map(),
};

const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const workspace = $('workspace');
const videoList = $('videoList');
const analysisStatus = $('analysisStatus');
const processBtn = $('processBtn');
const compressOnlyBtn = $('compressOnlyBtn');
const translateThemeBtn = $('translateThemeBtn');
const results = $('results');
const resultPanel = $('resultPanel');
const onlyIssues = $('onlyIssues');
const clearBtn = $('clearBtn');
const addMoreBtn = $('addMoreBtn');
const fileCount = $('fileCount');
const previewSummary = $('previewSummary');
const batchDownloadBtn = $('batchDownloadBtn');
const batchDownloadMeta = $('batchDownloadMeta');
const engineStatus = $('engineStatus');
const HISTORY_STORAGE_KEY = 'mediaNamingCompressor.history.v2';
const COMPRESSION_PROFILES = {
  standard: {
    videoQuality: 0.55,
    audioBitrate: 192000,
    ffmpegArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '192k'],
  },
  quality: {
    videoQuality: 0.60,
    audioBitrate: 192000,
    ffmpegArgs: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k'],
  },
  small: {
    videoQuality: 0.35,
    audioBitrate: 128000,
    ffmpegArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k'],
  },
};

const fields = {
  date: $('date'),
  product: $('product'),
  theme: $('theme'),
  duration: $('duration'),
  ratio: $('ratio'),
  language: $('language'),
  maker: $('maker'),
  productionTime: $('productionTime'),
};

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

fields.date.value = todayYYMMDD();

function safePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[ch]));
}

function formatFileSize(size) {
  if (!Number.isFinite(size)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)}${units[i]}`;
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function ratioCode(width, height) {
  if (!width || !height) return '';
  const divisor = gcd(width, height);
  let rw = Math.round(width / divisor);
  let rh = Math.round(height / divisor);
  const common = [
    [9, 16], [16, 9], [1, 1], [4, 5], [5, 4], [3, 4], [4, 3],
    [2, 3], [3, 2], [9, 19], [19, 9], [9, 20], [20, 9],
  ];
  const actual = width / height;
  let best = [rw, rh];
  let bestDiff = Infinity;
  for (const pair of common) {
    const diff = Math.abs(actual - pair[0] / pair[1]);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pair;
    }
  }
  if (bestDiff <= 0.025) [rw, rh] = best;
  return `${rw}${rh}`;
}

function ratioLabel(code) {
  const raw = String(code || '');
  const known = {
    916: '9:16', 169: '16:9', 11: '1:1', 45: '4:5', 54: '5:4',
    34: '3:4', 43: '4:3', 23: '2:3', 32: '3:2', 919: '9:19',
    199: '19:9', 920: '9:20', 209: '20:9',
  };
  return known[raw] || raw;
}

function detectLanguage(fileName, taggedLanguage = '') {
  const nameMatch = String(fileName || '').match(/(?:^|_)L-([a-z]{2,3})(?:_|\.|$)/i);
  const raw = nameMatch?.[1] || taggedLanguage;
  if (!raw) return '';
  const aliases = {
    eng: 'en', jpn: 'ja', zho: 'zh', chi: 'zh', cmn: 'zh', deu: 'de', ger: 'de',
    fra: 'fr', fre: 'fr', spa: 'es', kor: 'ko', por: 'pt', ita: 'it', rus: 'ru',
    ara: 'ar', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id',
  };
  const key = String(raw).toLowerCase().split(/[-_]/)[0];
  return aliases[key] || key.slice(0, 2);
}

function languageFor(item) {
  const override = safePart(fields.language.value);
  return override || safePart(item?.detected?.language);
}

function valuesFor(item) {
  const detected = item?.detected || {};
  return {
    date: safePart(fields.date.value || todayYYMMDD()),
    product: safePart(fields.product.value),
    theme: safePart(fields.theme.value),
    duration: safePart(detected.duration),
    ratio: safePart(detected.ratio),
    language: languageFor(item),
    maker: safePart(fields.maker.value),
    productionTime: safePart(fields.productionTime.value),
  };
}

function namingState(item) {
  if (item.error) return { ok: false, missing: ['分析失败'] };
  if (!item.detected) return { ok: false, missing: ['分析中'] };
  const values = valuesFor(item);
  const labels = {
    date: '日期', product: '产品', theme: '主题', duration: '时长', ratio: '尺寸',
    language: '语言', maker: '制作人', productionTime: '制作时长',
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => labels[key]);
  return { ok: missing.length === 0, missing };
}

function themeKey(item) {
  return item ? safePart(valuesFor(item).theme).toLowerCase() : '';
}

function duplicateSequence(item) {
  const key = themeKey(item);
  if (!key) return '';
  const duplicates = state.files.filter((candidate) => themeKey(candidate) === key);
  if (duplicates.length <= 1) return '';
  const position = duplicates.indexOf(item);
  return position < 0 ? '' : String(position + 1).padStart(2, '0');
}

function finalValuesFor(item) {
  const values = valuesFor(item);
  const sequence = duplicateSequence(item);
  if (sequence && values.theme) values.theme = `${values.theme}-${sequence}`;
  return values;
}

function nameFor(item) {
  if (!item) return '—';
  const values = finalValuesFor(item);
  return `${values.date || '日期'}_P-${values.product || '产品'}_H-${values.theme || '主题'}_VL-S-${values.duration || '时长'}_S-${values.ratio || '尺寸'}_L-${values.language || '语言'}_D-${values.maker || '制作人'}_M-${values.productionTime || '制作时长'}.mp4`;
}

function sourceBaseName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim() || 'output';
  return base.replace(/[\\/:*?"<>|]/g, '-').replace(/[. ]+$/g, '') || 'output';
}

function compressionOnlyNames() {
  const bases = state.files.map((item) => sourceBaseName(item.file.name));
  const totals = new Map();
  for (const base of bases) {
    const key = base.toLowerCase();
    totals.set(key, (totals.get(key) || 0) + 1);
  }

  const seen = new Map();
  const used = new Set();
  const names = new Map();
  state.files.forEach((item, index) => {
    const base = bases[index];
    const key = base.toLowerCase();
    const sequence = (seen.get(key) || 0) + 1;
    seen.set(key, sequence);
    let suffix = totals.get(key) > 1 ? sequence : 0;
    let candidate = `${base}${suffix ? `-${String(suffix).padStart(2, '0')}` : ''}.mp4`;
    while (used.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${base}-${String(suffix).padStart(2, '0')}.mp4`;
    }
    used.add(candidate.toLowerCase());
    names.set(item.id, candidate);
  });
  return names;
}

function isProcessing(item) {
  return String(item.status || '').startsWith('正在压制');
}

function itemClass(item) {
  if (item.error || item.processError || item.status === '输出失败') return 'failed';
  if (isProcessing(item)) return 'processing';
  if (item.status === '输出完成') return 'done';
  return namingState(item).ok ? 'ready' : 'issue';
}

function statusChip(item) {
  if (item.error || item.processError || item.status === '输出失败') return { text: '异常', cls: 'error' };
  if (isProcessing(item)) return { text: item.progress ? `${item.progress}%` : (item.engine === 'ffmpeg' ? '兼容压制' : '极速压制'), cls: '' };
  if (item.status === '输出完成') return { text: '已输出', cls: 'ok' };
  if (!item.detected) return { text: '分析中', cls: '' };
  const naming = namingState(item);
  return naming.ok ? { text: '通过', cls: 'ok' } : { text: `缺 ${naming.missing.join('/')}`, cls: 'warn' };
}

function renderSummary() {
  fileCount.textContent = `${state.files.length} 个文件`;
  if (!state.files.length) {
    previewSummary.innerHTML = '';
    analysisStatus.textContent = '等待分析';
    return;
  }
  const analyzing = state.files.filter((item) => !item.detected && !item.error).length;
  const issues = state.files.filter((item) => !namingState(item).ok).length;
  if (analyzing) {
    previewSummary.innerHTML = `<span class="summary-badge loading">正在分析 ${analyzing} 个素材</span>`;
    analysisStatus.textContent = `正在分析 ${analyzing} / ${state.files.length}`;
  } else if (issues) {
    previewSummary.innerHTML = `<span class="summary-badge warn">${issues} 个素材待补全</span>`;
    analysisStatus.textContent = `${issues} 个待补全`;
  } else {
    previewSummary.innerHTML = `<span class="summary-badge ok">全部通过 · ${state.files.length} 个素材</span>`;
    analysisStatus.textContent = '全部可输出';
  }
}

function renderVideoList() {
  videoList.innerHTML = '';
  let visibleCount = 0;
  state.files.forEach((item, index) => {
    const naming = namingState(item);
    if (state.onlyIssues && naming.ok && !item.error) return;
    visibleCount += 1;
    const detected = item.detected || {};
    const chip = statusChip(item);
    const meta = [
      '视频', detected.resolution || '读取中', detected.duration ? `${detected.duration}s` : '',
      formatFileSize(item.file.size), detected.ratio ? ratioLabel(detected.ratio) : '',
      languageFor(item) || '语言未识别',
    ].filter(Boolean).join(' · ');
    const nameClass = item.error || item.processError ? 'error' : (naming.ok ? '' : 'missing');
    const el = document.createElement('div');
    el.className = `video-item ${itemClass(item)}`;
    el.innerHTML = `
      <div class="video-main">
        <div class="thumb-placeholder" aria-hidden="true">VID</div>
        <div class="video-content">
          <div class="video-topline">
            <div class="video-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
            <div class="item-index">${index + 1}</div>
          </div>
          <div class="video-meta">${escapeHtml(meta)}</div>
          <div class="generated-name ${nameClass}">${escapeHtml(item.error ? `${item.file.name} · ${item.error}` : (item.processError ? `${nameFor(item)} · ${item.processError}` : nameFor(item)))}</div>
          ${isProcessing(item) ? `<div class="progress-track"><span style="width:${item.progress || 0}%"></span></div>` : ''}
        </div>
        <div class="item-actions">
          <span class="status-chip ${chip.cls}">${escapeHtml(chip.text)}</span>
          <button class="remove-button" type="button" data-remove="${index}" title="移除素材" aria-label="移除素材"${state.processing || state.translating ? ' disabled' : ''}>×</button>
        </div>
      </div>`;
    videoList.appendChild(el);
  });

  if (!visibleCount) {
    videoList.innerHTML = `<div class="empty-preview">${state.files.length ? '当前没有异常素材。' : '还没有素材，请继续添加视频。'}</div>`;
  }
  videoList.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => removeFile(Number(button.dataset.remove)));
  });
  renderSummary();
}

function releaseOutputs() {
  for (const output of state.completedOutputs) URL.revokeObjectURL(output.url);
  state.completedOutputs = [];
  results.innerHTML = '';
  resultPanel.hidden = true;
  updateBatchDownloadState();
}

function invalidateOutputs() {
  releaseOutputs();
  for (const item of state.files) {
    if (item.status === '输出完成' || item.status === '输出失败') {
      item.status = item.detected ? '分析完成' : '等待分析';
      item.progress = 0;
      item.processError = null;
      item.engine = null;
    }
  }
}

function removeFile(index) {
  if (state.processing || state.translating) return;
  invalidateOutputs();
  state.files.splice(index, 1);
  renderVideoList();
  if (!state.files.length) {
    workspace.hidden = true;
    dropZone.hidden = false;
    fileInput.value = '';
  }
}

function clearFiles() {
  if (state.processing || state.translating) return;
  releaseOutputs();
  state.files = [];
  renderVideoList();
  workspace.hidden = true;
  dropZone.hidden = false;
  fileInput.value = '';
}

function defaultHistory() {
  return { product: [], theme: [], maker: ['Niko'], productionTime: [], language: ['en', 'ja', 'zh'] };
}

function mergeHistory(primary = {}, secondary = {}) {
  const merged = defaultHistory();
  for (const key of Object.keys(merged)) {
    const values = [...(primary[key] || []), ...(secondary[key] || []), ...(merged[key] || [])];
    merged[key] = [...new Set(values.map((value) => safePart(value)).filter(Boolean))].slice(0, 30);
  }
  return merged;
}

function readLocalHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function writeLocalHistory(history) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch (_) {}
}

function rememberLocalHistory(values) {
  const next = mergeHistory(state.history, {});
  for (const key of ['product', 'theme', 'maker', 'productionTime', 'language']) {
    const value = safePart(values[key]);
    if (!value) continue;
    next[key] = [value, ...(next[key] || []).filter((item) => item !== value)].slice(0, 30);
  }
  state.history = next;
  writeLocalHistory(next);
  hydrateHistory();
}

function hydrateHistory() {
  const map = {
    product: 'productHistory', theme: 'themeHistory', maker: 'makerHistory',
    productionTime: 'productionTimeHistory', language: 'languageHistory',
  };
  for (const [key, listId] of Object.entries(map)) {
    const list = $(listId);
    list.innerHTML = '';
    for (const value of state.history[key] || []) {
      const option = document.createElement('option');
      option.value = value;
      list.appendChild(option);
    }
  }
}

function loadHistory() {
  state.history = mergeHistory(readLocalHistory(), {});
  writeLocalHistory(state.history);
  hydrateHistory();
  if (!fields.maker.value && state.history.maker?.length) fields.maker.value = state.history.maker[0];
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

function updateThemeTranslateButton(label = '') {
  if (label) {
    translateThemeBtn.textContent = label;
    return;
  }
  const theme = fields.theme.value.trim();
  translateThemeBtn.textContent = theme ? (hasChinese(theme) ? '中 → EN' : 'EN → 中') : '中 ⇄ EN';
}

async function translateTheme() {
  const text = fields.theme.value.trim();
  if (!text) {
    window.alert('请先输入主题 H。');
    return;
  }

  const TranslatorApi = window.Translator;
  if (!TranslatorApi?.create) {
    window.alert('当前浏览器不支持本地中英互译，请使用最新版 Chrome。');
    return;
  }

  const sourceLanguage = hasChinese(text) ? 'zh' : 'en';
  const targetLanguage = sourceLanguage === 'zh' ? 'en' : 'zh';
  const cacheKey = `${sourceLanguage}-${targetLanguage}`;
  state.translating = true;
  syncBusyControls();
  updateThemeTranslateButton('翻译中…');

  try {
    let translator = state.themeTranslators.get(cacheKey);
    if (!translator) {
      translator = await TranslatorApi.create({
        sourceLanguage,
        targetLanguage,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', ({ loaded }) => {
            if (Number.isFinite(loaded)) updateThemeTranslateButton(`模型 ${Math.round(loaded * 100)}%`);
          });
        },
      });
      state.themeTranslators.set(cacheKey, translator);
    }
    const translated = String(await translator.translate(text))
      .trim()
      .replace(/[.!?。！？]+$/g, '');
    if (!translated) throw new Error('翻译结果为空');
    fields.theme.value = translated;
    fields.theme.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (error) {
    window.alert(`主题翻译失败：${error.message || error}`);
  } finally {
    state.translating = false;
    syncBusyControls();
    updateThemeTranslateButton();
  }
}

function readBrowserMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const timeout = window.setTimeout(() => finish(new Error('浏览器读取视频信息超时')), 15000);
    let settled = false;
    function finish(error, data) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(data);
    }
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => finish(null, {
      duration: Number.isFinite(video.duration) && video.duration > 0 ? Math.max(1, Math.round(video.duration)) : '',
      width: Number(video.videoWidth || 0),
      height: Number(video.videoHeight || 0),
    });
    video.onerror = () => finish(new Error('浏览器无法直接读取此格式'));
    video.src = url;
  });
}

async function readMediaBunnyMetadata(file) {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('未找到视频轨道');
    const audio = await input.getPrimaryAudioTrack();
    const tracks = [video, audio].filter(Boolean);
    let duration = await input.getDurationFromMetadata(tracks);
    if (!Number.isFinite(duration) || duration <= 0) duration = await input.computeDuration(tracks);
    const [width, height, taggedLanguage] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      audio ? audio.getLanguageCode() : '',
    ]);
    return {
      duration: Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration)) : '',
      width: Number(width || 0),
      height: Number(height || 0),
      taggedLanguage,
    };
  } finally {
    input.dispose();
  }
}

function updateCompressionProgress(progress) {
  const item = state.files.find((candidate) => candidate.id === state.currentProcessingId);
  if (!item || !Number.isFinite(progress)) return;
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  if (percent === state.lastProgressPercent) return;
  state.lastProgressPercent = percent;
  item.progress = percent;
  item.status = `正在压制 ${percent}%`;
  if (state.activeProcessButton) {
    state.activeProcessButton.textContent = `正在处理 ${state.currentBatchIndex} / ${state.files.length} · ${percent}%`;
  }
  renderVideoList();
}

async function ensureFastEngine() {
  if (state.fastEngineSupported !== null) return state.fastEngineSupported;
  if (state.fastEngineChecking) return state.fastEngineChecking;
  state.fastEngineChecking = (async () => {
    engineStatus.textContent = '正在检测 WebCodecs 极速引擎…';
    engineStatus.className = 'engine-status loading';
    try {
      const isSafari = /Safari/i.test(navigator.userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR)/i.test(navigator.userAgent);
      if (isSafari) {
        state.fastEngineSupported = false;
        engineStatus.textContent = 'Safari 使用 FFmpeg 兼容引擎';
        engineStatus.className = 'engine-status fallback';
        return false;
      }
      const supported = await canEncodeVideo('avc', {
        quality: new Quality('medium'),
        hardwareAcceleration: 'prefer-hardware',
      });
      state.fastEngineSupported = supported;
      engineStatus.textContent = supported ? 'WebCodecs 极速引擎可用' : '将使用 FFmpeg 兼容引擎';
      engineStatus.className = `engine-status ${supported ? 'ready' : 'fallback'}`;
      return supported;
    } catch (error) {
      console.warn('WebCodecs capability check failed', error);
      state.fastEngineSupported = false;
      engineStatus.textContent = '将使用 FFmpeg 兼容引擎';
      engineStatus.className = 'engine-status fallback';
      return false;
    }
  })();
  try {
    return await state.fastEngineChecking;
  } finally {
    state.fastEngineChecking = null;
  }
}

async function ensureFFmpeg() {
  if (state.ffmpeg?.loaded) return state.ffmpeg;
  if (state.ffmpegLoading) return state.ffmpegLoading;
  state.ffmpegLoading = (async () => {
    engineStatus.textContent = '正在加载 FFmpeg 兼容引擎…';
    engineStatus.className = 'engine-status loading';
    const ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      updateCompressionProgress(progress);
    });
    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    await ffmpeg.load({
      coreURL: new URL('ffmpeg/ffmpeg-core.js', base).href,
      wasmURL: new URL('ffmpeg/ffmpeg-core.wasm', base).href,
    });
    state.ffmpeg = ffmpeg;
    engineStatus.textContent = 'FFmpeg 兼容引擎已就绪';
    engineStatus.className = 'engine-status ready';
    return ffmpeg;
  })();
  try {
    return await state.ffmpegLoading;
  } catch (error) {
    state.ffmpegLoading = null;
    engineStatus.textContent = 'FFmpeg 兼容引擎加载失败';
    engineStatus.className = 'engine-status error';
    throw error;
  }
}

async function probeWithFFmpeg(file) {
  const ffmpeg = await ensureFFmpeg();
  const id = crypto.randomUUID();
  const extension = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.bin').toLowerCase();
  const inputPath = `probe-${id}${extension}`;
  const jsonPath = `probe-${id}.json`;
  try {
    await ffmpeg.writeFile(inputPath, await fetchFile(file));
    const code = await ffmpeg.ffprobe([
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
      '-o', jsonPath, inputPath,
    ]);
    if (code !== 0) throw new Error('FFprobe 无法读取此视频');
    const raw = await ffmpeg.readFile(jsonPath);
    const probe = JSON.parse(new TextDecoder().decode(raw));
    const video = (probe.streams || []).find((stream) => stream.codec_type === 'video') || {};
    const audio = (probe.streams || []).find((stream) => stream.codec_type === 'audio') || {};
    const durationRaw = Number(probe.format?.duration || video.duration || 0);
    return {
      duration: durationRaw > 0 ? Math.max(1, Math.round(durationRaw)) : '',
      width: Number(video.width || 0),
      height: Number(video.height || 0),
      taggedLanguage: audio.tags?.language || probe.format?.tags?.language || '',
    };
  } finally {
    await ffmpeg.deleteFile(inputPath).catch(() => {});
    await ffmpeg.deleteFile(jsonPath).catch(() => {});
  }
}

async function addFiles(fileList) {
  if (state.processing || state.translating) return;
  fields.date.value = todayYYMMDD();
  const incoming = [...fileList].filter((file) => file.type.startsWith('video/') || /\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg)$/i.test(file.name));
  if (!incoming.length) return;
  invalidateOutputs();
  const startIndex = state.files.length;
  for (const file of incoming) {
    state.files.push({
      id: crypto.randomUUID(), file, status: '等待分析', detected: null,
      error: null, processError: null, progress: 0,
    });
  }
  dropZone.hidden = true;
  workspace.hidden = false;
  fileInput.value = '';
  renderVideoList();
  for (let i = startIndex; i < state.files.length; i += 1) await analyzeOne(i);
}

async function analyzeOne(index) {
  const item = state.files[index];
  if (!item) return;
  item.status = '正在读取视频信息…';
  renderVideoList();
  try {
    let metadata;
    try {
      metadata = await readBrowserMetadata(item.file);
    } catch (_) {
      try {
        item.status = '正在使用极速引擎分析…';
        renderVideoList();
        metadata = await readMediaBunnyMetadata(item.file);
      } catch (mediaBunnyError) {
        console.warn('Fast metadata reader could not inspect this file', mediaBunnyError);
        item.status = '正在使用兼容引擎分析…';
        renderVideoList();
        metadata = await probeWithFFmpeg(item.file);
      }
    }
    const { duration, width, height, taggedLanguage = '' } = metadata;
    item.detected = {
      date: todayYYMMDD(), duration, width, height,
      resolution: width && height ? `${width}×${height}` : '',
      ratio: ratioCode(width, height),
      language: detectLanguage(item.file.name, taggedLanguage),
    };
    item.status = '分析完成';
    item.error = null;
  } catch (error) {
    item.error = error.message || '分析失败';
    item.status = '分析失败';
  }
  renderVideoList();
}

function validateBeforeProcess(requireNaming) {
  if (!state.files.length) return '请先添加视频素材。';
  if (state.files.some((item) => !item.detected && !item.error)) return '还有素材正在分析，请等待分析完成。';
  const failed = state.files.filter((item) => item.error);
  if (failed.length) return `有 ${failed.length} 个素材分析失败，请先移除或重新添加。`;
  if (requireNaming) {
    const issues = state.files.filter((item) => !namingState(item).ok);
    if (issues.length) return `有 ${issues.length} 个素材命名字段未补全，请先查看黄色提示。`;
  }
  return '';
}

function syncBusyControls() {
  const busy = state.processing || state.translating;
  const controls = [fileInput, clearBtn, addMoreBtn, processBtn, compressOnlyBtn, translateThemeBtn, ...Object.values(fields)];
  for (const control of controls) control.disabled = busy;
  document.querySelectorAll('.preset-card input, .remove-button').forEach((control) => { control.disabled = busy; });
}

function setProcessingControls(processing) {
  state.processing = processing;
  syncBusyControls();
}

function profileFor(preset) {
  return COMPRESSION_PROFILES[preset] || COMPRESSION_PROFILES.standard;
}

async function transcodeWithMediaBunny(item, preset, outputName) {
  const profile = profileFor(preset);
  const input = new Input({
    source: new BlobSource(item.file),
    formats: ALL_FORMATS,
  });
  const target = new BufferTarget();
  const output = new Output({
    target,
    format: new Mp4OutputFormat({ fastStart: false }),
  });
  let conversion = null;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('极速引擎未找到视频轨道');
    if (!await videoTrack.canDecode()) {
      const codec = await videoTrack.getCodec();
      throw new Error(`极速引擎无法解码${codec ? ` ${codec}` : '此视频格式'}`);
    }

    const videoQuality = new Quality(profile.videoQuality);
    const [width, height] = await Promise.all([
      videoTrack.getCodedWidth(),
      videoTrack.getCodedHeight(),
    ]);
    const canEncode = await canEncodeVideo('avc', {
      width,
      height,
      quality: videoQuality,
      hardwareAcceleration: 'prefer-hardware',
    });
    if (!canEncode) throw new Error('极速引擎无法以 H.264 编码此分辨率');

    conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: {
        codec: 'avc',
        quality: videoQuality,
        hardwareAcceleration: 'prefer-hardware',
      },
      audio: async (track) => (
        await track.getCodec() === 'aac'
          ? {}
          : { codec: 'aac', quality: new Quality({ bitrate: profile.audioBitrate }) }
      ),
    });
    if (!conversion.isValid) {
      const reasons = [...new Set(conversion.discardedTracks.map((track) => track.reason))].join(', ');
      throw new Error(`极速引擎不支持此素材${reasons ? `（${reasons}）` : ''}`);
    }
    conversion.onProgress = updateCompressionProgress;
    await conversion.execute();
    if (!target.buffer?.byteLength) throw new Error('极速引擎没有生成有效文件');
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return { outputName, blob, url: URL.createObjectURL(blob), engine: 'webcodecs' };
  } catch (error) {
    if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') {
      await conversion.cancel().catch(() => {});
    }
    throw error;
  } finally {
    input.dispose();
  }
}

async function transcodeWithFFmpeg(ffmpeg, item, preset, outputName) {
  const extension = (item.file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.bin').toLowerCase();
  const inputPath = `input-${item.id}${extension}`;
  const outputPath = `output-${item.id}.mp4`;
  try {
    await ffmpeg.writeFile(inputPath, await fetchFile(item.file));
    const code = await ffmpeg.exec(['-y', '-i', inputPath, ...profileFor(preset).ffmpegArgs, outputPath]);
    if (code !== 0) throw new Error(`FFmpeg 退出码 ${code}`);
    const outputData = await ffmpeg.readFile(outputPath);
    const blob = new Blob([outputData], { type: 'video/mp4' });
    return { outputName, blob, url: URL.createObjectURL(blob), engine: 'ffmpeg' };
  } finally {
    await ffmpeg.deleteFile(inputPath).catch(() => {});
    await ffmpeg.deleteFile(outputPath).catch(() => {});
  }
}

async function processAll(renameOutput) {
  if (state.processing || state.translating) return;
  fields.date.value = todayYYMMDD();
  renderVideoList();
  const invalid = validateBeforeProcess(renameOutput);
  if (invalid) {
    window.alert(invalid);
    return;
  }

  releaseOutputs();
  const preset = document.querySelector('input[name="preset"]:checked')?.value || 'standard';
  const activeButton = renameOutput ? processBtn : compressOnlyBtn;
  const idleLabel = renameOutput ? '批量命名并压制' : '仅压制（保留原名）';
  const compressionNames = renameOutput ? null : compressionOnlyNames();
  state.activeProcessButton = activeButton;
  setProcessingControls(true);
  activeButton.textContent = '正在检测极速引擎…';
  resultPanel.hidden = false;

  const fastEngineAvailable = await ensureFastEngine();
  let ffmpeg = null;
  let usedFastEngine = false;
  let usedFallbackEngine = false;

  for (let i = 0; i < state.files.length; i += 1) {
    const item = state.files[i];
    state.currentProcessingId = item.id;
    state.currentBatchIndex = i + 1;
    state.lastProgressPercent = -1;
    item.progress = 0;
    item.processError = null;
    item.engine = fastEngineAvailable ? 'webcodecs' : 'ffmpeg';
    item.status = '正在压制 0%';
    activeButton.textContent = `正在处理 ${i + 1} / ${state.files.length}`;
    renderVideoList();
    const finalValues = renameOutput ? finalValuesFor(item) : null;
    const outputName = renameOutput ? nameFor(item) : compressionNames.get(item.id);
    try {
      let output = null;
      let fastEngineError = null;
      if (fastEngineAvailable) {
        try {
          output = await transcodeWithMediaBunny(item, preset, outputName);
          usedFastEngine = true;
        } catch (error) {
          fastEngineError = error;
          console.warn(`Fast compression failed for ${item.file.name}; falling back to FFmpeg`, error);
          item.engine = 'ffmpeg';
          item.progress = 0;
          item.status = '正在压制 0%';
          state.lastProgressPercent = -1;
          activeButton.textContent = `正在切换兼容引擎 ${i + 1} / ${state.files.length}`;
          engineStatus.textContent = '正在切换 FFmpeg 兼容引擎…';
          engineStatus.className = 'engine-status loading';
          renderVideoList();
        }
      }
      if (!output) {
        ffmpeg ||= await ensureFFmpeg();
        output = await transcodeWithFFmpeg(ffmpeg, item, preset, outputName);
        if (fastEngineError) output.fallbackReason = fastEngineError.message || String(fastEngineError);
        usedFallbackEngine = true;
      }
      item.engine = output.engine;
      item.status = '输出完成';
      item.progress = 100;
      item.processError = null;
      if (renameOutput) rememberLocalHistory(finalValues);
      state.completedOutputs.push(output);
      appendResult(output);
      updateBatchDownloadState();
    } catch (error) {
      item.status = '输出失败';
      item.processError = error.message || '处理失败';
      appendResult({ outputName: item.file.name }, item.processError);
    }
    renderVideoList();
  }

  state.currentProcessingId = null;
  state.currentBatchIndex = 0;
  state.activeProcessButton = null;
  setProcessingControls(false);
  activeButton.textContent = idleLabel;
  if (usedFastEngine && usedFallbackEngine) {
    engineStatus.textContent = '双引擎已就绪';
    engineStatus.className = 'engine-status ready';
  } else if (usedFastEngine) {
    engineStatus.textContent = 'WebCodecs 极速引擎已就绪';
    engineStatus.className = 'engine-status ready';
  } else if (usedFallbackEngine) {
    engineStatus.textContent = 'FFmpeg 兼容引擎已就绪';
    engineStatus.className = 'engine-status fallback';
  }
  updateThemeTranslateButton();
}

function updateBatchDownloadState() {
  const count = state.completedOutputs.length;
  batchDownloadBtn.disabled = count === 0;
  batchDownloadMeta.textContent = count ? `已完成 ${count} 个文件，可打包为 ZIP 下载` : '压制完成后可一次下载全部成功文件';
}

function triggerDownload(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadBatchZip() {
  if (!state.completedOutputs.length) return;
  batchDownloadBtn.disabled = true;
  const originalText = batchDownloadBtn.textContent;
  batchDownloadBtn.textContent = '正在打包 ZIP…';
  try {
    const zip = new JSZip();
    for (const output of state.completedOutputs) zip.file(output.outputName, output.blob, { compression: 'STORE' });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, ({ percent }) => {
      batchDownloadBtn.textContent = `正在打包 ${Math.round(percent)}%`;
    });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${todayYYMMDD()}_batch_${state.completedOutputs.length}files.zip`);
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    window.alert(error.message || '打包下载失败');
  } finally {
    batchDownloadBtn.textContent = originalText;
    updateBatchDownloadState();
  }
}

function appendResult(output, error = '') {
  const el = document.createElement('div');
  el.className = `result-item${error ? ' error' : ''}`;
  const engineLabel = output.engine === 'webcodecs' ? 'WebCodecs 极速' : 'FFmpeg 兼容';
  el.innerHTML = error
    ? `<div class="result-name">${escapeHtml(`${output.outputName} · ${error}`)}</div>`
    : `<div class="result-main"><div class="result-name">${escapeHtml(output.outputName)}</div><div class="result-meta ${output.engine === 'webcodecs' ? 'fast' : 'fallback'}">${engineLabel}</div></div><button class="download-button" type="button">下载</button>`;
  if (!error) el.querySelector('button').addEventListener('click', () => triggerDownload(output.url, output.outputName));
  results.appendChild(el);
}

$('chooseBtn').addEventListener('click', () => fileInput.click());
addMoreBtn.addEventListener('click', () => fileInput.click());
clearBtn.addEventListener('click', clearFiles);
fileInput.addEventListener('change', (event) => addFiles(event.target.files));
['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
dropZone.addEventListener('click', (event) => {
  if (!event.target.closest('button')) fileInput.click();
});

for (const [key, input] of Object.entries(fields)) {
  if (['date', 'duration', 'ratio'].includes(key)) continue;
  input.addEventListener('input', () => {
    invalidateOutputs();
    if (key === 'theme') updateThemeTranslateButton();
    renderVideoList();
  });
}

onlyIssues.addEventListener('change', () => {
  state.onlyIssues = onlyIssues.checked;
  renderVideoList();
});

document.querySelectorAll('.preset-card input').forEach((input) => {
  input.addEventListener('change', () => {
    document.querySelectorAll('.preset-card').forEach((card) => card.classList.toggle('active', card.querySelector('input').checked));
  });
});

translateThemeBtn.addEventListener('click', translateTheme);
processBtn.addEventListener('click', () => processAll(true));
compressOnlyBtn.addEventListener('click', () => processAll(false));
batchDownloadBtn.addEventListener('click', downloadBatchZip);
window.addEventListener('beforeunload', () => {
  releaseOutputs();
  for (const translator of state.themeTranslators.values()) translator.destroy?.();
});

loadHistory();
updateThemeTranslateButton();
updateBatchDownloadState();
renderVideoList();
