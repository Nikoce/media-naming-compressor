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
const exportButton = $('subtitleExportBtn');
const namedButton = $('subtitleNameExportBtn');
let sourceUrl;
let transcriber;
let busy = false;
let selectedFile = null;
let currentStyle = 'classic';

function setStatus(message) { status.textContent = message; }
function setBusy(value) {
  busy = value;
  for (const element of [fileInput, transcribeButton, exportButton, namedButton, cuesInput, ...document.querySelectorAll('.subtitle-style-card')]) element.disabled = value;
  dropZone.classList.toggle('busy', value);
}

function parseCues() {
  return cuesInput.value.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
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

async function burnCues(ffmpeg, file, cues, style) {
  const width = video.videoWidth;
  const height = video.videoHeight;
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

export function setupSubtitles({ ensureFFmpeg, onExport }) {
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

  function chooseFile(file) {
    if (busy || !file) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name)) {
      setStatus('请选择视频文件');
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    selectedFile = file;
    sourceUrl = URL.createObjectURL(file);
    $('subtitleFileName').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    $('subtitlePreviewEmpty').hidden = true;
    video.hidden = false;
    previewCanvas.hidden = false;
    video.src = sourceUrl;
    video.load();
    cuesInput.value = '';
    editor.hidden = true;
    cueList.replaceChildren();
    transcribeButton.disabled = false;
    setStatus('视频已就绪');
    $('subtitlePreviewStatus').textContent = '正在读取视频…';
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    chooseFile(file);
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
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(item.name));
    if (file) chooseFile(file); else setStatus('请拖入视频文件');
  });
  document.querySelectorAll('.subtitle-style-card').forEach((button) => button.addEventListener('click', () => {
    currentStyle = button.dataset.style;
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
  cuesInput.addEventListener('input', renderCueList);
  transcribeButton.addEventListener('click', async () => {
    if (busy || !selectedFile) return;
    setBusy(true);
    try {
      setStatus('正在提取音频…');
      const audio = await getAudio(await ensureFFmpeg(), selectedFile);
      setStatus('正在加载语音模型…');
      if (!transcriber) {
        const { pipeline } = await import('@huggingface/transformers');
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { dtype: 'q8' });
      }
      setStatus('正在识别语音…');
      const result = await transcriber(audio, { return_timestamps: true, chunk_length_s: 30 });
      const chunks = result.chunks || [];
      if (!chunks.length) throw new Error('没有识别到可用的语音字幕。');
      cuesInput.value = chunks.map((chunk) => `${Math.max(0, chunk.timestamp[0]).toFixed(2)} | ${(chunk.timestamp[1] ?? chunk.timestamp[0] + 2).toFixed(2)} | ${chunk.text.trim().replace(/\s+/g, ' ')}`).join('\n');
      editor.hidden = false;
      renderCueList();
      video.currentTime = Math.max(0, chunks[0].timestamp[0]);
      updatePreview();
      setStatus(`已生成 ${chunks.length} 条字幕`);
    } catch (error) { setStatus('识别失败'); window.alert(error.message || '语音识别失败'); }
    finally { setBusy(false); }
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
  window.addEventListener('beforeunload', () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); });
}
