import test from 'node:test';
import assert from 'node:assert/strict';
import { cuesFromWords, hardCutCues } from './caption-timing.js';

test('short captions follow speech and leave a long pause blank', () => {
  const cues = cuesFromWords([
    { text: ' Hello', timestamp: [1, 1.35] },
    { text: ' world.', timestamp: [1.4, 1.8] },
    { text: ' Again', timestamp: [4, 4.4] },
  ]);
  assert.deepEqual(cues.map(({ text }) => text), ['Hello world.', 'Again']);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 1.8);
  assert.equal(cues[1].start, 4);
});

test('continuous speech is split into short, nonoverlapping cues', () => {
  const words = Array.from({ length: 18 }, (_, i) => ({
    text: ` word${i}`,
    timestamp: [i * 0.3 + 1, i * 0.3 + 1.25],
  }));
  const cues = cuesFromWords(words);
  assert.ok(cues.length > 1);
  for (const cue of cues) {
    assert.ok(cue.end - cue.start <= 2.3);
    assert.ok(cue.text.length <= 36);
  }
  for (let i = 1; i < cues.length; i += 1) assert.ok(cues[i - 1].end <= cues[i].start);
});

test('a long final word timestamp does not hold the caption through silence', () => {
  const [cue] = cuesFromWords([{ text: ' hello', timestamp: [1, 8] }]);
  assert.ok(cue.end < 3);
});

test('Chinese words remain together without inserted spaces and split at punctuation', () => {
  const cues = cuesFromWords([
    { text: '你好', timestamp: [1, 1.4] },
    { text: '，', timestamp: [1.4, 1.42] },
    { text: '世界。', timestamp: [1.45, 1.9] },
    { text: '再见', timestamp: [2, 2.4] },
  ]);
  assert.deepEqual(cues.map(({ text }) => text), ['你好，世界。', '再见']);
  assert.ok(cues[0].end <= cues[1].start);
});

test('an inflated word end does not fill the pause before the next phrase', () => {
  const cues = cuesFromWords([
    { text: ' Hello', timestamp: [1, 8] },
    { text: ' again', timestamp: [5, 5.4] },
  ]);
  assert.equal(cues.length, 2);
  assert.ok(cues[0].end < 3);
  assert.equal(cues[1].start, 5);
});

test('English sentence endings split cues and hyphenated words keep their spelling', () => {
  const cues = cuesFromWords([
    { text: ' Try', timestamp: [1, 1.2] },
    { text: ' this.', timestamp: [1.2, 1.6] },
    { text: ' No', timestamp: [1.7, 1.9] },
    { text: ' Wi', timestamp: [1.9, 2.1] },
    { text: ' -', timestamp: [2.1, 2.12] },
    { text: 'Fi', timestamp: [2.12, 2.4] },
  ]);
  assert.deepEqual(cues.map(({ text }) => text), ['Try this.', 'No Wi-Fi']);
});

test('a duration split keeps too many ads together', () => {
  const words = [
    ['This', 0.24, 0.54], ['game', 0.54, 0.82], ['is', 0.82, 1.02],
    ['so', 1.02, 1.2], ['bad', 1.2, 1.76], ['too', 1.82, 2.08],
    ['many', 2.08, 2.36], ['ads', 2.36, 2.72],
  ].map(([text, start, end]) => ({ text: ` ${text}`, timestamp: [start, end] }));
  const cues = cuesFromWords(words);
  assert.deepEqual(cues.map(({ text }) => text), ['This game is so bad', 'too many ads']);
  assert.equal(cues[1].start, 1.82);
});

test('a genuine pause keeps its boundary even after a modifier', () => {
  const cues = cuesFromWords([
    { text: ' too', timestamp: [1, 1.2] },
    { text: ' many', timestamp: [2, 2.3] },
    { text: ' ads', timestamp: [2.3, 2.6] },
  ]);
  assert.deepEqual(cues.map(({ text }) => text), ['too', 'many ads']);
  assert.equal(cues[0].end, 1.2);
});

test('a comma can end a spoken clause before the next phrase', () => {
  const cues = cuesFromWords([
    { text: ' It', timestamp: [1, 1.2] },
    { text: ' has', timestamp: [1.2, 1.4] },
    { text: ' great', timestamp: [1.4, 1.7] },
    { text: ' ratings,', timestamp: [1.7, 2.1] },
    { text: ' lots', timestamp: [2.2, 2.5] },
    { text: ' of', timestamp: [2.5, 2.7] },
    { text: ' good', timestamp: [2.7, 3] },
    { text: ' reviews', timestamp: [3, 3.4] },
  ]);
  assert.deepEqual(cues.map(({ text }) => text), ['It has great ratings,', 'lots of good reviews']);
});

test('a short clause ending at a comma is preferred when a later word overflows', () => {
  const words = [
    ['It', 1, 1.1], ['has', 1.1, 1.22], ['great', 1.22, 1.42],
    ['ratings,', 1.42, 1.75], ['lots', 1.8, 2.06], ['of', 2.06, 2.2],
    ['good', 2.2, 2.52], ['reviews', 2.52, 2.9],
  ].map(([text, start, end]) => ({ text: ` ${text}`, timestamp: [start, end] }));
  assert.deepEqual(cuesFromWords(words).map(({ text }) => text), [
    'It has great ratings,', 'lots of good reviews',
  ]);
});

test('a conjunction starts the next clause when the final adjective would overflow', () => {
  const words = [
    ['too', 2, 2.2], ['many', 2.2, 2.5], ['ads', 2.5, 2.8],
    ['and', 2.8, 3.02], ['the', 3.02, 3.2], ['reviews', 3.2, 3.52],
    ['are', 3.52, 3.76], ['terrible.', 3.76, 4.2],
  ].map(([text, start, end]) => ({ text: ` ${text}`, timestamp: [start, end] }));
  assert.deepEqual(cuesFromWords(words).map(({ text }) => text), [
    'too many ads', 'and the reviews are terrible.',
  ]);
});

test('manual overlaps are cut at the next cue start', () => {
  assert.deepEqual(hardCutCues([
    { start: 2, end: 4, text: 'second' },
    { start: 0, end: 3, text: 'first' },
  ]), [
    { start: 0, end: 2, text: 'first' },
    { start: 2, end: 4, text: 'second' },
  ]);
});

test('common abbreviations do not end a cue before the name', () => {
  const cues = cuesFromWords([
    { text: ' Dr.', timestamp: [0, 0.2] },
    { text: ' Smith', timestamp: [0.2, 0.5] },
    { text: ' arrived.', timestamp: [0.5, 0.9] },
  ]);
  assert.deepEqual(cues.map(({ text }) => text), ['Dr. Smith arrived.']);
});

test('a long Chinese chunk prefers a punctuation boundary and respects width', () => {
  const cues = cuesFromWords([{
    text: '这个玩法很有意思，但是广告真的太多了，希望能够改进。',
    timestamp: [0, 2.2],
  }]);
  assert.ok(cues.length >= 2);
  assert.ok(cues[0].text.endsWith('，'));
  assert.equal(cues.map(({ text }) => text).join(''), '这个玩法很有意思，但是广告真的太多了，希望能够改进。');
  assert.ok(cues.every(({ text }) => [...text].length <= 18));
});
