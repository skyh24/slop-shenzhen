// 后台窗口的帧回调可能被暂停；用有期限的队列等待确认首帧完成。
export async function waitForFirstFrame(device, timeoutMs = 10000) {
  if (!device?.queue) return;
  let timer;
  try {
    await Promise.race([
      device.queue.onSubmittedWorkDone(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('First graphics frame timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
