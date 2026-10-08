// One heavy media job per origin, including other tabs/windows. File state stays local.
export function createMediaJobRunner(locks = globalThis.navigator?.locks) {
  let tail = Promise.resolve();
  return (task, onWaiting = () => {}) => {
    onWaiting();
    const run = () => locks?.request
      ? locks.request('media-naming-compressor.encoding.v1', { mode: 'exclusive' }, task)
      : task();
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
}

export const runMediaJob = createMediaJobRunner();
