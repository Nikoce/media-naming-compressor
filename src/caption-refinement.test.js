import test from 'node:test';
import assert from 'node:assert/strict';
import { refineWordTimestamps, needsTimestampRefinement } from './caption-refinement.js';
import { recognizeCaptions, speechChunks } from './caption-recognition.js';

const cases = [
  { wordEnd: 3.98, spokenStart: 3.72, nextStart: 4.26, nextEnd: 4.88, segmentEnd: 7.12 },
  { wordEnd: 3.7, spokenStart: 3.36, nextStart: 3.96, nextEnd: 4.5, segmentEnd: 5.24 },
];

for (const [index, sample] of cases.entries()) {
  test(`CatBand ${index + 1}: Guys appears with the spoken sentence after the music intro`, async () => {
    const original = [
      { text: ' Guys,', timestamp: [0, sample.wordEnd] },
      { text: ' seriously?', timestamp: [sample.nextStart, sample.nextEnd] },
    ];
    const calls = [];
    const recognizer = async (audio, options) => {
      calls.push(options.return_timestamps);
      return { chunks: options.return_timestamps === 'word' ? original : [
        { text: ' [MUSIC PLAYING]', timestamp: [0, sample.spokenStart] },
        { text: ' Guys, seriously? Go away.', timestamp: [sample.spokenStart, sample.segmentEnd] },
      ] };
    };
    const result = await recognizeCaptions(recognizer, new Float32Array(16000 * 10.08));
    assert.deepEqual(calls, ['word', true]);
    assert.equal(result.refinedCount, 1);
    assert.equal(result.reviewNeeded, false);
    assert.deepEqual(result.cues[0], { text: 'Guys, seriously?', start: sample.spokenStart, end: sample.nextEnd });
    const refined = refineWordTimestamps(original, [{ text: 'Guys, seriously?', timestamp: [sample.spokenStart, sample.segmentEnd] }]);
    assert.deepEqual(refined.chunks[0].timestamp, [sample.spokenStart, sample.wordEnd]);
    assert.deepEqual(refined.chunks[1].timestamp, original[1].timestamp);
    assert.equal(original[0].timestamp[0], 0);
  });
}

test('normal speech uses one recognition pass without extra inference', async () => {
  let calls = 0;
  const result = await recognizeCaptions(async () => {
    calls++;
    return { chunks: [{ text: 'Hello.', timestamp: [2, 2.4] }] };
  }, new Float32Array(48000));
  assert.equal(calls, 1);
  assert.equal(result.cues[0].start, 2);
});

test('non-speech music annotations are not rendered as spoken captions', async () => {
  const result = await recognizeCaptions(async () => ({ chunks: [
    { text: '[music]', timestamp: [0.12, 3.36] },
    { text: 'Guys,', timestamp: [3.36, 3.9] },
    { text: '(Hello)', timestamp: [5, 5.5] },
  ] }), new Float32Array(96000));
  assert.deepEqual(result.cues.map((cue) => cue.text), ['Guys,', '(Hello)']);
  assert.equal(result.cues[0].start, 3.36);
});

test('unmatched or invalid sentence boundaries are flagged instead of shifting to an unrelated phrase', () => {
  const words = [{ text: ' Guys,', timestamp: [0, 3.98] }];
  assert.equal(needsTimestampRefinement(words), true);
  const result = refineWordTimestamps(words, [
    { text: 'Good morning.', timestamp: [3.4, 4.5] },
    { text: 'Guys!', timestamp: [NaN, 4] },
    { text: 'Guys!', timestamp: [8, 9] },
  ]);
  assert.deepEqual(result.chunks, words);
  assert.equal(result.unresolvedCount, 1);
});

test('matching context disambiguates a repeated first word', () => {
  const words = [{ text: ' Hello', timestamp: [0, 4] }, { text: ' friend.', timestamp: [4, 4.4] }];
  const result = refineWordTimestamps(words, [
    { text: 'Hello there.', timestamp: [1, 2] },
    { text: 'Hello friend.', timestamp: [3.6, 4.4] },
  ]);
  assert.deepEqual(result.chunks[0].timestamp, [3.6, 4]);
});

test('split bracketed annotations are removed while spoken words and unknown annotations remain', async () => {
  const result = await recognizeCaptions(async () => ({ chunks: [
    { text: '[MUSIC', timestamp: [0, 2] }, { text: 'PLAYING]', timestamp: [2, 3] },
    { text: 'Say', timestamp: [3.5, 3.8] }, { text: 'music.', timestamp: [3.8, 4.2] },
    { text: '(Hello)', timestamp: [5, 5.4] },
  ] }), new Float32Array(6 * 16000));
  assert.equal(result.cues.map(cue => cue.text).join(' '), 'Say music. (Hello)');
  assert.equal(result.cues[0].start, 3.5);
});

test('sound labels never reach cues even when inline, split, or outside a fixed label vocabulary', () => {
  const original = [
    { text: '[MUSIC', timestamp: [0, 1] }, { text: 'PLAYING] Hello.', timestamp: [1, 2] },
    { text: '[door closes] Again.', timestamp: [3, 4] },
    { text: '【掌声】', timestamp: [4, 5] }, { text: '(LAUGHTER)', timestamp: [5, 6] },
    { text: '[BLANK_AUDIO]', timestamp: [6, 7] }, { text: '♪ Goodbye. ♪', timestamp: [7, 8] },
  ];
  const filtered = speechChunks(original);
  assert.deepEqual(filtered.map(chunk => chunk.text.trim()), ['Hello.', 'Again.', 'Goodbye.']);
  assert.deepEqual(filtered.map(chunk => chunk.timestamp), [[1, 2], [3, 4], [7, 8]]);
  assert.equal(original[0].text, '[MUSIC');
});
