import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreEntry = fileURLToPath(import.meta.resolve('@ffmpeg/core'));
const coreDir = path.dirname(coreEntry);
const targetDir = path.resolve('public', 'ffmpeg');

await mkdir(targetDir, { recursive: true });
await Promise.all([
  copyFile(path.join(coreDir, 'ffmpeg-core.js'), path.join(targetDir, 'ffmpeg-core.js')),
  copyFile(path.join(coreDir, 'ffmpeg-core.wasm'), path.join(targetDir, 'ffmpeg-core.wasm')),
]);

console.log(`Synced FFmpeg core assets to ${targetDir}`);
