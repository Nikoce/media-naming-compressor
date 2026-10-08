export function isMissingVideoSource(error) {
  return error?.name === 'NotFoundError'
    || error?.name === 'NotReadableError'
    || /File could not be read! Code=(?:8|4)\b/.test(error?.message || '');
}

export async function readVideoSource(file) {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (!isMissingVideoSource(error)) throw error;
    const failure = new Error(`无法读取原视频「${file.name}」。请在视频队列中重新选择原视频，再重试导出。`);
    failure.sourceUnavailable = true;
    failure.cause = error;
    throw failure;
  }
}

export function matchesVideoSource(original, replacement) {
  return original.name === replacement.name && original.size === replacement.size;
}
