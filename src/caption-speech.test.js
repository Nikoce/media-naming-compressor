import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechDetector, speechRegionsFromFrames } from './caption-speech.js';
import { mergeInstantaneousWords, refineWithSpeech, planRefinementWindows, timestampIssues, refineWordTimestamps, refineLocalWords } from './caption-refinement.js';
import { recognizeCaptions } from './caption-recognition.js';

test('speech gating ignores brief spikes, pads boundaries and merges short pauses', () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({ start: i * .032, end: (i + 1) * .032,
    probability: i === 1 || (i >= 20 && i < 30) || (i >= 40 && i < 50) ? .9 : .1 }));
  const regions = speechRegionsFromFrames(frames, 3.2);
  assert.equal(regions.length, 1);
  assert.ok(Math.abs(regions[0].start - .48) < 1e-6);
  assert.ok(Math.abs(regions[0].end - 1.76) < 1e-6);
  assert.deepEqual(speechRegionsFromFrames([], 0), []);
});

test('detector state and previous audio context reset for each batch item', async () => {
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
  const inputStates = [];
  const session = { run: async ({ input, state }) => {
    inputStates.push({ state: state.data[0], context: input.data[0] });
    return { stateN: new Tensor('float32', Float32Array.of(1), [1]), output: new Tensor('float32', Float32Array.of(.9), [1]) };
  } };
  const detect = createSpeechDetector(session, Tensor);
  await detect(new Float32Array(1024).fill(.5));
  await detect(new Float32Array(512).fill(.8));
  assert.deepEqual(inputStates, [{ state: 0, context: 0 }, { state: 1, context: .5 }, { state: 0, context: 0 }]);
});

for (const [text, shift] of [['Welcome', 0], ['你好', 43], ['Bonjour', 91]]) {
  test(`audio boundaries repair leading and trailing silence at arbitrary positions: ${text}`, () => {
    const original = [
      { text, timestamp: [shift, shift + 4] },
      { text: ' again.', timestamp: [shift + 4, shift + 7] },
    ];
    const result = refineWithSpeech(original, [{ start: shift + 3.6, end: shift + 4.6 }]);
    assert.deepEqual(result.chunks.map(x => x.timestamp), [[shift + 3.6, shift + 4], [shift + 4, shift + 4.6]]);
    assert.deepEqual(result.chunks.map(x => x.text), original.map(x => x.text));
    assert.equal(result.refinedCount, 2);
  });
}

test('normal short words get silence suppression without waiting for an inflated timestamp', async () => {
  let calls = 0;
  const result = await recognizeCaptions(async () => {
    calls++;
    return { chunks: [{ text: 'Ciao.', timestamp: [10, 10.8] }] };
  }, new Float32Array(12 * 16000), () => {}, { speechRegions: [{ start: 10.4, end: 10.9 }] });
  assert.equal(calls, 1);
  assert.deepEqual(result.cues, [{ text: 'Ciao.', start: 10.4, end: 10.8 }]);
});

test('a short word spanning two voiced events follows its phrase boundary', () => {
  const result = refineWithSpeech([
    { text: 'Earlier.', timestamp: [20, 20.4] },
    { text: ' Now', timestamp: [22, 25] },
    { text: ' listen.', timestamp: [25, 25.5] },
  ], [{ start: 20, end: 20.5 }, { start: 22, end: 22.5 }, { start: 24.7, end: 25.6 }]);
  assert.deepEqual(result.chunks[1].timestamp, [24.7, 25]);
});

test('a genuinely sustained word is retained through grouping', async () => {
  const result = await recognizeCaptions(async () => ({ chunks: [{ text: 'No!', timestamp: [4, 7] }] }),
    new Float32Array(8 * 16000), () => {}, { speechRegions: [{ start: 3.9, end: 7.1 }] });
  assert.deepEqual(result.cues, [{ text: 'No!', start: 4, end: 7 }]);
  assert.equal(result.reviewNeeded, false);
});

test('local repair restores absolute offsets and never retranscribes the whole long source', async () => {
  const audio = Float32Array.from({ length: 120 * 16000 }, (_, i) => i / 16000);
  const calls = [];
  const result = await recognizeCaptions(async (samples, options) => {
    calls.push({ seconds: samples.length / 16000, offset: samples[0] });
    return { chunks: options.return_timestamps === 'word' ? [
      { text: 'Before.', timestamp: [45, 45.5] },
      { text: ' Hola', timestamp: [49, 53] },
      { text: ' amigo.', timestamp: [53, 53.5] },
    ] : [{ text: 'Hola amigo.', timestamp: [5.5, 6.5] }] };
  }, audio);
  assert.deepEqual(calls, [{ seconds: 120, offset: 0 }, { seconds: 8, offset: 47 }]);
  assert.equal(result.cues[1].start, 52.5);
  assert.equal(result.cues[0].start, 45);
  assert.equal(result.reviewNeeded, false);
});

test('repair windows merge nearby issues and cap count and duration for distant ones', () => {
  const chunks = [5, 9, 40, 75, 110].map((start, i) => ({ text: `word${i}`, timestamp: [start, start + 3] }));
  const windows = planRefinementWindows(chunks, 120);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows[0].indices, [0, 1]);
  assert.ok(windows.every(window => window.end - window.start <= 20));
  assert.equal(planRefinementWindows([{ text: 'Hello', timestamp: [0, 118] }], 120)[0].end, 120);
});

test('missing, reversed and backward intervals are detected even beside verified words', () => {
  const chunks = [
    { text: 'One', timestamp: [4, 4.5], timingVerified: true },
    { text: 'two', timestamp: [3, 3.5] },
    { text: 'three', timestamp: [5, 4.9] },
    { text: 'four', timestamp: [null, null] },
  ];
  assert.deepEqual(timestampIssues(chunks, 10).map(x => x.index), [1, 2, 3]);
  assert.ok(planRefinementWindows(chunks, 10).every(window => window.start >= 0 && window.end <= 10));
});

test('unrelated or equally plausible repeated phrases cannot silently shift words', () => {
  const chunks = [{ text: 'Please', timestamp: [0, 6] }, { text: 'wait.', timestamp: [6, 6.4] }];
  for (const segments of [
    [{ text: 'Please leave.', timestamp: [4, 5] }],
    [{ text: 'Please wait.', timestamp: [3, 4] }, { text: 'Please wait.', timestamp: [5, 6.4] }],
  ]) {
    const result = refineWordTimestamps(chunks, segments);
    assert.deepEqual(result.chunks, chunks);
    assert.equal(result.unresolvedCount, 1);
  }
});

test('optional repair failures and words entirely outside detected speech retain text with a review flag', async () => {
  let calls = 0;
  const result = await recognizeCaptions(async () => {
    if (calls++) throw Error('Optional inference failed');
    return { chunks: [{ text: 'Review me.', timestamp: [6, 6.6] }] };
  }, new Float32Array(10 * 16000), () => {}, { speechRegions: [{ start: 2, end: 3 }] });
  assert.equal(calls, 2);
  assert.equal(result.cues[0].text, 'Review me.');
  assert.equal(result.reviewNeeded, true);
});

test('local word matching repairs a missing word inside a sentence without changing its neighbours', () => {
  const chunks = [
    { text: 'A', timestamp: [10, 10.2] }, { text: 'small', timestamp: [null, null] },
    { text: 'green', timestamp: [10.6, 10.8] }, { text: 'bird.', timestamp: [10.8, 11.2] },
  ];
  const local = [{ indices: [1], chunks: [
    { text: 'A', timestamp: [10, 10.2] }, { text: 'small', timestamp: [10.2, 10.6] },
    { text: 'green', timestamp: [10.6, 10.8] }, { text: 'bird.', timestamp: [10.8, 11.2] },
  ] }];
  const result = refineLocalWords(chunks, local, 12);
  assert.deepEqual(result.chunks[1].timestamp, [10.2, 10.6]);
  assert.equal(result.chunks[0], chunks[0]);
  assert.equal(result.chunks[2], chunks[2]);
  assert.equal(result.refinedCount, 1);
  const ambiguous = refineLocalWords(chunks, [{ ...local[0], chunks: [...local[0].chunks,
    ...local[0].chunks.map(chunk => ({ ...chunk, timestamp: chunk.timestamp.map(time => time + 2) }))] }], 15);
  assert.equal(ambiguous.refinedCount, 0);
  assert.deepEqual(ambiguous.chunks[1].timestamp, [null, null]);
});

test('unresolved issues beyond the inference budget remain flagged', async () => {
  let calls = 0;
  const result = await recognizeCaptions(async (audio, options) => {
    calls++;
    if (options.return_timestamps !== 'word') return { chunks: [] };
    return { chunks: [5, 35, 65, 95].map((start, i) => ({ text: `word${i}.`, timestamp: [start, start + 4] })) };
  }, new Float32Array(110 * 16000));
  assert.equal(calls, 4);
  assert.equal(result.cues.length, 4);
  assert.equal(result.reviewNeeded, true);
});

test('20/40 ms words and tied tokens do not cause unnecessary ASR or review flags', async () => {
  let calls = 0;
  const result = await recognizeCaptions(async () => {
    calls++;
    return { chunks: [
      { text: 'A', timestamp: [4, 4] }, { text: 'new', timestamp: [4, 4.24] },
      { text: 'route', timestamp: [4.24, 4.6] }, { text: 'is', timestamp: [4.6, 4.62] },
      { text: 'open.', timestamp: [4.62, 5] },
    ] };
  }, new Float32Array(6 * 16000), () => {}, { speechRegions: [{ start: 3.9, end: 5.1 }] });
  assert.equal(calls, 1);
  assert.equal(result.reviewNeeded, false);
  assert.equal(result.cues.map(cue => cue.text).join(' '), 'A new route is open.');
});

test('chains of zero spans attach only to nearby timed neighbours and preserve all text', () => {
  const chunks = [{ text: 'one', timestamp: [2, 2] }, { text: 'two', timestamp: [2, 2] }, { text: 'three', timestamp: [2, 2.4] }];
  const merged = mergeInstantaneousWords(chunks, 5);
  assert.deepEqual(merged.map(chunk => chunk.text), ['one two three']);
  assert.deepEqual(merged[0].timestamp, [2, 2.4]);
  assert.equal(chunks.length, 3);
  const unanchored = [{ text: 'Lost', timestamp: [3, 3] }, { text: 'Later.', timestamp: [5, 5.4] }];
  assert.equal(timestampIssues(mergeInstantaneousWords(unanchored), 6).length, 1);
  const reversed = [{ text: 'Bad', timestamp: [2, 1.9] }, { text: 'anchor', timestamp: [2, 2.2] }];
  assert.equal(timestampIssues(mergeInstantaneousWords(reversed), 6).length, 1);
  const atEnd = [{ text: 'Last', timestamp: [.99, .99] }, { text: 'Outside', timestamp: [1, 1.2] }];
  assert.equal(mergeInstantaneousWords(atEnd, 1)[0].text, 'Last');
});

test('language and English-only settings survive every optional local pass', async () => {
  const options = [];
  await recognizeCaptions(async (_, config) => {
    options.push(config);
    return { chunks: options.length === 1 ? [{ text: 'Bonjour.', timestamp: [2, 6] }] : [] };
  }, new Float32Array(10 * 16000), () => {}, { language: 'fr' });
  assert.equal(options.length, 2);
  assert.ok(options.every(option => option.language === 'fr' && option.task === 'transcribe'));
});

test('a collapsed short word recovers only uncovered voice and never crosses a pause', () => {
  const chunks = [{ text: 'Listen.', timestamp: [1, 1.3] }, { text: 'carefully.', timestamp: [4.85, 4.9] }];
  const voiced = refineWithSpeech(chunks, [{ start: .9, end: 1.4 }, { start: 4.3, end: 5 }]);
  assert.deepEqual(voiced.chunks[1].timestamp, [4.3, 4.9]);
  const paused = refineWithSpeech(chunks, [{ start: 3.9, end: 4.4 }, { start: 4.8, end: 5 }]);
  assert.deepEqual(paused.chunks[1].timestamp, [4.85, 4.9]);
});

test('a short word crossing two speech regions cannot drop its earlier voiced part', () => {
  const chunks = [{ text: 'We', timestamp: [6, 6.9] }, { text: 'agree.', timestamp: [6.9, 7.2] }];
  const result = refineWithSpeech(chunks, [{ start: 5.9, end: 6.3 }, { start: 6.6, end: 7.3 }]);
  assert.deepEqual(result.chunks[0].timestamp, [6, 6.9]);
  assert.equal(result.chunks[0].timingSuspect, true);
});

test('a compound from tied words retains speech on both sides of an internal pause', () => {
  const merged = mergeInstantaneousWords([{ text: 'I', timestamp: [6, 6] }, { text: 'agree.', timestamp: [6, 7.1] }]);
  const result = refineWithSpeech(merged, [{ start: 5.9, end: 6.25 }, { start: 6.6, end: 7.2 }]);
  assert.deepEqual(result.chunks[0].timestamp, [6, 7.1]);
  assert.equal(result.chunks[0].text, 'I agree.');
});
