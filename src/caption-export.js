import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, canEncodeVideo } from 'mediabunny';
import { readVideoSource } from './video-source.js';
import { fitCuesToDuration, cueAtTime } from './caption-job.js';
import { captionBandHeight, captionY, drawCaption } from './caption-render.js';
import { runMediaJob } from './media-jobs.js';

const DEFAULT_PROFILE = {
  videoQuality: 0.55, audioBitrate: 192000,
  ffmpegArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '192k'],
};

async function burnWithWebCodecs(job, profile, onProgress) {
  const input = new Input({ source: new BlobSource(job.source), formats: ALL_FORMATS });
  let conversion;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error('浏览器不能解码此视频');
    const [displayWidth, displayHeight, duration] = await Promise.all([
      track.getDisplayWidth(), track.getDisplayHeight(), input.computeDuration(),
    ]);
    const width = Math.ceil(displayWidth / 2) * 2;
    const height = Math.ceil(displayHeight / 2) * 2;
    const quality = new Quality(profile.videoQuality);
    if (!await canEncodeVideo('avc', { width, height, quality, hardwareAcceleration: 'prefer-hardware' })) {
      throw new Error('浏览器不能编码此尺寸的 H.264');
    }
    const cues = fitCuesToDuration(job.cues, duration);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const band = document.createElement('canvas');
    band.width = width;
    band.height = captionBandHeight(width, height, job.options);
    const bandContext = band.getContext('2d');
    if (!context || !bandContext) throw new Error('浏览器无法绘制字幕');
    let lastCue = null;
    let captionFrames = 0;
    const target = new BufferTarget();
    const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
    conversion = await Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: {
        codec: 'avc', quality, hardwareAcceleration: 'prefer-hardware', forceTranscode: true,
        width, height, fit: 'contain', allowTransformationMetadata: false,
        process(sample) {
          sample.draw(context, 0, 0, width, height);
          const cue = cueAtTime(cues, sample.timestamp);
          if (cue !== lastCue) {
            bandContext.clearRect(0, 0, width, band.height);
            if (cue) drawCaption(bandContext, cue, width, height, band.height, job.style, job.options);
            lastCue = cue;
          }
          if (cue) {
            context.drawImage(band, 0, captionY(height, band.height, job.options.positionY));
            captionFrames += 1;
          }
          return canvas;
        },
      },
      audio: async (audio) => await audio.getCodec() === 'aac'
        ? {} : { codec: 'aac', quality: new Quality({ bitrate: profile.audioBitrate }) },
    });
    // A valid conversion can still have discarded its audio or video. Never silently lose either.
    if (!conversion.isValid || conversion.discardedTracks.length) throw new Error('极速引擎无法完整保留音视频轨道');
    onProgress?.('WebCodecs 字幕合成', 0);
    conversion.onProgress = (progress) => onProgress?.('WebCodecs 字幕合成', progress);
    await conversion.execute();
    if (!target.buffer?.byteLength || !captionFrames) throw new Error('未生成含字幕的视频帧，请检查字幕时间');
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), metadata: { width, height, duration }, engine: 'webcodecs' };
  } catch (error) {
    if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') await conversion.cancel().catch(() => {});
    throw error;
  } finally { input.dispose(); }
}

export function burnSubtitleJob(job, ensureFFmpeg, profile = DEFAULT_PROFILE, onProgress) {
  return runMediaJob(async () => {
    await document.fonts?.ready;
    try {
      return await burnWithWebCodecs(job, profile, onProgress);
    } catch (error) {
      if (error.sourceUnavailable) throw error;
      console.warn('字幕极速合成失败，切换 FFmpeg', error);
      onProgress?.('正在切换 FFmpeg 兼容合成');
      return burnCues(await ensureFFmpeg(), job.source, job.cues, job.style, job.options, job.metadata, profile, onProgress);
    }
  }, () => onProgress?.('等待其他视频处理任务'));
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

function concatImageList(segments) {
  const lines = ['ffconcat version 1.0'];
  for (const { path, duration } of segments) {
    lines.push(`file '${path}'`, 'option framerate 1000', `duration ${Math.max(0.001, duration).toFixed(6)}`);
  }
  // The concat demuxer needs the last file repeated to honor its duration.
  lines.push(`file '${segments.at(-1).path}'`, 'option framerate 1000');
  return `${lines.join('\n')}\n`;
}

async function probeVideoMetadata(ffmpeg, input, prefix) {
  const path = `${prefix}-probe.json`;
  const framePath = `${prefix}-frame.png`;
  try {
    const code = await ffmpeg.ffprobe([
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
      '-o', path, input,
    ]);
    if (code !== 0) {
      const frameCode = await ffmpeg.exec(['-y', '-i', input, '-frames:v', '1', '-an', framePath]);
      if (frameCode !== 0) throw new Error('无法读取视频画面，请检查文件是否损坏或格式是否受支持。');
      const bytes = await ffmpeg.readFile(framePath);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        return { width: bitmap.width, height: bitmap.height, duration: 0 };
      } finally { bitmap.close(); }
    }
    const bytes = await ffmpeg.readFile(path);
    const probe = JSON.parse(new TextDecoder().decode(bytes));
    const stream = probe.streams?.find((entry) => entry.codec_type === 'video');
    if (!stream) throw new Error('文件中没有视频轨道。');
    const rotation = Number(stream.side_data_list?.find((entry) => Number.isFinite(Number(entry.rotation)))?.rotation
      ?? stream.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation % 180) === 90;
    return {
      width: Number(rotated ? stream.height : stream.width),
      height: Number(rotated ? stream.width : stream.height),
      duration: Number(probe.format?.duration || stream.duration || 0),
    };
  } finally {
    await ffmpeg.deleteFile(path).catch(() => {});
    await ffmpeg.deleteFile(framePath).catch(() => {});
  }
}

async function burnCues(ffmpeg, file, cues, style, options, metadata = {}, profile, onProgress) {
  cues = fitCuesToDuration(cues, metadata.duration);
  if (!cues.length) throw new Error('没有可导出的字幕。');
  const prefix = `caption-${crypto.randomUUID()}`;
  const input = `${prefix}-source${file.name.match(/\.[^.]+$/)?.[0] || '.mp4'}`;
  const output = `${prefix}-output.mp4`;
  const manifest = `${prefix}-captions.ffcat`;
  const paths = [];
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 12) log.shift(); };
  const progress = ({ progress }) => onProgress?.('FFmpeg 兼容合成', progress);
  ffmpeg.on('progress', progress);
  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.writeFile(input, await readVideoSource(file));
    const validMetadata = Number.isFinite(metadata.width) && metadata.width > 0
      && Number.isFinite(metadata.height) && metadata.height > 0;
    const sourceMetadata = validMetadata ? metadata : await probeVideoMetadata(ffmpeg, input, prefix);
    const { width, height } = sourceMetadata;
    cues = fitCuesToDuration(cues, sourceMetadata.duration);
    if (!width || !height) throw new Error('无法读取视频尺寸。');
    const bandHeight = captionBandHeight(width, height, options);
    const blankCanvas = document.createElement('canvas');
    blankCanvas.width = width;
    blankCanvas.height = bandHeight;
    const blank = await new Promise((resolve, reject) => blankCanvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('透明字幕图片生成失败')), 'image/png'));
    const blankPath = `${prefix}-blank.png`;
    paths.push(blankPath);
    await ffmpeg.writeFile(blankPath, new Uint8Array(await blank.arrayBuffer()));
    const segments = [];
    let cursor = 0;
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      if (cue.start > cursor) segments.push({ path: blankPath, duration: cue.start - cursor });
      const png = await canvasPng(cues[i], width, height, style, options);
      const path = `${prefix}-${i}.png`;
      paths.push(path);
      await ffmpeg.writeFile(path, png.bytes);
      segments.push({ path, duration: cue.end - cue.start });
      cursor = cue.end;
    }
    segments.push({ path: blankPath, duration: 0.1 });
    await ffmpeg.writeFile(manifest, new TextEncoder().encode(concatImageList(segments)));
    const args = [
      '-y', '-i', input, '-safe', '0', '-f', 'concat', '-i', manifest,
      '-filter_complex', `[0:v]setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS[caption];[base][caption]overlay=0:${captionY(height, bandHeight, options.positionY)}:shortest=0:eof_action=pass:repeatlast=1[v]`,
      '-map', '[v]', '-map', '0:a?', ...profile.ffmpegArgs, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
    ];
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      console.error('字幕合成 FFmpeg 日志', log.join('\n'));
      throw new Error(`字幕合成失败：${log.slice(-8).join(' ').slice(0, 900) || `FFmpeg 退出码 ${code}`}`);
    }
    const bytes = await ffmpeg.readFile(output);
    return { blob: new Blob([bytes], { type: 'video/mp4' }), metadata: sourceMetadata, engine: 'ffmpeg' };
  } finally {
    ffmpeg.off('progress', progress);
    ffmpeg.off('log', onLog);
    for (const path of [input, output, manifest, ...paths]) await ffmpeg.deleteFile(path).catch(() => {});
  }
}

