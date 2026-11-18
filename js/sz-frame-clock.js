// 帧时钟：把浏览器每帧的时间归成两个用途明确的读数，并集中“后台恢复不推进播放”的规则。
// simulation 是物理、交通、信号、人群共用的模拟秒数，单帧封顶；playback 是节目与巡游按真实经过时间
// 推进的播放秒数，不做封顶（各节目自定单帧上限）。绝对墙钟、昼夜参数和以上读数保持独立，互不覆盖：
// 昼夜切换只改光照参数，不会重置这里的累计模拟时间。

export const SIMULATION_MAX_DELTA = 0.05;
// 静止或高刷屏下保留最小步长，避免除零和动画冻结。
export const SIMULATION_MIN_DELTA = 0.001;

export function createFrameClock(startMs, { hidden = false } = {}) {
  let lastMs = startMs;
  let hiddenNow = Boolean(hidden);
  // 页面重新可见后的第一帧要把隐藏期间的间隔从播放时间里剔除。
  let resumePending = false;
  let elapsed = 0;
  // 每帧复用同一个读数对象，主循环不产生额外分配。
  const frame = { raw: 0, simulation: SIMULATION_MIN_DELTA, playback: 0, elapsed: 0 };
  return {
    get hidden() { return hiddenNow; },
    get elapsed() { return elapsed; },
    /** 可见性变化时调用；隐藏期间和重新可见的第一帧 playback 都是 0。 */
    setHidden(next) {
      const value = Boolean(next);
      if (value === hiddenNow) return;
      hiddenNow = value;
      if (!value) resumePending = true;
    },
    /** 丢弃从上一帧到 nowMs 的间隔（预热帧之后重新对齐循环）；累计模拟时间不回退。 */
    reset(nowMs = lastMs) {
      if (Number.isFinite(nowMs)) lastMs = nowMs;
      resumePending = false;
    },
    /** 推进一帧；nowMs 是 requestAnimationFrame 的毫秒时间戳。返回值每帧复用，调用方需立即读取。 */
    advance(nowMs) {
      const now = Number.isFinite(nowMs) ? Math.max(0, nowMs) : lastMs;
      const raw = Math.max(0, (now - lastMs) * 0.001);
      lastMs = now;
      const skipPlayback = hiddenNow || resumePending;
      resumePending = false;
      frame.raw = raw;
      frame.simulation = Math.min(Math.max(raw, SIMULATION_MIN_DELTA), SIMULATION_MAX_DELTA);
      frame.playback = skipPlayback ? 0 : raw;
      elapsed += frame.simulation;
      frame.elapsed = elapsed;
      return frame;
    }
  };
}
