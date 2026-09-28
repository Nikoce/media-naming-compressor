import { fetchFile } from '@ffmpeg/util';

const $ = (id) => document.getElementById(id);
const fileInput = $('subtitleFile');
const video = $('subtitleVideo');
const videoFrame = $('subtitleVideoFrame');
const previewCanvas = $('subtitlePreviewCanvas');
const dropZone = $('subtitleDropZone');
const editor = $('subtitleEditor');
const cuesInput = $('subtitleCues');
const cueList = $('subtitleCueList');
const status = $('subtitleStatus');
const transcribeButton = $('transcribeBtn');
const transcribeAllButton = $('transcribeAllBtn');
const exportButton = $('subtitleExportBtn');
const namedButton = $('subtitleNameExportBtn');
const batchExportButton = $('subtitleBatchExportBtn');
const batchSendButton = $('subtitleBatchSendBtn');
let sourceUrl;
let transcriber;
let busy = false;
let selectedFile = null;
let currentStyle = 'classic';
const items = [];
let activeIndex = -1;

function setStatus(message) { status.textContent = message; }
function setBusy(value) {
  busy = value;
  for (const element of [fileInput, exportButton, namedButton, cuesInput, ...document.querySelectorAll('.subtitle-style-card')]) element.disabled = value;
  transcribeButton.disabled = value || !selectedFile;
  transcribeAllButton.disabled = value || !items.length;
  const hasCues = items.some((item) => item.cuesText.trim());
  batchExportButton.disabled = value || !hasCues;
  batchSendButton.disabled = value || !hasCues;
  dropZone.classList.toggle('busy', value);
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

function drawCaption(context, cue, width, height, bandHeight, style) {
  const fontSize = Math.max(20, Math.round(Math.min(width * 0.052, height * 0.064)));
  context.font = `800 ${fontSize}px Arial, "Microsoft YaHei", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const maxWidth = width * 0.88;
  const chars = Array.from(cue.text);
  const lines = [];
  let line = '';
  for (const char of chars) {
    if (context.measureText(line + char).width > maxWidth && line) { lines.push(line); line = ''; }
    line += char;
  }
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, 3);
  const lineHeight = fontSize * 1.22;
  const top = Math.max(fontSize / 2 + 4, (bandHeight - visibleLines.length * lineHeight) / 2 + lineHeight / 2);
  if (style === 'boxed') {
    context.fillStyle = 'rgba(0, 0, 0, 0.78)';
    context.fillRect(width * 0.045, Math.max(0, top - lineHeight * 0.65), width * 0.91, Math.min(bandHeight, visibleLines.length * lineHeight + 14));
  }
  visibleLines.forEach((text, index) => {
    const y = top + index * lineHeight;
    context.lineWidth = Math.max(3, fontSize * 0.13);
    context.strokeStyle = '#111';
    context.lineJoin = 'round';
    if (style !== 'boxed') context.strokeText(text, width / 2, y);
    context.fillStyle = style === 'yellow' ? '#ffe547' : '#fff';
    context.fillText(text, width / 2, y);
  });
}

async function canvasPng(cue, width, height, style) {
  const bandHeight = Math.max(80, Math.round(height * 0.22));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = bandHeight;
  drawCaption(canvas.getContext('2d'), cue, width, height, bandHeight, style);
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

async function burnCues(ffmpeg, file, cues, style, width = video.videoWidth, height = video.videoHeight) {
  if (!width || !height) throw new Error('无法读取视频尺寸。');
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
      const png = await canvasPng(cues[i], width, height, style);
      bandHeight = png.bandHeight;
      const path = `${prefix}-${i}.png`;
      paths.push(path);
      await ffmpeg.writeFile(path, png.bytes);
      args.push('-i', path);
    }
    const filters = cues.map((cue, i) => {
      const before = i ? `[v${i}]` : '[0:v]';
      const after = `[v${i + 1}]`;
      return `${before}[${i + 1}:v]overlay=0:${height - bandHeight - Math.round(height * 0.03)}:enable='between(t,${cue.start},${cue.end})':eof_action=repeat${after}`;
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
    selectedFile = item.file;
    currentStyle = item.style;
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
    renderCueList();
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
      items.push({ file, cuesText: '', style: currentStyle, status: '待识别', error: '' });
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
    const audio = await getAudio(await ensureFFmpeg(), item.file);
    if (!transcriber) {
      setStatus('正在加载语音模型…');
      const { pipeline } = await import('@huggingface/transformers');
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { dtype: 'q8' });
    }
    setStatus(`正在识别 ${index + 1}/${items.length}：${item.file.name}`);
    const result = await transcriber(audio, { return_timestamps: true, chunk_length_s: 30 });
    const chunks = result.chunks || [];
    if (!chunks.length) throw new Error('没有识别到可用的语音字幕。');
    item.cuesText = chunks.map((chunk) => `${Math.max(0, chunk.timestamp[0]).toFixed(2)} | ${(chunk.timestamp[1] ?? chunk.timestamp[0] + 2).toFixed(2)} | ${chunk.text.trim().replace(/\s+/g, ' ')}`).join('\n');
    item.status = `已生成 ${chunks.length} 条字幕`;
    if (activeIndex === index) {
      cuesInput.value = item.cuesText;
      editor.hidden = false;
      $('subtitleEditorEmpty').hidden = true;
      renderCueList();
      video.currentTime = Math.max(0, chunks[0].timestamp[0]);
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
    const activeIndex = cues.findIndex((cue) => video.currentTime >= cue.start && video.currentTime <= cue.end);
    const cue = activeIndex >= 0 ? cues[activeIndex] : (editor.hidden ? { text: '字幕效果预览' } : null);
    if (cue) {
      const bandHeight = Math.max(80, Math.round(height * 0.22));
      const y = height - bandHeight - Math.round(height * 0.03);
      context.save();
      context.translate(0, y);
      drawCaption(context, cue, width, height, bandHeight, currentStyle);
      context.restore();
    }
    cueList.querySelectorAll('button').forEach((button, index) => button.classList.toggle('active', index === activeIndex));
    $('subtitlePreviewStatus').textContent = editor.hidden ? '样式预览' : `${cues.length} 条字幕 · 播放或拖动进度查看`;
  }

  function renderCueList() {
    cueList.replaceChildren();
    let cues;
    try { cues = parseCues(); } catch { updatePreview(); return; }
    cues.forEach((cue, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      const time = document.createElement('span');
      time.textContent = `#${index + 1}  ${cue.start.toFixed(2)} – ${cue.end.toFixed(2)}s`;
      button.append(time, document.createTextNode(cue.text));
      button.addEventListener('click', () => { video.currentTime = cue.start + 0.01; updatePreview(); video.focus(); });
      cueList.appendChild(button);
    });
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
    document.querySelectorAll('.subtitle-style-card').forEach((card) => {
      const active = card === button;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', String(active));
    });
    updatePreview();
  }));
  video.addEventListener('loadedmetadata', () => {
    const ratio = video.videoWidth / video.videoHeight;
    videoFrame.style.aspectRatio = String(ratio);
    videoFrame.style.maxWidth = `${Math.min(850, Math.round(480 * ratio))}px`;
    updatePreview();
  });
  for (const eventName of ['timeupdate', 'seeked', 'play']) video.addEventListener(eventName, updatePreview);
  cuesInput.addEventListener('input', () => {
    if (activeIndex >= 0) {
      items[activeIndex].cuesText = cuesInput.value;
      items[activeIndex].status = '字幕已修改';
    }
    renderCueList();
    renderBatchList();
    setBusy(false);
  });
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
      const blob = await burnCues(await ensureFFmpeg(), file, cues, currentStyle);
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
          const blob = await burnCues(ffmpeg, item.file, cues, item.style);
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
}
