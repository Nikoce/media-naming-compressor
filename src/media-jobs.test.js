import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaJobRunner } from './media-jobs.js';

test('FFmpeg transactions cannot overlap, and a failed job releases the queue', async () => {
  const run = createMediaJobRunner(null);
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = run(async () => { events.push('first start'); await gate; events.push('first cleanup'); throw new Error('failed'); });
  const second = run(async () => { events.push('second start'); return 42; });
  const failure = assert.rejects(first, /failed/);
  await Promise.resolve();
  assert.deepEqual(events, ['first start']);
  release(); await failure;
  assert.equal(await second, 42);
  assert.deepEqual(events, ['first start', 'first cleanup', 'second start']);
});

test('different windows use the same exclusive Web Lock', async () => {
  const names = [];
  const locks = { async request(name, options, task) { names.push(name); assert.equal(options.mode, 'exclusive'); return task(); } };
  const windowA = createMediaJobRunner(locks);
  const windowB = createMediaJobRunner(locks);
  assert.deepEqual(await Promise.all([windowA(() => 'A'), windowB(() => 'B')]), ['A', 'B']);
  assert.equal(names[0], names[1]);
});
