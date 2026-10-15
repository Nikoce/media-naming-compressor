const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
let detectorLoading;

export function speechRegionsFromFrames(frames, duration) {
  const regions = [];
  let start = null;
  let lastVoice = null;
  const finish = () => {
    if (start !== null && lastVoice - start >= 0.096) {
      const region = { start: Math.max(0, start - 0.16), end: Math.min(duration, lastVoice + 0.16) };
      const previous = regions.at(-1);
      if (previous && region.start - previous.end <= 0.12) previous.end = region.end;
      else regions.push(region);
    }
    start = null;
  };
  for (const frame of frames) {
    if (frame.probability >= 0.5) { start ??= frame.start; lastVoice = frame.end; }
    if (start !== null && frame.end - lastVoice >= 0.16) finish();
  }
  finish();
  return regions;
}

// State and context are created per video, never shared between batch items.
export function createSpeechDetector(session, Tensor) {
  return async (audio) => {
    let state = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
    const rate = new Tensor('int64', BigInt64Array.of(16000n), []);
    const context = new Float32Array(CONTEXT_SAMPLES);
    const frames = [];
    try {
      for (let offset = 0; offset < audio.length; offset += WINDOW_SAMPLES) {
        const input = new Float32Array(WINDOW_SAMPLES + CONTEXT_SAMPLES);
        input.set(context);
        input.set(audio.subarray(offset, offset + WINDOW_SAMPLES), CONTEXT_SAMPLES);
        const tensor = new Tensor('float32', input, [1, input.length]);
        let result;
        try { result = await session.run({ input: tensor, state, sr: rate }); }
        finally { tensor.dispose?.(); }
        state.dispose?.();
        state = result.stateN;
        context.set(input.subarray(WINDOW_SAMPLES));
        frames.push({ start: offset / SAMPLE_RATE, end: Math.min(offset + WINDOW_SAMPLES, audio.length) / SAMPLE_RATE, probability: result.output.data[0] });
        result.output.dispose?.();
      }
      return speechRegionsFromFrames(frames, audio.length / SAMPLE_RATE);
    } finally { state.dispose?.(); rate.dispose?.(); }
  };
}

export async function detectSpeechRegions(audio) {
  detectorLoading ??= (async () => {
    // The ASR pipeline has already initialised this same ONNX runtime. Reuse it
    // rather than downloading another WASM engine or another speech recognizer.
    const { InferenceSession, Tensor } = await import('onnxruntime-web');
    const response = await fetch(new URL('./assets/silero-vad.onnx', import.meta.url));
    if (!response.ok) throw new Error('语音边界模型加载失败');
    const session = await InferenceSession.create(await response.arrayBuffer(), { executionProviders: ['wasm'] });
    return createSpeechDetector(session, Tensor);
  })().catch((error) => { detectorLoading = null; throw error; });
  return (await detectorLoading)(audio);
}
