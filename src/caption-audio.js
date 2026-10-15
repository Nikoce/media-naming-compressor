export const ASR_SAMPLE_RATE = 16000;

// Keep the input timeline: pad a delayed audio track and repair timestamp gaps.
// Raw PCM avoids a second decode/resample through the device's AudioContext.
export function transcriptionAudioArgs(input, output) {
  return ['-y', '-i', input, '-map', '0:a:0', '-vn', '-ac', '1',
    '-af', `aresample=${ASR_SAMPLE_RATE}:async=1:first_pts=0`,
    '-ar', String(ASR_SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', output];
}

export function decodeTranscriptionPcm(bytes) {
  if (!bytes.byteLength || bytes.byteLength % 4) throw new Error('视频音频为空或采样数据不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getFloat32(index * 4, true);
  return samples;
}

export function transcriptionOptions({ language = 'en', englishOnly = false } = {}) {
  // Give words around a 30-second boundary enough context in both windows.
  return { ...(!englishOnly ? { task: 'transcribe', language } : {}), return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
}
