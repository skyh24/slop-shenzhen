// 近景驻留：一个细节单位按相机距离进入、离开，规则只写一份。
// 进入与离开用两个半径形成迟滞；创建推迟到 schedule 里执行，执行前重新核对最新意图，
// 因此离开后排队的结果不会挂载，重进也只会创建一个。释放只调用单位自己的 dispose，
// 共享材质与几何仍由创建它们的区域场景统一释放。
// 建筑近景分块不走这里：它按帧预算同步生成，没有排队结果要作废。

function requireDistance(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`A detail residency requires a finite ${label}`);
  return value;
}

export function createDetailResidency({ enterM, exitM = enterM, schedule = task => task() } = {}) {
  requireDistance(enterM, 'enter distance');
  requireDistance(exitM, 'exit distance');
  if (exitM < enterM) throw new Error('A detail residency exit distance cannot be shorter than its enter distance');
  if (typeof schedule !== 'function') throw new Error('A detail residency requires a schedule function');
  let live = null;
  let desired = false;
  let pending = false;
  let disposed = false;

  function release() {
    if (!live) return;
    const unit = live;
    live = null;
    unit.dispose();
  }

  function run(build) {
    pending = false;
    if (disposed || live || !desired) return;
    const unit = build();
    if (unit) live = unit;
  }

  return {
    /** 当前是否持有已创建的近景单位。 */
    get active() { return Boolean(live); },
    /**
     * 用最新距离推进一帧：进入半径内安排一次创建，离开半径外立即释放。
     * 返回当前单位（仍在排队时返回 null），调用方可据此推进自己的动画。
     */
    update(distance, build) {
      if (disposed) throw new Error('A detail residency cannot update after dispose');
      if (!Number.isFinite(distance)) throw new Error('A detail residency update requires a finite distance');
      if (typeof build !== 'function') throw new Error('A detail residency update requires a build function');
      desired = distance <= enterM;
      if (live && distance > exitM) release();
      else if (!live && desired && !pending) {
        pending = true;
        try {
          schedule(() => run(build));
        } catch (error) {
          pending = false;
          throw error;
        }
      }
      return live;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      desired = false;
      release();
    }
  };
}
