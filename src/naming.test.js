import test from 'node:test';
import assert from 'node:assert/strict';
import { durationPart, normalizeTheme } from './naming.js';

test('theme joins words and removes whitespace, punctuation and symbols', () => {
  for (const [value, expected] of [
    ['Brain Training', 'BrainTraining'],
    ['brain training', 'BrainTraining'],
    ['brain-training game', 'BrainTrainingGame'],
    ['brainTraining', 'BrainTraining'],
    [' Brain-Training_!@#$%^&*()[]{}.,/\\:;\"\'<>?=+|~` ', 'BrainTraining'],
    ['Brain\tTraining\n\u00a0Game', 'BrainTrainingGame'],
    ['脑力，训练！ 2', '脑力训练2'],
    ['Café déjà-vu', 'CaféDéjàVu'],
    ['Cafe\u0301 Training 🎮', 'Cafe\u0301Training'],
    ['—–－，。！？', ''], [null, ''], [undefined, ''],
  ]) assert.equal(normalizeTheme(value), expected);
});

test('H field reserves hyphens for its prefix and automatic sequence', () => {
  const theme = normalizeTheme('Brain - Training!');
  const field = `H-${theme}-01`;
  assert.equal(field, 'H-BrainTraining-01');
  assert.equal((field.match(/-/g) || []).length, 2);
  assert.equal(normalizeTheme(theme), theme);
});

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
