import { STR } from './sz-strings.js';

export function wireDroneWatch({ drones, controllerManager, cameraSystem, touchControls, gamepadControls,
  laneAssist, autoDrive, cbdProgram, closePopovers, mapOpen, teleport, onCameraLabel }) {
  const droneHud = document.getElementById('drone-follow-hud');
  const droneStatus = document.getElementById('drone-follow-status');
  const droneRepeat = document.getElementById('drone-follow-repeat');
  const droneExit = document.getElementById('drone-follow-exit');
  const player = () => controllerManager.getActiveEntity();
  let watch = null;
  let feedbackTimer;
  function watchBlocked() {
    const entity = player();
    return Boolean(watch || autoDrive.active || cbdProgram.active || cameraSystem.landmarkOrbit
      || entity.jumping || Math.abs(entity.speed) > 0.45 || Math.abs(entity.verticalSpeed ?? 0) > 0.35
      || controllerManager.occupant.timer > 0);
  }

  function follow(station, demo) {
    if (!station || watchBlocked()) return false;
    const mission = drones.start(station.id, demo, player().position);
    if (!mission) return false;
    watch = { mission, station, safe: Boolean(controllerManager.findModePosition(controllerManager.activeMode)) };
    laneAssist.cancel();
    controllerManager.resetInput();
    touchControls.setEnabled(false);
    gamepadControls.reset();
    closePopovers();
    cameraSystem.startDroneFollow(mission.pose, (target, desired) =>
      drones.cameraClear(target, desired, controllerManager));
    onCameraLabel(STR.drones.followMode);
    clearTimeout(feedbackTimer);
    droneExit.hidden = false;
    droneHud.hidden = false;
    document.body.dataset.droneFollow = '';
    droneExit.focus({ preventScroll: true });
    return true;
  }

  function stop(failed = false) {
    if (!watch) return;
    const { station, safe } = watch;
    watch = null;
    drones.stopFollowing();
    cameraSystem.stopDroneFollow();
    controllerManager.resetInput();
    touchControls.setEnabled(!mapOpen());
    gamepadControls.reset();
    droneHud.hidden = !failed;
    droneExit.hidden = failed;
    droneRepeat.hidden = true;
    delete document.body.dataset.droneFollow;
    if (safe && !controllerManager.findModePosition(controllerManager.activeMode)) {
      const { position, heading } = player();
      const fallback = controllerManager.activeMode === 'person' && station.approach;
      const arrived = fallback && controllerManager.teleportActiveTo(fallback.x, fallback.z, fallback.heading, null, { exact: true });
      if (!arrived) controllerManager.teleportActiveTo(position.x, position.z, heading, position.y, { requireArrival: true });
      cameraSystem.resetForTeleport();
    }
    onCameraLabel(cameraSystem.getActivePreset().name);
    if (failed) {
      droneStatus.textContent = STR.drones.failed;
      feedbackTimer = setTimeout(() => { droneHud.hidden = true; }, 3500);
    }
  }
  droneExit.addEventListener('click', () => stop());
  window.addEventListener('keydown', event => {
    if (event.code === 'Escape') stop();
  });
  droneRepeat.addEventListener('click', () => { if (watch) drones.repeat(watch.mission); });

  function update(dt) {
    if (!watch) return false;
    const { mission } = watch;
    if (!drones.isActive(mission) || !cameraSystem.updateDroneFollow(dt)) {
      stop(true);
      return false;
    }
    const phase = STR.drones.phase[mission.pose.phase];
    const label = (mission.demo ? STR.drones.simulation : STR.drones.followMode) + ' · '
      + (mission.pose.returning && mission.pose.phase !== 'complete' ? STR.drones.returning(phase) : phase);
    if (droneStatus.textContent !== label) droneStatus.textContent = label;
    droneRepeat.hidden = mission.pose.phase !== 'complete' || mission.pose.rotors > 0;
    return true;
  }

  return {
    get active() { return Boolean(watch); }, update, stop,
    map: {
      stations: drones.stations, routes: drones.routes,
      status(stationId) {
        const status = drones.status(stationId, player().position);
        return { ...status, blocked: status.nearby && watchBlocked(),
          canApproach: !watch && controllerManager.activeMode === 'person' };
      },
      preview: stationId => drones.preview(stationId),
      approach: station => !watch && controllerManager.activeMode === 'person' && station?.approach
        && teleport(station.approach.x, station.approach.z, station.approach.heading,
          { exact: true, waypoint: { x: station.x, z: station.z, name: station.name } }),
      follow
    }
  };
}
