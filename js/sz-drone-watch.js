import { STR } from './sz-strings.js';
import { setObservationInputBlocked } from './sz-observation-session.js';

export function wireDroneWatch({ drones, controllerManager, cameraSystem, touchControls, gamepadControls,
  laneAssist, autoDrive, observationSessions, closePopovers, mapOpen, teleport, onCameraLabel }) {
  const droneHud = document.getElementById('drone-follow-hud');
  const droneStatus = document.getElementById('drone-follow-status');
  const droneRepeat = document.getElementById('drone-follow-repeat');
  const droneExit = document.getElementById('drone-follow-exit');
  const player = () => controllerManager.getActiveEntity();
  const inputs = { controllerManager, touchControls, gamepadControls };
  let feedbackTimer;
  const session = observationSessions.bind('drone-follow', {
    prepare({ station, demo, remote }) {
      return station && !watchBlocked() && { station, demo, remote };
    },
    commit(target) {
      target.mission = drones.start(target.station.id, target.demo, player().position, { remote: target.remote });
      return Boolean(target.mission);
    },
    enter: start,
    update: updateWatch,
    exit: endWatch
  });

  function watchBlocked() {
    const entity = player();
    return Boolean(!session.canEnter() || autoDrive.active
      || entity.jumping || Math.abs(entity.speed) > 0.45 || Math.abs(entity.verticalSpeed ?? 0) > 0.35
      || controllerManager.occupant.timer > 0);
  }

  function start(target) {
    target.safe = Boolean(controllerManager.findModePosition(controllerManager.activeMode));
    laneAssist.cancel();
    setObservationInputBlocked(inputs, true);
    closePopovers();
    cameraSystem.startDroneFollow(target.mission.pose, (origin, desired) =>
      drones.cameraClear(origin, desired, controllerManager));
    onCameraLabel(STR.drones.followMode);
    clearTimeout(feedbackTimer);
    droneExit.hidden = false;
    droneHud.hidden = false;
    document.body.dataset.droneFollow = '';
    droneExit.focus({ preventScroll: true });
  }

  function endWatch({ station, safe }, _snapshot, reason) {
    const failed = reason === 'lost-target';
    drones.stopFollowing();
    cameraSystem.stopDroneFollow();
    setObservationInputBlocked(inputs, mapOpen());
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
  function stop(failed = false) {
    session.exit(failed ? 'lost-target' : 'cancelled');
  }
  droneExit.addEventListener('click', () => stop());
  window.addEventListener('keydown', event => {
    if (event.code === 'Escape') stop();
  });
  droneRepeat.addEventListener('click', () => {
    const target = session.target;
    if (target) drones.repeat(target.mission);
  });

  function updateWatch({ mission }, dt) {
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

  const canApproach = () => (session.canEnter() || cameraSystem.landmarkOrbit) && controllerManager.activeMode === 'person';
  return {
    get active() { return session.active; }, update: dt => session.update(dt) ?? false, stop,
    map: {
      stations: drones.stations, routes: drones.routes,
      status(stationId) {
        const status = drones.status(stationId, player().position);
        return { ...status, blocked: watchBlocked(), canApproach: canApproach() };
      },
      preview: stationId => drones.preview(stationId),
      approach: station => canApproach() && station?.approach
        && teleport(station.approach.x, station.approach.z, station.approach.heading,
          { exact: true, waypoint: { x: station.x, z: station.z, name: station.name } }),
      follow: (station, demo, { remote = false } = {}) => session.enter({ station, demo, remote }).ok
    }
  };
}
