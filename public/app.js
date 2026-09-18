const state = {
  files: [],
  history: {},
  onlyIssues: false,
  completedOutputs: [],
};

const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const workspace = $('workspace');
const videoList = $('videoList');
const analysisStatus = $('analysisStatus');
const processBtn = $('processBtn');
const results = $('results');
const resultPanel = $('resultPanel');
const onlyIssues = $('onlyIssues');
const fileCount = $('fileCount');
const previewSummary = $('previewSummary');
const batchDownloadBtn = $('batchDownloadBtn');
const batchDownloadMeta = $('batchDownloadMeta');
const HISTORY_STORAGE_KEY = 'mediaNamingCompressor.history.v1';

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
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function formatFileSize(size) {
  if (!Number.isFinite(size)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  const digits = i >= 2 ? 1 : 0;
  return `${n.toFixed(digits)}${units[i]}`;
}

function ratioLabel(code) {
  const raw = String(code || '');
  const known = {
    '916': '9:16', '169': '16:9', '11': '1:1', '45': '4:5', '54': '5:4',
    '34': '3:4', '43': '4:3', '23': '2:3', '32': '3:2', '919': '9:19',
    '199': '19:9', '920': '9:20', '209': '20:9'
  };
  return known[raw] || raw;
}

function languageFor(item) {
  const override = safePart(fields.language.value);
  return override || safePart(item?.detected?.language);
}

function valuesFor(item) {
  const d = item?.detected || {};
  return {
    date: safePart(fields.date.value || todayYYMMDD()),
    product: safePart(fields.product.value),
    theme: safePart(fields.theme.value),
    duration: safePart(d.duration),
    ratio: safePart(d.ratio),
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
    language: '语言', maker: '制作人', productionTime: '制作时长'
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => labels[key]);
  return { ok: missing.length === 0, missing };
}

function themeKey(item) {
  if (!item) return '';
  return safePart(valuesFor(item).theme).toLowerCase();
}

function duplicateSequence(item) {
  if (!item) return '';
  const key = themeKey(item);
  if (!key) return '';
  const duplicates = state.files.filter((candidate) => themeKey(candidate) === key);
  if (duplicates.length <= 1) return '';
  const position = duplicates.indexOf(item);
  if (position < 0) return '';
  return String(position + 1).padStart(2, '0');
}

function finalValuesFor(item) {
  const values = valuesFor(item);
  const seq = duplicateSequence(item);
  if (seq && values.theme) values.theme = `${values.theme}-${seq}`;
  return values;
}

function nameFor(item) {
  if (!item) return '—';
  const values = finalValuesFor(item);
  return `${values.date || '日期'}_P-${values.product || '产品'}_H-${values.theme || '主题'}_VL-S-${values.duration || '时长'}_S-${values.ratio || '尺寸'}_L-${values.language || '语言'}_D-${values.maker || '制作人'}_M-${values.productionTime || '制作时长'}.mp4`;
}

function itemClass(item) {
  if (item.error || item.processError || item.status === '输出失败') return 'failed';
  if (item.status === '正在压制输出…') return 'processing';
  if (item.status === '输出完成') return 'done';
  return namingState(item).ok ? 'ready' : 'issue';
}

function statusChip(item) {
  if (item.error || item.processError || item.status === '输出失败') return { text: '异常', cls: 'error' };
  if (item.status === '正在压制输出…') return { text: '压制中', cls: '' };
  if (item.status === '输出完成') return { text: '已输出', cls: 'ok' };
  if (!item.detected) return { text: '分析中', cls: '' };
  const ns = namingState(item);
  return ns.ok ? { text: '通过', cls: 'ok' } : { text: `缺 ${ns.missing.join('/')}`, cls: 'warn' };
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
    const ns = namingState(item);
    if (state.onlyIssues && ns.ok && !item.error) return;
    visibleCount += 1;
    const d = item.detected || {};
    const chip = statusChip(item);
    const meta = [
      '视频',
      d.resolution || '读取中',
      d.duration ? `${d.duration}s` : '',
      formatFileSize(item.file.size),
      d.ratio ? ratioLabel(d.ratio) : '',
      languageFor(item) ? languageFor(item) : '语言未识别',
    ].filter(Boolean).join(' · ');
    const nameClass = (item.error || item.processError) ? 'error' : (ns.ok ? '' : 'missing');
    const el = document.createElement('div');
    el.className = `video-item ${itemClass(item)}`;
    el.innerHTML = `
      <div class="video-main">
        <div class="thumb-placeholder">▶</div>
        <div class="video-content">
          <div class="video-topline">
            <div class="video-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
            <div class="item-index">${index + 1}</div>
          </div>
          <div class="video-meta">${escapeHtml(meta)}</div>
          <div class="generated-name ${nameClass}">${escapeHtml(item.error ? `${item.file.name} · ${item.error}` : (item.processError ? `${nameFor(item)} · ${item.processError}` : nameFor(item)))}</div>
        </div>
        <div class="item-actions">
          <span class="status-chip ${chip.cls}">${escapeHtml(chip.text)}</span>
          <button class="remove-button" type="button" data-remove="${index}" title="移除素材">×</button>
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

function removeFile(index) {
  state.files.splice(index, 1);
  renderVideoList();
  if (!state.files.length) {
    workspace.hidden = true;
    dropZone.hidden = false;
    fileInput.value = '';
  }
}

function clearFiles() {
  state.files = [];
  renderVideoList();
  workspace.hidden = true;
  dropZone.hidden = false;
  fileInput.value = '';
  resultPanel.hidden = true;
  results.innerHTML = '';
  state.completedOutputs = [];
  updateBatchDownloadState();
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
  const keys = ['product', 'theme', 'maker', 'productionTime', 'language'];
  for (const key of keys) {
    const value = safePart(values[key]);
    if (!value) continue;
    next[key] = [value, ...(next[key] || []).filter((item) => item !== value)].slice(0, 30);
  }
  state.history = next;
  writeLocalHistory(next);
  hydrateHistory();
}

async function loadHistory() {
  const local = readLocalHistory();
  let server = {};
  try {
    const res = await fetch('/api/history');
    if (res.ok) server = await res.json();
  } catch (_) {}
  state.history = mergeHistory(local, server);
  writeLocalHistory(state.history);
  hydrateHistory();
  if (!fields.maker.value && state.history.maker?.length) fields.maker.value = state.history.maker[0];
  renderVideoList();
}

function hydrateHistory() {
  const map = {
    product: 'productHistory',
    theme: 'themeHistory',
    maker: 'makerHistory',
    productionTime: 'productionTimeHistory',
    language: 'languageHistory',
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

async function addFiles(fileList) {
  fields.date.value = todayYYMMDD();
  const incoming = [...fileList].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg)$/i.test(f.name));
  if (!incoming.length) return;
  const startIndex = state.files.length;
  for (const file of incoming) {
    state.files.push({ file, status: '等待分析', detected: null, token: null, error: null, processError: null });
  }
  dropZone.hidden = true;
  workspace.hidden = false;
  fileInput.value = '';
  renderVideoList();

  for (let i = startIndex; i < state.files.length; i += 1) {
    await analyzeOne(i);
  }
}

async function analyzeOne(index) {
  const item = state.files[index];
  if (!item) return;
  item.status = '正在读取视频信息…';
  renderVideoList();
  const fd = new FormData();
  fd.append('video', item.file, item.file.name);
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '分析失败');
    item.token = data.token;
    item.detected = data.detected;
    item.status = '分析完成';
    item.error = null;
  } catch (err) {
    item.error = err.message;
    item.status = '分析失败';
  }
  renderVideoList();
}

function validateBeforeProcess() {
  if (!state.files.length) return '请先添加视频素材。';
  const analyzing = state.files.some((item) => !item.detected && !item.error);
  if (analyzing) return '还有素材正在分析，请等待分析完成。';
  const failed = state.files.filter((item) => item.error);
  if (failed.length) return `有 ${failed.length} 个素材分析失败，请先移除或重新添加。`;
  const issues = state.files.filter((item) => !namingState(item).ok);
  if (issues.length) return `有 ${issues.length} 个素材命名字段未补全，请先查看黄色提示。`;
  return '';
}

async function processAll() {
  fields.date.value = todayYYMMDD();
  state.completedOutputs = [];
  updateBatchDownloadState();
  renderVideoList();
  const invalid = validateBeforeProcess();
  if (invalid) {
    alert(invalid);
    return;
  }
  const preset = document.querySelector('input[name="preset"]:checked')?.value || 'standard';
  processBtn.disabled = true;
  processBtn.textContent = '正在批量压制…';
  resultPanel.hidden = false;
  results.innerHTML = '';

  for (let i = 0; i < state.files.length; i += 1) {
    const item = state.files[i];
    item.status = '正在压制输出…';
    renderVideoList();
    const d = item.detected;
    const finalValues = finalValuesFor(item);
    const payload = {
      token: item.token,
      preset,
      date: fields.date.value || todayYYMMDD(),
      product: finalValues.product,
      theme: finalValues.theme,
      duration: d.duration,
      ratio: d.ratio,
      language: finalValues.language,
      maker: finalValues.maker,
      productionTime: finalValues.productionTime,
    };
    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '处理失败');
      item.status = '输出完成';
      item.processError = null;
      rememberLocalHistory(finalValues);
      state.completedOutputs.push({ token: data.outputToken, outputName: data.outputName });
      updateBatchDownloadState();
      appendResult(data.outputName, data.downloadUrl);
    } catch (err) {
      item.status = '输出失败';
      item.processError = err.message;
      appendResult(item.file.name, null, err.message);
    }
    renderVideoList();
  }

  processBtn.disabled = false;
  processBtn.textContent = '批量命名并压制输出';
}


function updateBatchDownloadState() {
  if (!batchDownloadBtn || !batchDownloadMeta) return;
  const count = state.completedOutputs.length;
  batchDownloadBtn.disabled = count === 0;
  batchDownloadMeta.textContent = count ? `已完成 ${count} 个文件，可打包为 ZIP 下载` : '压制完成后可一次下载全部成功文件';
}

async function downloadBatchZip() {
  if (!state.completedOutputs.length) return;
  batchDownloadBtn.disabled = true;
  const originalText = batchDownloadBtn.textContent;
  batchDownloadBtn.textContent = '正在准备 ZIP…';
  try {
    const res = await fetch('/api/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputTokens: state.completedOutputs.map((item) => item.token) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '打包失败');
    const a = document.createElement('a');
    a.href = data.downloadUrl;
    a.download = data.archiveName || '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    alert(err.message || '打包下载失败');
  } finally {
    batchDownloadBtn.textContent = originalText;
    updateBatchDownloadState();
  }
}

function appendResult(name, url, error) {
  const el = document.createElement('div');
  el.className = `result-item${error ? ' error' : ''}`;
  el.innerHTML = `<div class="result-name">${escapeHtml(error ? `${name} · ${error}` : name)}</div>${url ? `<a href="${url}" download>下载</a>` : ''}`;
  results.appendChild(el);
}

$('chooseBtn').addEventListener('click', () => fileInput.click());
$('addMoreBtn').addEventListener('click', () => fileInput.click());
$('clearBtn').addEventListener('click', clearFiles);
fileInput.addEventListener('change', (e) => addFiles(e.target.files));
['dragenter', 'dragover'].forEach((evt) => dropZone.addEventListener(evt, (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((evt) => dropZone.addEventListener(evt, (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  fileInput.click();
});

for (const [key, input] of Object.entries(fields)) {
  if (['date', 'duration', 'ratio'].includes(key)) continue;
  input.addEventListener('input', renderVideoList);
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

processBtn.addEventListener('click', processAll);
if (batchDownloadBtn) batchDownloadBtn.addEventListener('click', downloadBatchZip);
updateBatchDownloadState();
loadHistory();
renderVideoList();
