// 车辆通过信号路口只有一条状态链：排队请求随目标进向刷新，出口被占时不占用，
// 占用只在车尾离开冲突区后释放。车辆尺寸、出口探测、路径推进和仲裁规则仍由调用方持有。
const REQUEST_WINDOW = 4;

export function createJunctionParticipant(control, actorId) {
  let target = null;
  let request = null;
  let reservation = null;
  const controlled = Boolean(control) && actorId !== undefined;

  function cancel() {
    if (!controlled || request === null) return;
    control.cancelRequest(request, actorId);
    request = null;
  }

  return {
    // 当前占用的进向；回收、离场和取消除外，调用方不应直接改动。
    get reservation() { return reservation; },
    // 是否还有排队请求，供巡航续接和换道判断避让。
    get requesting() { return request !== null; },

    // 每帧排队：目标进向变化或离开请求窗口时撤销旧请求；窗口内按出口状态刷新就绪标记，
    // 并给出是否必须停在停止线前。phaseHeld 只表示灯色、他车占用或行人造成的等待。
    wait(approach, elapsedSeconds, { distance = Infinity, paused = false, exitBlocked = false } = {}) {
      target = approach ?? null;
      if (!controlled) return { held: false, phaseHeld: false, phase: null };
      if (request !== null && request !== target) cancel();
      if (reservation !== null) return { held: false, phaseHeld: false, phase: null };
      if (target === null) { cancel(); return { held: false, phaseHeld: false, phase: null }; }
      if (paused || !(distance <= REQUEST_WINDOW)) cancel();
      else { control.request(target, actorId, elapsedSeconds, !exitBlocked); request = target; }
      const phaseHeld = !control.canEnter(target, elapsedSeconds, actorId);
      return { held: phaseHeld || Boolean(exitBlocked), phaseHeld,
        phase: control.vehiclePhase(target, elapsedSeconds) };
    },

    // 越过停止线时调用：出口仍有阻塞就保持未就绪并拒绝进入；进入成功才取得占用。
    enter(elapsedSeconds, exitBlocked = false) {
      if (!controlled || target === null || reservation !== null) return { ok: true, entered: false };
      if (exitBlocked) {
        control.request(target, actorId, elapsedSeconds, false);
        request = target;
        return { ok: false, entered: false };
      }
      if (!control.enter(target, elapsedSeconds, actorId)) return { ok: false, entered: false };
      reservation = target;
      request = null;
      return { ok: true, entered: true };
    },

    // 车尾离开冲突区（cleared）才释放；返回是否已不再占用。
    release(cleared) {
      if (reservation === null) return true;
      if (!controlled || !cleared) return false;
      control.release(reservation, actorId);
      reservation = null;
      return true;
    },

    // 停车、暂停、人工接管：撤销排队请求，已取得的占用保留到车尾离开。
    suspend() { cancel(); },

    // 回收、弃线：取消请求并释放占用。
    abandon() {
      cancel();
      if (controlled && reservation !== null) control.release(reservation, actorId);
      reservation = null;
    }
  };
}
