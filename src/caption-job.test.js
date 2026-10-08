import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionJob, fitCuesToDuration, cueAtTime } from './caption-job.js';

test('send captures independent captions, style and metadata without reading video bytes', () => {
  const source = { arrayBuffer() { throw new Error('send must not encode/read video'); } };
  const cues = [{ start: 0.1, end: 1.7, text: 'Original' }];
  const options = { positionY: 85 };
  const metadata = { duration: 2, width: 640, height: 360 };
  const job = createCaptionJob(source, cues, 'classic', options, metadata);
  cues[0].text = 'Edited in another view'; options.positionY = 50; metadata.width = 100;
  assert.equal(job.source, source);
  assert.equal(job.cues[0].text, 'Original');
  assert.equal(job.options.positionY, 85);
  assert.equal(job.metadata.width, 640);
  assert.throws(() => { job.cues[0].text = 'overwrite'; }, TypeError);
});

test('captions cover every frame in their interval and disappear during pauses', () => {
  const cues = fitCuesToDuration([{ start: 0.123, end: 1.4, text: 'First' }, { start: 1.7, end: 3, text: 'Second' }], 2.4);
  for (let i = 4; i < 42; i += 1) assert.equal(cueAtTime(cues, i / 30)?.text, 'First');
  assert.equal(cueAtTime(cues, 0.12), null);
  assert.equal(cueAtTime(cues, 1.4), null);
  assert.equal(cueAtTime(cues, 1.7)?.text, 'Second');
  assert.equal(cueAtTime(cues, 2.4), null);
});

test('overlaps hard cut and captions outside the video fail instead of silent export', () => {
  const cues = fitCuesToDuration([{ start: 1, end: 3, text: 'Old' }, { start: 2, end: 4, text: 'New' }], 3);
  assert.equal(cueAtTime(cues, 2).text, 'New');
  assert.equal(cues[1].end, 3);
  assert.throws(() => fitCuesToDuration([{ start: 4, end: 5, text: 'Missing' }], 3), /时长/);
});
