// 同一时刻只允许一个观察功能写入相机。目标和落点验证完成后才切换会话。
export function createObservationSessions() {
  let current = null;
  const registered = new Set();

  function close(reason) {
    const session = current;
    current = null;
    session.exit(session.target, session.snapshot, reason);
  }

  function bind(id, { prepare, commit, capture, enter, update, exit, isCurrent,
    restart = false, replaces }) {
    if (registered.has(id)) throw new Error(`Duplicate observation session: ${id}`);
    registered.add(id);

    function activeSession() {
      if (current?.isCurrent && !current.isCurrent()) close('superseded');
      return current;
    }

    function canEnter() {
      const session = activeSession();
      return !session || (restart && session.id === id) || session.id === replaces;
    }

    const isActive = () => activeSession()?.id === id;
    return {
      canEnter,
      get active() { return isActive(); },
      get target() { return isActive() ? current.target : null; },
      get snapshot() { return isActive() ? current.snapshot : null; },
      enter(request) {
        if (!canEnter()) return { ok: false, reason: 'busy' };
        const target = prepare(request);
        if (!target) return { ok: false, reason: 'invalid-target' };
        const previous = current?.id === id ? current : null;
        const snapshot = previous ? previous.snapshot : capture?.();
        if (commit && !commit(target, previous?.target)) return { ok: false, reason: 'unavailable' };
        if (current && !previous) close('replaced');
        current = { id, target, snapshot, exit, isCurrent };
        enter(target, previous?.target);
        return { ok: true };
      },
      update(...args) {
        if (isActive()) return update?.(current.target, ...args);
      },
      exit(reason = 'cancelled') {
        if (!isActive()) return false;
        close(reason);
        return true;
      }
    };
  }

  return { bind };
}

export function captureCameraState(camera) {
  return {
    preset: camera.activePresetId === 'landmarkOrbit' ? 'chase' : camera.activePresetId,
    yaw: camera.orbitYawOffset, pitch: camera.orbitPitchOffset, zoom: camera.zoomMultiplier,
    orbitTimer: camera.userOrbitTimer
  };
}

export function restoreCameraState(camera, selectCamera, state, restoreOrbitTimer = false) {
  selectCamera(state.preset, true);
  camera.orbitYawOffset = state.yaw;
  camera.orbitPitchOffset = state.pitch;
  camera.zoomMultiplier = state.zoom;
  if (restoreOrbitTimer) camera.userOrbitTimer = state.orbitTimer;
}

// 暂停会清除按住的输入，恢复时以当前全图状态为准。
export function setObservationInputBlocked({ controllerManager, touchControls, gamepadControls }, blocked) {
  controllerManager.resetInput();
  touchControls.setEnabled(!blocked);
  gamepadControls.reset();
}

export function setObservationPanel(panel, menuButton, active, restoreFocus = false) {
  if (panel.hidden === active) {
    panel.hidden = !active;
    menuButton.classList.toggle('active', active);
  }
  if (restoreFocus) menuButton.focus();
}

export function nearestObservationTarget(targets, { x, z }, radiusM, preferLast = false) {
  let nearest = null;
  let best = radiusM;
  for (const target of targets) {
    const distance = Math.hypot(x - target.x, z - target.z);
    if (!Number.isFinite(distance) || distance > best || (distance === best && nearest && !preferLast)) continue;
    nearest = target;
    best = distance;
  }
  return nearest;
}
