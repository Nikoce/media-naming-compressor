import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingVideoSource, matchesVideoSource, readVideoSource } from './video-source.js';

test('missing browser file becomes a recoverable source error', async () => {
  const file = {
    name: 'clip.mp4',
    arrayBuffer: async () => { throw new DOMException('The file is gone', 'NotFoundError'); },
  };
  await assert.rejects(readVideoSource(file), (error) => {
    assert.equal(error.sourceUnavailable, true);
    assert.match(error.message, /重新选择原视频/);
    return true;
  });
  assert.equal(isMissingVideoSource(new Error('File could not be read! Code=8')), true);
});

test('readable sources return their bytes and unrelated errors stay visible', async () => {
  const bytes = await readVideoSource({ name: 'clip.mp4', arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer });
  assert.deepEqual([...bytes], [1, 2, 3]);
  const other = new Error('Out of memory');
  await assert.rejects(readVideoSource({ name: 'clip.mp4', arrayBuffer: async () => { throw other; } }), other);
});

test('relink accepts the same source name and size', () => {
  const original = { name: 'clip.mp4', size: 123 };
  assert.equal(matchesVideoSource(original, { name: 'clip.mp4', size: 123 }), true);
  assert.equal(matchesVideoSource(original, { name: 'other.mp4', size: 123 }), false);
  assert.equal(matchesVideoSource(original, { name: 'clip.mp4', size: 122 }), false);
});
