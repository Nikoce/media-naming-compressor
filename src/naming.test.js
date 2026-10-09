import test from 'node:test';
import assert from 'node:assert/strict';
import { durationPart } from './naming.js';

test('duration naming uses S, M and L at the range boundaries', () => {
  for (const [seconds, expected] of [
    [0, 'VL-S-0'], [10, 'VL-S-10'], [11, 'VL-M-11'],
    [20, 'VL-M-20'], [21, 'VL-L-21'], [30, 'VL-L-30'],
    [31, 'VL-L-31'], ['15', 'VL-M-15'],
  ]) assert.equal(durationPart(seconds), expected);
});

test('missing or invalid duration keeps the preview placeholder', () => {
  for (const value of ['', undefined, null, '时长', -1, Infinity]) {
    assert.equal(durationPart(value), 'VL-S-时长');
  }
});
