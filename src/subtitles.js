import { fetchFile } from '@ffmpeg/util';
import { cuesFromWords, hardCutCues } from './caption-timing.js';

const $ = (id) => document.getElementById(id);
const fileInput = $('subtitleFile');
const video = $('subtitleVideo');
const videoFrame = $('subtitleVideoFrame');
const previewCanvas = $('subtitlePreviewCanvas');
const dropZone = $('subtitleDropZone');
const editor = $('subtitleEditor');
const cuesInput = $('subtitleCues');
const cueList = $('subtitleCueList');
const timelineViewport = $('subtitleTimelineViewport');
const timelineContent = $('subtitleTimelineContent');
const timelineRuler = $('subtitleTimelineRuler');
const playhead = $('subtitlePlayhead');
const snapGuide = $('subtitleSnapGuide');
const addCueButton = $('subtitleAddCue');
const deleteCueButton = $('subtitleDeleteCue');
const status = $('subtitleStatus');
const transcribeButton = $('transcribeBtn');
const transcribeAllButton = $('transcribeAllBtn');
const exportButton = $('subtitleExportBtn');
const namedButton = $('subtitleNameExportBtn');
const batchExportButton = $('subtitleBatchExportBtn');
const batchSendButton = $('subtitleBatchSendBtn');
const styleControls = {
  fontFamily: $('subtitleFontFamily'),
  fontSize: $('subtitleFontSize'),
  textColor: $('subtitleTextColor'),
  outlineColor: $('subtitleOutlineColor'),
  outline: $('subtitleOutline'),
  positionX: $('subtitlePositionX'),
  positionY: $('subtitlePositionY'),
  boxColor: $('subtitleBoxColor'),
  boxOpacity: $('subtitleBoxOpacity'),
};
const styleResetButton = $('subtitleStyleReset');
const boldButton = $('subtitleBold');
const alignButtons = [...document.querySelectorAll('[data-align]')];
const centerButton = $('subtitleCenter');
const bottomCenterButton = $('subtitleBottomCenter');
let sourceUrl;
let transcriberLoading;
let busy = false;
let selectedFile = null;
let currentStyle = 'classic';
let currentOptions = defaultCaptionOptions(currentStyle);
const items = [];
let activeIndex = -1;
let selectedCueIndex = -1;
let timelineZoom = 1;
let timelineScale = 80;

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function nearestSnap(seconds, targets, scale) {
  const threshold = 10 / scale;
  let closest = null;
  for (const target of targets) {
    const distance = Math.abs(seconds - target);
    if (distance <= threshold && (!closest || distance < closest.distance)) closest = { time: target, distance };
  }
  return closest;
}
function timelineTickStep(duration, scale) {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((step) => duration / step <= 200 && step * scale >= 70) || 600;
}
function formatTime(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}.${String(Math.floor(safe * 100) % 100).padStart(2, '0')}`;
}
function serializeCues(cues) { return cues.map((cue) => `${cue.start.toFixed(2)} | ${cue.end.toFixed(2)} | ${cue.text.trim()}`).join('\n'); }

function defaultCaptionOptions(style) {
  return {
    fontFamily: 'sans',
    bold: true,
    textAlign: 'center',
    fontSize: 100,
    textColor: style === 'yellow' ? '#ffe547' : '#ffffff',
    outlineColor: '#111111',
    outline: style === 'boxed' ? 0 : 13,
    positionX: 50,
    positionY: 85,
    boxColor: '#000000',
    boxOpacity: 80,
  };
}

function setStatus(message) { status.textContent = message; }
function setBusy(value) {
  busy = value;
  for (const element of [fileInput, exportButton, namedButton, cuesInput, addCueButton, deleteCueButton, $('subtitleZoomIn'), $('subtitleZoomOut'), styleResetButton, centerButton, bottomCenterButton, boldButton, ...alignButtons, ...Object.values(styleControls), ...document.querySelectorAll('.subtitle-style-card')]) element.disabled = value;
  exportButton.disabled = value || !selectedFile || !items[activeIndex]?.cuesText.trim();
  namedButton.disabled = exportButton.disabled;
  transcribeButton.disabled = value || !selectedFile;
  transcribeAllButton.disabled = value || !items.length;
  const hasCues = items.some((item) => item.cuesText.trim());
  batchExportButton.disabled = value || !hasCues;
  batchSendButton.disabled = value || !hasCues;
  dropZone.classList.toggle('busy', value);
  if (!value) {
    addCueButton.disabled = !selectedFile;
    deleteCueButton.disabled = selectedCueIndex < 0;
  }
  cueList.querySelectorAll('button,input').forEach((element) => { element.disabled = value; });
}

function parseCues(value = cuesInput.value) {
  return value.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    const match = line.match(/^\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(.+?)\s*$/);
    if (!match) throw new Error(`第 ${index + 1} 行格式有误，请使用「开始秒数 | 结束秒数 | 文字」。`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error(`第 ${index + 1} 行时间有误。`);
    return { start, end, text: match[3] };
  });
}

function captionFontSize(width, height, options) {
  return Math.max(12, Math.round(Math.max(20, Math.min(width * 0.052, height * 0.064)) * options.fontSize / 100));
}

function captionBandHeight(width, height, options) {
  return Math.min(height, Math.max(44, Math.round(height * 0.22 * options.fontSize / 100), Math.round(captionFontSize(width, height, options) * 3.5)));
}

function captionY(height, bandHeight, positionY) {
  return clamp(Math.round(height * positionY / 100 - bandHeight / 2), 0, height - bandHeight);
}

function hexRgba(hex, opacity) {
  const values = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${values.join(',')},${opacity / 100})`;
}

function drawCaption(context, cue, width, height, bandHeight, style, options) {
  const fontSize = captionFontSize(width, height, options);
  const families = { sans: 'Arial, "Microsoft YaHei", sans-serif', serif: 'Georgia, "SimSun", serif', mono: 'Consolas, "Microsoft YaHei", monospace' };
  context.font = `${options.bold ? 800 : 400} ${fontSize}px ${families[options.fontFamily] || families.sans}`;
  context.textAlign = options.textAlign || 'center';
  context.textBaseline = 'middle';
  const centerX = width * options.positionX / 100;
  const maxWidth = Math.max(width * 0.16, Math.min(width * 0.88, 2 * Math.min(centerX, width - centerX) - width * 0.04));
  const textX = centerX + (context.textAlign === 'left' ? -maxWidth / 2 : context.textAlign === 'right' ? maxWidth / 2 : 0);
  const chunks = cue.text.match(/[A-Za-z0-9]+(?:['’._-][A-Za-z0-9]+)*\s*|./gu) || [];
  const lines = [];
  let line = '';
  for (const chunk of chunks) {
    if (context.measureText(line + chunk).width > maxWidth && line) { lines.push(line.trimEnd()); line = ''; }
    line += chunk.trimStart();
  }
  if (line) lines.push(line.trimEnd());
  const visibleLines = lines.slice(0, 3);
  const lineHeight = fontSize * 1.22;
  const top = Math.max(fontSize / 2 + 4, (bandHeight - visibleLines.length * lineHeight) / 2 + lineHeight / 2);
  if (style === 'boxed') {
    context.fillStyle = hexRgba(options.boxColor, options.boxOpacity);
    const textWidth = Math.min(maxWidth, Math.max(...visibleLines.map((text) => context.measureText(text).width), 0));
    const boxWidth = Math.min(width, textWidth + fontSize * 0.8);
    context.fillRect(clamp(centerX - boxWidth / 2, 0, width - boxWidth), Math.max(0, top - lineHeight * 0.65), boxWidth, Math.min(bandHeight, visibleLines.length * lineHeight + 14));
  }
  visibleLines.forEach((text, index) => {
    const y = top + index * lineHeight;
    context.lineWidth = fontSize * options.outline / 100;
    context.strokeStyle = options.outlineColor;
    context.lineJoin = 'round';
    if (options.outline > 0) context.strokeText(text, textX, y, maxWidth);
    context.fillStyle = options.textColor;
    context.fillText(text, textX, y, maxWidth);
  });
}

async function canvasPng(cue, width, height, style, options) {
  const bandHeight = captionBandHeight(width, height, options);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = bandHeight;
  drawCaption(canvas.getContext('2d'), cue, width, height, bandHeight, style, options);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('字幕图片生成失败')), 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), bandHeight };
}

async function getAudio(ffmpeg, file) {
  const input = `asr-input-${crypto.randomUUID()}${file.name.match(/\.[^.]+$/)?.[0] || '.mp4'}`;
  const audio = `asr-${crypto.randomUUID()}.wav`;
  try {
    await ffmpeg.writeFile(input, await fetchFile(file));
    const code = await ffmpeg.exec(['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', audio]);
    if (code !== 0) throw new Error('无法从视频中提取音频。');
    const wav = await ffmpeg.readFile(audio);
    const context = new AudioContext({ sampleRate: 16000 });
    try {
      const decoded = await context.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
      return decoded.getChannelData(0).slice();
    } finally { await context.close(); }
  } finally {
    await ffmpeg.deleteFile(input).catch(() => {});
    await ffmpeg.deleteFile(audio).catch(() => {});
  }
}

async function burnCues(ffmpeg, file, cues, style, options, width = video.videoWidth, height = video.videoHeight) {
  if (!width || !height) throw new Error('无法读取视频尺寸。');
  cues = hardCutCues(cues);
  if (!cues.length) throw new Error('没有可导出的字幕。');
  const prefix = `caption-${crypto.randomUUID()}`;
  const input = `${prefix}-source${file.name.match(/\.[^.]+$/)?.[0] || '.mp4'}`;
  const output = `${prefix}-output.mp4`;
  const paths = [];
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 12) log.shift(); };
  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.writeFile(input, await fetchFile(file));
    const args = ['-y', '-i', input];
    let bandHeight = 0;
    for (let i = 0; i < cues.length; i += 1) {
      const png = await canvasPng(cues[i], width, height, style, options);
      bandHeight = png.bandHeight;
      const path = `${prefix}-${i}.png`;
      paths.push(path);
      await ffmpeg.writeFile(path, png.bytes);
      args.push('-i', path);
    }
    const filters = cues.map((cue, i) => {
      const before = i ? `[v${i}]` : '[0:v]';
      const after = `[v${i + 1}]`;
      return `${before}[${i + 1}:v]overlay=0:${captionY(height, bandHeight, options.positionY)}:enable='gte(t,${cue.start})*lt(t,${cue.end})':eof_action=repeat${after}`;
    }).join(';');
    args.push('-filter_complex', filters, '-map', `[v${cues.length}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output);
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      console.error('字幕合成 FFmpeg 日志', log.join('\n'));
      throw new Error(`字幕合成失败：${log.slice(-8).join(' ').slice(0, 900) || `FFmpeg 退出码 ${code}`}`);
    }
    const bytes = await ffmpeg.readFile(output);
    return new Blob([bytes], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('log', onLog);
    for (const path of [input, output, ...paths]) await ffmpeg.deleteFile(path).catch(() => {});
  }
}

export function setupSubtitles({ ensureFFmpeg, onExport, onBatchExport, onBatchSend }) {
  function syncStyleControls() {
    for (const [name, control] of Object.entries(styleControls)) control.value = currentOptions[name];
    $('subtitleFontSizeValue').textContent = `${currentOptions.fontSize}%`;
    const previewWidth = video.videoWidth || 1920;
    const previewHeight = video.videoHeight || 1080;
    $('subtitleOutlineValue').textContent = `${Math.round(captionFontSize(previewWidth, previewHeight, currentOptions) * currentOptions.outline / 100)} px`;
    $('subtitleBoxOpacityValue').textContent = `${currentOptions.boxOpacity}%`;
    $('subtitlePositionXValue').textContent = `${currentOptions.positionX}%`;
    $('subtitlePositionYValue').textContent = `${currentOptions.positionY}%`;
    boldButton.setAttribute('aria-pressed', String(currentOptions.bold));
    alignButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.align === currentOptions.textAlign)));
    centerButton.setAttribute('aria-pressed', String(currentOptions.positionX === 50 && currentOptions.positionY === 50));
    bottomCenterButton.setAttribute('aria-pressed', String(currentOptions.positionX === 50 && currentOptions.positionY === 85));
    $('subtitleBoxProperties').hidden = currentStyle !== 'boxed';
  }

  function saveStyleOptions() {
    if (activeIndex >= 0) items[activeIndex].options = { ...currentOptions };
    syncStyleControls();
    updatePreview();
  }

  function renderBatchList() {
    $('subtitleBatchCount').textContent = `${items.length} 个视频`;
    const list = $('subtitleBatchList');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'subtitle-queue-empty';
      empty.textContent = '添加视频后，在这里选择要预览和校对的文件。';
      list.appendChild(empty);
    }
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'subtitle-queue-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `subtitle-batch-item${index === activeIndex ? ' active' : ''}${item.error ? ' error' : ''}`;
      button.disabled = busy;
      const name = document.createElement('strong');
      name.textContent = `${index + 1}. ${item.file.name}`;
      const detail = document.createElement('span');
      detail.textContent = item.error || item.status;
      button.append(name, detail);
      button.addEventListener('click', () => { if (!busy) activateItem(index).catch((error) => setStatus(error.message)); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'subtitle-remove-button';
      remove.textContent = '×';
      remove.title = `移除 ${item.file.name}`;
      remove.setAttribute('aria-label', remove.title);
      remove.disabled = busy;
      remove.addEventListener('click', () => removeItem(index));
      row.append(button, remove);
      list.appendChild(row);
    });
  }

  function removeItem(index) {
    if (busy || !items[index]) return;
    const wasActive = index === activeIndex;
    items.splice(index, 1);
    if (!items.length) {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      sourceUrl = undefined;
      activeIndex = -1;
      selectedCueIndex = -1;
      selectedFile = null;
      cuesInput.value = '';
      editor.hidden = true;
      $('subtitleEditorEmpty').hidden = false;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.hidden = true;
      previewCanvas.hidden = true;
      $('subtitlePreviewEmpty').hidden = false;
      $('subtitleActiveName').textContent = '选一个视频开始预览';
      $('subtitlePreviewStatus').textContent = '上传视频后可预览';
      $('subtitleFileName').textContent = '支持 MP4、MOV、MKV、WebM、AVI';
      setStatus('等待视频');
      cueList.replaceChildren();
      timelineRuler.replaceChildren();
      deleteCueButton.disabled = true;
      addCueButton.disabled = true;
    } else if (wasActive) {
      activeIndex = -1;
      activateItem(Math.min(index, items.length - 1)).catch((error) => setStatus(error.message));
    } else if (index < activeIndex) {
      activeIndex -= 1;
    }
    if (items.length) {
      $('subtitleFileName').textContent = `${items.length} 个视频已加入队列`;
      setStatus(`${items.length} 个视频已就绪`);
    }
    renderBatchList();
    setBusy(false);
  }

  function activateItem(index) {
    const item = items[index];
    if (!item) return Promise.reject(new Error('视频不存在。'));
    if (activeIndex === index && video.videoWidth && selectedFile === item.file) return Promise.resolve();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    activeIndex = index;
    selectedCueIndex = -1;
    selectedFile = item.file;
    currentStyle = item.style;
    currentOptions = { ...item.options };
    syncStyleControls();
    sourceUrl = URL.createObjectURL(item.file);
    cuesInput.value = item.cuesText;
    editor.hidden = !item.cuesText.trim();
    $('subtitleEditorEmpty').hidden = !editor.hidden;
    $('subtitleActiveName').textContent = item.file.name;
    $('subtitlePreviewEmpty').hidden = true;
    video.hidden = false;
    previewCanvas.hidden = false;
    document.querySelectorAll('.subtitle-style-card').forEach((card) => {
      const active = card.dataset.style === currentStyle;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', String(active));
    });
    renderBatchList();
    renderTimeline();
    exportButton.disabled = busy || !item.cuesText.trim();
    namedButton.disabled = exportButton.disabled;
    const ready = new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error(`浏览器无法预览 ${item.file.name}`)), { once: true });
    });
    video.src = sourceUrl;
    video.load();
    return ready;
  }

  function addFiles(fileList) {
    if (busy) return;
    const incoming = [...fileList].filter((file) => file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name));
    if (!incoming.length) { setStatus('请选择视频文件'); return; }
    for (const file of incoming) {
      items.push({ file, cuesText: '', style: currentStyle, options: { ...currentOptions }, status: '待识别', error: '' });
    }
    $('subtitleFileName').textContent = `${items.length} 个视频已加入队列`;
    setStatus(`${items.length} 个视频已就绪`);
    if (activeIndex < 0 && items.length) activateItem(0).catch((error) => setStatus(error.message));
    renderBatchList();
    setBusy(false);
  }

  async function transcribeItem(item, index) {
    item.status = `正在识别 ${index + 1}/${items.length}`;
    item.error = '';
    renderBatchList();
    if (!transcriberLoading) {
      setStatus('正在加载语音模型…');
      transcriberLoading = import('@huggingface/transformers')
        .then(({ pipeline }) => pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { dtype: 'q8' }))
        .catch((error) => { transcriberLoading = null; throw error; });
    }
    // Model loading and audio extraction are independent and can run together.
    const audioLoading = ensureFFmpeg().then((ffmpeg) => getAudio(ffmpeg, item.file));
    const [audio, transcriber] = await Promise.all([audioLoading, transcriberLoading]);
    setStatus(`正在识别 ${index + 1}/${items.length}：${item.file.name}`);
    const result = await transcriber(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 2 });
    const cues = cuesFromWords(result.chunks || []);
    if (!cues.length) throw new Error('没有识别到可用的语音字幕。');
    item.cuesText = serializeCues(cues);
    item.status = `已生成 ${cues.length} 条字幕`;
    if (activeIndex === index) {
      cuesInput.value = item.cuesText;
      editor.hidden = false;
      $('subtitleEditorEmpty').hidden = true;
      renderTimeline();
      video.currentTime = cues[0].start;
      updatePreview();
    }
    renderBatchList();
  }

  function updatePreview() {
    if (!video.videoWidth || !video.videoHeight || !selectedFile) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (previewCanvas.width !== width || previewCanvas.height !== height) {
      previewCanvas.width = width;
      previewCanvas.height = height;
    }
    const context = previewCanvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    let cues = [];
    try { cues = parseCues(); } catch { $('subtitlePreviewStatus').textContent = '字幕格式需检查'; return; }
    const displayCues = hardCutCues(cues);
    const cue = displayCues.find((entry) => video.currentTime >= entry.start && video.currentTime < entry.end)
      || (editor.hidden ? { text: '字幕效果预览' } : null);
    const activeIndex = cue && !editor.hidden ? cues.findIndex((entry) => entry.start === cue.start && entry.text === cue.text) : -1;
    if (cue) {
      const bandHeight = captionBandHeight(width, height, currentOptions);
      const y = captionY(height, bandHeight, currentOptions.positionY);
      context.save();
      context.translate(0, y);
      drawCaption(context, cue, width, height, bandHeight, currentStyle, currentOptions);
      context.restore();
    }
    cueList.querySelectorAll('.subtitle-cue-clip').forEach((clip, index) => clip.classList.toggle('active', index === activeIndex));
    playhead.style.left = `${54 + Math.max(0, video.currentTime) * timelineScale}px`;
    $('subtitleTimecode').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    $('subtitlePreviewStatus').textContent = editor.hidden ? '样式预览' : `${cues.length} 条字幕 · 播放或拖动进度查看`;
  }

  function timelineDuration(cues = []) {
    return Math.max(0.1, Number.isFinite(video.duration) ? video.duration : 0, ...cues.map((cue) => cue.end));
  }

  function saveCues(cues) {
    cuesInput.value = serializeCues(cues);
    if (activeIndex >= 0) {
      items[activeIndex].cuesText = cuesInput.value;
      items[activeIndex].status = '字幕已修改';
    }
    editor.hidden = !cues.length;
    $('subtitleEditorEmpty').hidden = !!cues.length;
    renderBatchList();
    setBusy(false);
    updatePreview();
  }

  function selectCue(index, seek = true) {
    selectedCueIndex = index;
    cueList.querySelectorAll('.subtitle-cue-clip').forEach((clip, cueIndex) => clip.classList.toggle('selected', cueIndex === index));
    deleteCueButton.disabled = busy || index < 0;
    if (seek && index >= 0) {
      const cue = parseCues()[index];
      if (cue) video.currentTime = Math.min(cue.start + 0.01, video.duration || cue.start + 0.01);
      updatePreview();
    }
  }

  function renderTimeline() {
    cueList.replaceChildren();
    timelineRuler.replaceChildren();
    let cues;
    try { cues = parseCues(); } catch { updatePreview(); return; }
    if (selectedCueIndex >= cues.length) selectedCueIndex = -1;
    const duration = timelineDuration(cues);
    const available = Math.max(280, timelineViewport.clientWidth - 54);
    timelineScale = Math.max(48, available / duration) * timelineZoom;
    const width = Math.max(available, duration * timelineScale);
    timelineContent.style.width = `${54 + width}px`;
    cueList.style.width = `${width}px`;
    const tickStep = timelineTickStep(duration, timelineScale);
    for (let second = 0; second <= duration; second += tickStep) {
      const tick = document.createElement('span');
      tick.className = 'subtitle-tick';
      tick.style.left = `${54 + second * timelineScale}px`;
      const label = document.createElement('span');
      label.textContent = formatTime(second).slice(0, 5);
      tick.appendChild(label);
      timelineRuler.appendChild(tick);
    }
    cues.forEach((cue, index) => {
      const clip = document.createElement('div');
      clip.className = `subtitle-cue-clip${index === selectedCueIndex ? ' selected' : ''}`;
      clip.style.left = `${cue.start * timelineScale}px`;
      clip.style.width = `${Math.max(12, (cue.end - cue.start) * timelineScale)}px`;
      clip.setAttribute('aria-label', `第 ${index + 1} 条字幕，${formatTime(cue.start)} 到 ${formatTime(cue.end)}`);
      const startHandle = document.createElement('button');
      startHandle.type = 'button';
      startHandle.className = 'subtitle-cue-handle start';
      startHandle.setAttribute('aria-label', `调整第 ${index + 1} 条字幕的开始时间`);
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'subtitle-cue-grip';
      grip.setAttribute('aria-label', `移动第 ${index + 1} 条字幕`);
      const time = document.createElement('span');
      time.textContent = `#${index + 1}  ${formatTime(cue.start)} — ${formatTime(cue.end)}`;
      grip.appendChild(time);
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'subtitle-cue-text';
      textInput.value = cue.text;
      textInput.setAttribute('aria-label', `编辑第 ${index + 1} 条字幕文字`);
      textInput.disabled = busy;
      const endHandle = document.createElement('button');
      endHandle.type = 'button';
      endHandle.className = 'subtitle-cue-handle end';
      endHandle.setAttribute('aria-label', `调整第 ${index + 1} 条字幕的结束时间`);
      for (const handle of [startHandle, grip, endHandle]) handle.disabled = busy;
      clip.append(startHandle, grip, textInput, endHandle);
      cueList.appendChild(clip);

      const updateClip = (next) => {
        cues[index] = next;
        clip.style.left = `${next.start * timelineScale}px`;
        clip.style.width = `${Math.max(12, (next.end - next.start) * timelineScale)}px`;
        time.textContent = `#${index + 1}  ${formatTime(next.start)} — ${formatTime(next.end)}`;
        clip.setAttribute('aria-label', `第 ${index + 1} 条字幕，${formatTime(next.start)} 到 ${formatTime(next.end)}`);
        saveCues(cues);
      };
      for (const [target, mode] of [[startHandle, 'start'], [grip, 'move'], [endHandle, 'end']]) {
        target.addEventListener('pointerdown', (event) => {
          if (busy || event.button !== 0) return;
          event.preventDefault();
          video.pause();
          const originalPlayhead = video.currentTime;
          selectCue(index);
          const original = { ...cues[index] };
          const initialX = event.clientX;
          const limit = timelineDuration(cues);
          const snapTargets = [0, limit, originalPlayhead, ...cues.flatMap((other, otherIndex) => otherIndex === index ? [] : [other.start, other.end])];
          const tickStep = timelineTickStep(limit, timelineScale);
          for (let second = tickStep; second < limit; second += tickStep) snapTargets.push(second);
          target.setPointerCapture(event.pointerId);
          clip.classList.add('dragging');
          const move = (moveEvent) => {
            const delta = Math.round((moveEvent.clientX - initialX) / timelineScale * 100) / 100;
            let start = original.start;
            let end = original.end;
            let snapped = null;
            if (mode === 'move') {
              start = clamp(original.start + delta, 0, Math.max(0, limit - (original.end - original.start)));
              end = start + (original.end - original.start);
              const startSnap = nearestSnap(start, snapTargets, timelineScale);
              const endSnap = nearestSnap(end, snapTargets, timelineScale);
              if (startSnap && (!endSnap || startSnap.distance <= endSnap.distance)) snapped = { ...startSnap, edge: 'start' };
              else if (endSnap) snapped = { ...endSnap, edge: 'end' };
              if (snapped) {
                start = clamp(start + snapped.time - (snapped.edge === 'start' ? start : end), 0, Math.max(0, limit - (original.end - original.start)));
                end = start + (original.end - original.start);
              }
            } else if (mode === 'start') {
              start = clamp(original.start + delta, 0, original.end - 0.1);
              snapped = nearestSnap(start, snapTargets, timelineScale);
              if (snapped) start = clamp(snapped.time, 0, original.end - 0.1);
            } else {
              end = clamp(original.end + delta, original.start + 0.1, limit);
              snapped = nearestSnap(end, snapTargets, timelineScale);
              if (snapped) end = clamp(snapped.time, original.start + 0.1, limit);
            }
            if (snapped && Math.abs((mode === 'end' ? end : mode === 'start' || snapped.edge === 'start' ? start : end) - snapped.time) > 0.011) snapped = null;
            snapGuide.hidden = !snapped;
            if (snapped) snapGuide.style.left = `${54 + snapped.time * timelineScale}px`;
            updateClip({ ...original, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
            video.currentTime = Math.min(cues[index].start + 0.01, video.duration || cues[index].start + 0.01);
          };
          const finish = () => {
            target.removeEventListener('pointermove', move);
            clip.classList.remove('dragging');
            snapGuide.hidden = true;
            renderTimeline();
          };
          target.addEventListener('pointermove', move);
          target.addEventListener('pointerup', finish, { once: true });
          target.addEventListener('pointercancel', finish, { once: true });
        });
        target.addEventListener('keydown', (event) => {
          if (busy || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          selectCue(index, false);
          const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : 0.1);
          const limit = timelineDuration(cues);
          const original = cues[index];
          let start = original.start;
          let end = original.end;
          if (mode === 'move') { start = clamp(start + delta, 0, Math.max(0, limit - (end - start))); end = start + (original.end - original.start); }
          else if (mode === 'start') start = clamp(start + delta, 0, end - 0.1);
          else end = clamp(end + delta, start + 0.1, limit);
          updateClip({ ...original, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
        });
      }
      grip.addEventListener('click', () => selectCue(index));
      textInput.addEventListener('focus', () => selectCue(index));
      textInput.addEventListener('input', () => {
        if (!textInput.value.trim()) return;
        cues[index] = { ...cues[index], text: textInput.value.replace(/[\r\n]/g, ' ') };
        saveCues(cues);
      });
      textInput.addEventListener('blur', () => {
        if (!textInput.value.trim()) textInput.value = cues[index].text;
      });
    });
    deleteCueButton.disabled = busy || selectedCueIndex < 0;
    updatePreview();
  }

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    addFiles(files);
  });
  dropZone.addEventListener('click', (event) => { if (!event.target.closest('label') && !busy) fileInput.click(); });
  dropZone.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); fileInput.click(); }
  });
  for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!busy) dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', (event) => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(event.dataTransfer.files);
  });
  document.querySelectorAll('.subtitle-style-card').forEach((button) => button.addEventListener('click', () => {
    currentStyle = button.dataset.style;
    if (activeIndex >= 0) items[activeIndex].style = currentStyle;
    const preset = defaultCaptionOptions(currentStyle);
    currentOptions = { ...currentOptions, textColor: preset.textColor, outlineColor: preset.outlineColor, outline: preset.outline, boxColor: preset.boxColor, boxOpacity: preset.boxOpacity };
    document.querySelectorAll('.subtitle-style-card').forEach((card) => {
      const active = card === button;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', String(active));
    });
    saveStyleOptions();
  }));
  for (const [name, control] of Object.entries(styleControls)) control.addEventListener('input', () => {
    currentOptions[name] = control.type === 'range' ? Number(control.value) : control.value;
    saveStyleOptions();
  });
  boldButton.addEventListener('click', () => {
    if (busy) return;
    currentOptions.bold = !currentOptions.bold;
    saveStyleOptions();
  });
  alignButtons.forEach((button) => button.addEventListener('click', () => {
    if (busy) return;
    currentOptions.textAlign = button.dataset.align;
    saveStyleOptions();
  }));
  for (const [button, x, y] of [[centerButton, 50, 50], [bottomCenterButton, 50, 85]]) button.addEventListener('click', () => {
    if (busy) return;
    currentOptions.positionX = x;
    currentOptions.positionY = y;
    saveStyleOptions();
  });
  styleResetButton.addEventListener('click', () => {
    currentOptions = defaultCaptionOptions(currentStyle);
    saveStyleOptions();
  });
  video.addEventListener('loadedmetadata', () => {
    const ratio = video.videoWidth / video.videoHeight;
    videoFrame.style.aspectRatio = String(ratio);
    videoFrame.style.maxWidth = `${Math.min(1100, Math.round(560 * ratio))}px`;
    syncStyleControls();
    addCueButton.disabled = busy || !selectedFile;
    renderTimeline();
  });
  for (const eventName of ['timeupdate', 'seeked', 'play']) video.addEventListener(eventName, updatePreview);
  timelineViewport.addEventListener('pointerdown', (event) => {
    if (busy || !selectedFile || event.button !== 0 || event.target.closest('.subtitle-cue-clip')) return;
    const bounds = timelineViewport.getBoundingClientRect();
    if (event.clientY - bounds.top >= timelineViewport.clientHeight) return;
    event.preventDefault();
    const originX = event.clientX;
    const originScroll = timelineViewport.scrollLeft;
    const onRuler = !!event.target.closest('.subtitle-timeline-ruler');
    const contentX = originX - timelineContent.getBoundingClientRect().left;
    const scrub = onRuler && Math.abs(contentX - (54 + video.currentTime * timelineScale)) < 12;
    let moved = false;
    timelineViewport.setPointerCapture(event.pointerId);
    timelineViewport.classList.add('panning');
    const move = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - originX) > 3) moved = true;
      if (!moved) return;
      if (scrub) {
        const seconds = (moveEvent.clientX - timelineContent.getBoundingClientRect().left - 54) / timelineScale;
        video.currentTime = clamp(seconds, 0, Number.isFinite(video.duration) ? video.duration : timelineDuration(parseCues()));
        updatePreview();
      } else timelineViewport.scrollLeft = originScroll + originX - moveEvent.clientX;
    };
    const finish = (finishEvent) => {
      timelineViewport.removeEventListener('pointermove', move);
      timelineViewport.classList.remove('panning');
      if (finishEvent.type === 'pointerup' && !moved && onRuler) {
        const seconds = (originX - timelineContent.getBoundingClientRect().left - 54) / timelineScale;
        video.currentTime = clamp(seconds, 0, Number.isFinite(video.duration) ? video.duration : timelineDuration(parseCues()));
        updatePreview();
      }
    };
    timelineViewport.addEventListener('pointermove', move);
    timelineViewport.addEventListener('pointerup', finish, { once: true });
    timelineViewport.addEventListener('pointercancel', finish, { once: true });
  });
  addCueButton.addEventListener('click', () => {
    if (busy || !selectedFile) return;
    const cues = parseCues();
    const limit = timelineDuration(cues);
    const start = Math.round(clamp(video.currentTime, 0, Math.max(0, limit - 0.1)) * 100) / 100;
    const end = Math.round(Math.min(limit, start + 2) * 100) / 100;
    cues.push({ start, end, text: '新字幕' });
    selectedCueIndex = cues.length - 1;
    saveCues(cues);
    renderTimeline();
    cueList.querySelectorAll('.subtitle-cue-text')[selectedCueIndex]?.focus();
  });
  deleteCueButton.addEventListener('click', () => {
    if (busy || selectedCueIndex < 0) return;
    const cues = parseCues();
    cues.splice(selectedCueIndex, 1);
    selectedCueIndex = -1;
    saveCues(cues);
    renderTimeline();
  });
  for (const [id, factor] of [['subtitleZoomIn', 1.5], ['subtitleZoomOut', 1 / 1.5]]) $(id).addEventListener('click', () => {
    if (busy) return;
    timelineZoom = clamp(Math.round(timelineZoom * factor * 100) / 100, 0.5, 8);
    $('subtitleZoomValue').textContent = `${Math.round(timelineZoom * 100)}%`;
    renderTimeline();
  });
  window.addEventListener('resize', () => { if (selectedFile) renderTimeline(); });
  transcribeButton.addEventListener('click', async () => {
    if (busy || activeIndex < 0) return;
    setBusy(true);
    const item = items[activeIndex];
    try {
      await transcribeItem(item, activeIndex);
      setStatus(item.status);
    } catch (error) {
      item.error = error.message || '识别失败';
      item.status = '识别失败';
      setStatus(`识别失败：${item.file.name}`);
      window.alert(item.error);
    } finally { setBusy(false); renderBatchList(); }
  });
  transcribeAllButton.addEventListener('click', async () => {
    if (busy || !items.length) return;
    const pending = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.cuesText.trim());
    if (!pending.length) { setStatus('所有视频已有字幕，仍可逐个重新识别。'); return; }
    setBusy(true);
    let completed = 0;
    let failed = 0;
    for (const { item, index } of pending) {
      try { await transcribeItem(item, index); completed += 1; }
      catch (error) { item.error = error.message || '识别失败'; item.status = '识别失败'; failed += 1; }
      renderBatchList();
    }
    setBusy(false);
    if (!items[activeIndex]?.cuesText.trim()) {
      const firstReady = items.findIndex((item) => item.cuesText.trim());
      if (firstReady >= 0) await activateItem(firstReady).catch(() => {});
    }
    setStatus(`批量识别完成：${completed} 个成功${failed ? `，${failed} 个失败` : ''}`);
    renderBatchList();
  });
  async function exportVideo(named) {
    if (busy) return;
    const file = selectedFile;
    if (!file) return window.alert('请先选择视频。');
    let cues;
    try {
      cues = parseCues();
      if (!cues.length) throw new Error('请先生成或填写字幕。');
    } catch (error) { window.alert(error.message); return; }
    setBusy(true);
    try {
      setStatus('正在合成字幕视频…');
      const blob = await burnCues(await ensureFFmpeg(), file, cues, currentStyle, currentOptions);
      await onExport(blob, file, named);
      setStatus(named ? '已发送到命名页面' : 'MP4 已导出');
    } catch (error) { setStatus('导出失败'); window.alert(error.message || '导出失败'); }
    finally { setBusy(false); }
  }
  exportButton.addEventListener('click', () => exportVideo(false));
  namedButton.addEventListener('click', () => exportVideo(true));
  async function processBatch(mode) {
    if (busy) return;
    const pending = items.map((item, index) => ({ item, index })).filter(({ item }) => item.cuesText.trim());
    if (!pending.length) { window.alert('请先批量识别或填写字幕。'); return; }
    setBusy(true);
    const outputs = [];
    let failed = 0;
    try {
      const ffmpeg = await ensureFFmpeg();
      for (const { item, index } of pending) {
        try {
          const cues = parseCues(item.cuesText);
          if (!cues.length) throw new Error('没有可导出的字幕。');
          item.status = `正在导出 ${index + 1}/${items.length}`;
          item.error = '';
          setStatus(`${item.status}：${item.file.name}`);
          await activateItem(index);
          renderBatchList();
          const blob = await burnCues(ffmpeg, item.file, cues, item.style, item.options);
          outputs.push({ blob, source: item.file });
          item.status = '成品已生成';
        } catch (error) {
          item.error = error.message || '导出失败';
          item.status = '导出失败';
          failed += 1;
        }
        renderBatchList();
      }
      if (!outputs.length) throw new Error('所有视频导出失败，请查看视频队列中的错误。');
      if (mode === 'zip') await onBatchExport(outputs); else await onBatchSend(outputs);
      setStatus(`${outputs.length} 个视频已${mode === 'zip' ? '打包导出' : '发送到命名'}${failed ? `，${failed} 个失败` : ''}`);
    } catch (error) { setStatus('批量导出失败'); window.alert(error.message || '批量导出失败'); }
    finally { setBusy(false); renderBatchList(); }
  }
  batchExportButton.addEventListener('click', () => processBatch('zip'));
  batchSendButton.addEventListener('click', () => processBatch('naming'));
  window.addEventListener('beforeunload', () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); });
  syncStyleControls();
}
