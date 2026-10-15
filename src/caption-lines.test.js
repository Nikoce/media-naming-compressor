import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapCaptionLines } from './caption-lines.js';

const measure = (text) => [...text].reduce((sum, char) => sum + (/[^\x00-\xff]/u.test(char) ? 2 : 1), 0);

test('short text stays on one line', () => {
  assert.deepEqual(wrapCaptionLines('Hello world.', 20, measure), ['Hello world.']);
});

test('line breaks balance words without losing spaces or punctuation', () => {
  const text = 'This game has too many ads and bad reviews.';
  const lines = wrapCaptionLines(text, 26, measure);
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), text);
  assert.ok(lines.every((line) => measure(line) <= 26));
  assert.ok(lines.every((line) => !/^[,.!?]/u.test(line)));
});

test('Chinese punctuation stays with the preceding line', () => {
  const lines = wrapCaptionLines('这个游戏很好玩，但是广告太多了。', 18, measure);
  assert.equal(lines.join(''), '这个游戏很好玩，但是广告太多了。');
  assert.ok(lines.every((line) => !/^[，。！？]/u.test(line)));
});

test('long manually edited captions are not discarded', () => {
  const text = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen.';
  assert.equal(wrapCaptionLines(text, 18, measure).join(' '), text);
});
test('visual wrapping keeps grouped numeric expressions intact', () => {
  const lines = wrapCaptionLines('Over 12,345.67 people paid $89.50 at 8.5% interest', 22, text => text.length);
  for (const expression of ['12,345.67', '$89.50', '8.5%']) assert.ok(lines.some(line => line.includes(expression)));
  assert.equal(lines.join(' '), 'Over 12,345.67 people paid $89.50 at 8.5% interest');
});
