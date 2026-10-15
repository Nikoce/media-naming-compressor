import test from 'node:test';
import assert from 'node:assert/strict';
import { canAutoRefresh, parseReleaseManifest } from './app-updates.js';
import { RELEASE } from './release-notes.js';

test('update manifests reject partial deployments and malformed release notes', () => {
  const manifest = { schema: 1, buildId: 'next-build', ...RELEASE };
  assert.equal(parseReleaseManifest(manifest), manifest);
  for (const value of [null, {}, { ...manifest, schema: 2 }, { ...manifest, buildId: '' },
    { ...manifest, version: 'invalid' }, { ...manifest, features: [null] },
    { ...manifest, features: [] }, { ...manifest, title: 'a'.repeat(101) }]) {
    assert.equal(parseReleaseManifest(value), null);
  }
});

test('automatic refresh requires a visible idle page and cannot loop after a stale reload', () => {
  const idle = { hasWork: false, processing: false, visible: true, dismissed: false, attempted: false };
  assert.equal(canAutoRefresh(idle), true);
  for (const blocked of [
    { hasWork: true }, { processing: true }, { visible: false }, { dismissed: true }, { attempted: true },
  ]) assert.equal(canAutoRefresh({ ...idle, ...blocked }), false);
});
