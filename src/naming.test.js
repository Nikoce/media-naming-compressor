import test from 'node:test';
import assert from 'node:assert/strict';
import { durationPart, normalizeTheme, parseMediaName, resolveNamingValues } from './naming.js';

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

test('recognizes complete media names and removes only the automatic H sequence', () => {
  assert.deepEqual(parseMediaName('260928_P-A11_H-BrainTraining-01_VL-M-15_S-916_L-en_D-Niko_M-0.1.mp4'), {
    date: '260928', product: 'A11', theme: 'BrainTraining', duration: '15', ratio: '916',
    language: 'en', maker: 'Niko', productionTime: '0.1',
  });
  const legacy = parseMediaName('260928_P-A11_H-Level2_VL-15_S-169_L-zh-CN_D-Alex_M-2.MOV');
  assert.equal(legacy.theme, 'Level2');
  assert.equal(legacy.language, 'zh-cn');
  assert.equal(legacy.ratio, '169');
  assert.equal(parseMediaName('260928_P-A11_H-BrainTraining-100_VL-M-15_S-916_L-en_D-Niko_M-0.1.webm').theme, 'BrainTraining');
});

test('does not infer naming fields from ordinary or incomplete filenames', () => {
  for (const name of ['clip_L-en.mp4', 'my video.mp4', '', null,
    '260928_P-A11_H-Test.mp4',
    '260230_P-A11_H-Test_VL-S-5_S-916_L-en_D-Niko_M-0.1.mp4']) {
    assert.equal(parseMediaName(name), null);
  }
});

test('keeps each source naming until a field is explicitly edited', () => {
  const first = parseMediaName('260928_P-A11_H-BrainTraining-01_VL-M-15_S-916_L-en_D-Niko_M-0.1.mp4');
  const second = { ...first, product: 'B22', theme: 'Other', maker: 'Alex' };
  const defaults = { date: '261014', product: '', theme: '', language: '', maker: 'Niko', productionTime: '' };
  assert.equal(resolveNamingValues(second, defaults).product, 'B22');
  assert.equal(resolveNamingValues(second, defaults).maker, 'Alex');
  const overrides = new Set(['product', 'theme']);
  const edited = { ...defaults, product: 'C33', theme: 'NewTheme' };
  assert.equal(resolveNamingValues(first, edited, overrides).product, 'C33');
  assert.equal(resolveNamingValues(second, edited, overrides).theme, 'NewTheme');
  assert.equal(resolveNamingValues(second, edited, overrides).maker, 'Alex');
  assert.equal(resolveNamingValues(first, defaults, overrides).product, '');
  assert.deepEqual(resolveNamingValues(null, edited), edited);
});
