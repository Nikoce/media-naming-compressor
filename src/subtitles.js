import { cuesFromWords, hardCutCues } from './caption-timing.js';
import { captionFontSize, captionBandHeight, captionY, drawCaption } from './caption-render.js';
import { createCaptionJob } from './caption-job.js';
import { burnSubtitleJob } from './caption-export.js';
import { runMediaJob } from './media-jobs.js';
import { matchesVideoSource, readVideoSource } from './video-source.js';

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
const relinkButton = $('subtitleRelinkBtn');
const relinkInput = $('subtitleRelinkFile');
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
  relinkButton.disabled = value || !items.some((item) => item.sourceUnavailable);
  relinkButton.hidden = !items.some((item) => item.sourceUnavailable);
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

async function getAudio(ffmpeg, file) {
  const input = `asr-input-${crypto.randomUUID()}${file.name.match(/\.[^.]+$/)?.[0] || '.mp4'}`;
  const audio = `asr-${crypto.randomUUID()}.wav`;
  try {
    await ffmpeg.writeFile(input, await readVideoSource(file));
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

export function setupSubtitles({ ensureFFmpeg, onExport, onSend, onBatchExport, onBatchSend }) {
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
    relinkButton.hidden = !items.some((item) => item.sourceUnavailable);
    relinkButton.disabled = busy || relinkButton.hidden;
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
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onMetadata);
        video.removeEventListener('error', onError);
      };
      const onMetadata = () => {
        cleanup();
        item.metadata = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`浏览器无法预览 ${item.file.name}，仍可识别和导出字幕`));
      };
      video.addEventListener('loadedmetadata', onMetadata);
      video.addEventListener('error', onError);
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

  async function relinkFiles(fileList) {
    if (busy) return;
    const candidates = [...fileList];
    let restored = 0;
    const unmatched = [];
    for (const replacement of candidates) {
      const item = items.find((entry) => entry.sourceUnavailable && matchesVideoSource(entry.file, replacement));
      if (!item) { unmatched.push(replacement.name); continue; }
      try {
        await replacement.slice(0, 1).arrayBuffer();
      } catch {
        unmatched.push(`${replacement.name}（仍无法读取）`);
        continue;
      }
      item.file = replacement;
      item.metadata = undefined;
      item.sourceUnavailable = false;
      item.error = '';
      item.status = item.cuesText.trim() ? '字幕已保留，可重新导出' : '待识别';
      restored += 1;
    }
    if (restored && activeIndex >= 0) {
      await activateItem(activeIndex).catch((error) => setStatus(error.message));
    }
    renderBatchList();
    setBusy(false);
    setStatus(`${restored} 个原视频已重新关联${unmatched.length ? `；${unmatched.length} 个文件名称或大小不匹配，请选择对应原视频` : ''}。字幕和样式已保留。`);
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
    const audioLoading = runMediaJob(async () => getAudio(await ensureFFmpeg(), item.file), () => setStatus('等待视频处理任务…'));
    const [audio, transcriber] = await Promise.all([audioLoading, transcriberLoading]);
    setStatus(`正在识别 ${index + 1}/${items.length}：${item.file.name}`);
    const result = await runMediaJob(() => {
      setStatus(`正在识别 ${index + 1}/${items.length}：${item.file.name}`);
      return transcriber(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 2 });
    }, () => setStatus('等待其他视频处理任务…'));
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
  relinkButton.addEventListener('click', () => { if (!busy) relinkInput.click(); });
  relinkInput.addEventListener('change', () => {
    const files = [...relinkInput.files];
    relinkInput.value = '';
    relinkFiles(files).catch((error) => setStatus(error.message));
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
      item.sourceUnavailable = Boolean(error.sourceUnavailable);
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
      catch (error) { item.sourceUnavailable = Boolean(error.sourceUnavailable); item.error = error.message || '识别失败'; item.status = '识别失败'; failed += 1; }
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
      const job = createCaptionJob(file, cues, currentStyle, currentOptions, items[activeIndex]?.metadata);
      if (named) {
        await onSend(job);
        const item = items[activeIndex];
        if (item) { item.status = '字幕已发送，等待导出'; item.error = ''; renderBatchList(); }
        setStatus('字幕已发送，导出时自动合成');
        return;
      }
      const { blob, metadata } = await burnSubtitleJob(job, ensureFFmpeg, undefined, (stage, progress) => {
        setStatus(`${stage}${Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : '…'}`);
      });
      await onExport(blob, file);
      const item = items[activeIndex];
      if (item) {
        item.metadata = metadata;
        item.error = '';
        item.sourceUnavailable = false;
        item.status = '成品已生成';
        renderBatchList();
      }
      setStatus(named ? '已发送到命名页面' : 'MP4 已导出');
    } catch (error) {
      const item = items[activeIndex];
      if (item) {
        item.sourceUnavailable = Boolean(error.sourceUnavailable);
        item.error = error.message || '导出失败';
        item.status = '导出失败';
        renderBatchList();
      }
      setStatus('导出失败');
      window.alert(error.message || '导出失败');
    }
    finally { setBusy(false); }
  }
  exportButton.addEventListener('click', () => exportVideo(false));
  namedButton.addEventListener('click', () => exportVideo(true));
  async function processBatch(mode) {
    if (busy) return;
    const pending = items.map((item, index) => ({ item, index })).filter(({ item }) => item.cuesText.trim());
    const skipped = items.filter((item) => !item.cuesText.trim()).map((item) => item.file.name);
    if (!pending.length) { window.alert('请先批量识别或填写字幕。'); return; }
    setBusy(true);
    const outputs = [];
    const failures = [];
    try {
      for (const { item, index } of pending) {
        try {
          const cues = parseCues(item.cuesText);
          if (!cues.length) throw new Error('没有可导出的字幕。');
          item.status = `正在导出 ${index + 1}/${items.length}`;
          item.error = '';
          setStatus(`${item.status}：${item.file.name}`);
          const job = createCaptionJob(item.file, cues, item.style, item.options, item.metadata);
          if (mode !== 'zip') {
            outputs.push(job);
            item.status = '字幕已发送，等待导出';
            continue;
          }
          const { blob, metadata } = await burnSubtitleJob(job, ensureFFmpeg, undefined, (stage, progress) => {
            setStatus(`${item.file.name}：${stage}${Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : '…'}`);
          });
          item.metadata = metadata;
          outputs.push({ blob, source: item.file, metadata });
          item.sourceUnavailable = false;
          item.status = '成品已生成';
        } catch (error) {
          item.sourceUnavailable = Boolean(error.sourceUnavailable);
          item.error = error.message || '导出失败';
          item.status = '导出失败';
          failures.push({ name: item.file.name, reason: item.error });
        }
        renderBatchList();
      }
      if (!outputs.length) {
        const details = failures.slice(0, 3).map(({ name, reason }) => `${name}：${reason}`).join('；');
        throw new Error(`所有视频导出失败：${details}${failures.length > 3 ? `；其余 ${failures.length - 3} 个请查看视频队列` : ''}`);
      }
      if (mode === 'zip') await onBatchExport(outputs); else await onBatchSend(outputs, failures, skipped);
      const summary = `${outputs.length} 个视频已${mode === 'zip' ? '打包导出' : '发送到命名'}`;
      const problems = [
        ...failures.map(({ name, reason }) => `${name}：${reason}`),
        ...skipped.map((name) => `${name}：没有字幕`),
      ];
      setStatus(problems.length ? `${summary}；${problems.length} 个未完成：${problems.join('；')}` : summary);
    } catch (error) { setStatus('批量导出失败'); window.alert(error.message || '批量导出失败'); }
    finally { setBusy(false); renderBatchList(); }
  }
  batchExportButton.addEventListener('click', () => processBatch('zip'));
  batchSendButton.addEventListener('click', () => processBatch('naming'));
  window.addEventListener('beforeunload', () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); });
  syncStyleControls();
}
