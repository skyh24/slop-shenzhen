import { STR } from './sz-strings.js';
import { captureCameraState, restoreCameraState, setObservationInputBlocked, setObservationPanel } from './sz-observation-session.js';

export function wireAirCruise({ cruise, cameraSystem, controllerManager, mapSystem, touchControls, gamepadControls,
  laneAssist, observationSessions, selectCamera, closePopovers, modeLabel, cameraLabel, buildingDetails }) {
  const words = STR.cruise;
  const menu = document.getElementById('btn-air-cruise');
  const list = document.getElementById('air-cruise-routes');
  const panel = document.getElementById('air-cruise-panel');
  const title = document.getElementById('air-cruise-title');
  const status = document.getElementById('air-cruise-state');
  const progress = document.getElementById('air-cruise-progress');
  const telemetry = document.getElementById('air-cruise-telemetry');
  const pause = document.getElementById('air-cruise-pause');
  const feedback = document.getElementById('air-cruise-feedback');
  const speedChoice = document.getElementById('air-cruise-speed');
  const scenicButton = document.getElementById('air-cruise-scenic');
  const fullButton = document.getElementById('air-cruise-full');
  const scenicKmh = Math.round(cruise.scenicSpeed * 3.6);
  const fullKmh = Math.round(cruise.fullSpeed * 3.6);
  const estimates = [];
  const plans = new Map();
  const inputs = { controllerManager, touchControls, gamepadControls };
  let speed = scenicKmh;
  let lastStatus = '';
  let lastTelemetry = 0;
  const session = observationSessions.bind('air-cruise', {
    restart: true,
    prepare: route => route && !route.unavailable && route,
    capture: () => captureCameraState(cameraSystem),
    commit: route => cruise.start(route),
    enter(_route, previous) {
      if (!previous) {
        selectCamera('chase', true, true);
        modeLabel.textContent = cameraLabel.textContent = words.label;
        setObservationInputBlocked(inputs, true);
        laneAssist.cancel();
        document.body.dataset.cruising = '';
      }
      closePopovers();
      cameraSystem.initialized = false;
    },
    update(_route, now, rawDt) {
      const prefetch = cruise.prefetch();
      if (!prefetch) return null;
      const ready = !buildingDetails.readyNear || (buildingDetails.readyNear(cruise.entity.position) && buildingDetails.readyNear(prefetch));
      cruise.update(document.hidden ? 0 : Math.max(0, Math.min(0.1, rawDt)), ready);
      render(now);
      return prefetch;
    },
    exit(_route, previous) {
      cruise.stop();
      delete document.body.dataset.cruising;
      setObservationInputBlocked(inputs, mapSystem.isFullMapOpen);
      modeLabel.textContent = controllerManager.getActiveEntity().label;
      cameraSystem.resetForTeleport();
      restoreCameraState(cameraSystem, selectCamera, previous, true);
      render(0, true);
    }
  });

  speedChoice.max = fullKmh;
  speedChoice.value = scenicKmh;
  scenicButton.textContent = words.scenicSpeed(scenicKmh);
  fullButton.textContent = words.fullSpeed(fullKmh);
  scenicButton.addEventListener('click', () => applySpeed(scenicKmh));
  fullButton.addEventListener('click', () => applySpeed(fullKmh));
  speedChoice.addEventListener('change', () => applySpeed(speedChoice.valueAsNumber));

  function selected(route) {
    if (speed === scenicKmh) return route;
    if (speed === fullKmh) return route.full;
    if (!plans.has(route.id)) plans.set(route.id, route.atSpeed(speed / 3.6));
    return plans.get(route.id);
  }

  function applySpeed(value) {
    const requested = Number.isFinite(value) ? Math.min(fullKmh, Math.max(1, Math.round(value))) : speed;
    speedChoice.value = requested;
    if (requested === speed) return;
    speed = requested;
    plans.clear();
    for (const [route, estimate] of estimates) estimate.textContent = describe(selected(route));
  }

  function describe(route) {
    return words.estimate(route.length3d, route.estimateSeconds);
  }

  function action(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-btn';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  for (const route of cruise.routes) {
    const card = document.createElement('section');
    card.className = 'cruise-route';
    const name = document.createElement('strong');
    name.textContent = words.names[route.id];
    const endpoints = document.createElement('div');
    endpoints.className = 'pop-sub';
    endpoints.textContent = words.endpoints(route.start.name, route.end.name);
    const estimate = document.createElement('div');
    estimate.className = 'pop-sub';
    estimate.textContent = route.unavailable ? words.unavailable : describe(selected(route));
    card.append(name, endpoints, estimate);
    if (!route.unavailable) {
      const actions = document.createElement('div');
      actions.className = 'cruise-actions';
      const start = action(words.start, () => {
        applySpeed(speedChoice.valueAsNumber);
        if (!session.enter(selected(route)).ok) {
          feedback.hidden = false;
          return;
        }
        feedback.hidden = true;
        render();
      });
      const map = action(words.map, () => mapSystem.showCruiseRoute(route));
      start.dataset.cruiseStart = route.id;
      start.setAttribute('aria-label', `${words.start} · ${name.textContent}`);
      map.dataset.cruiseMap = route.id;
      map.setAttribute('aria-label', `${words.map} · ${name.textContent}`);
      actions.append(start, map);
      card.append(actions);
      estimates.push([route, estimate]);
    }
    list.append(card);
  }
  menu.hidden = cruise.routes.length === 0;
  menu.addEventListener('click', () => { feedback.hidden = true; });

  pause.addEventListener('click', () => { cruise.togglePause(); render(); });
  document.getElementById('air-cruise-replay').addEventListener('click', () => {
    if (cruise.restart()) render();
  });
  document.getElementById('air-cruise-map').addEventListener('click', () => {
    if (cruise.route) mapSystem.showCruiseRoute(cruise.route);
  });
  document.getElementById('air-cruise-exit').addEventListener('click', close);

  function close() {
    session.exit();
  }

  function render(now = 0, restoreFocus = false) {
    setObservationPanel(panel, menu, cruise.active, restoreFocus);
    if (!cruise.active) {
      lastStatus = '';
      return;
    }
    const key = `${cruise.route.id}:${cruise.status}`;
    if (lastStatus !== key) {
      lastStatus = key;
      lastTelemetry = 0;
      title.textContent = words.names[cruise.route.id];
      status.textContent = words.statuses[cruise.status];
      pause.disabled = cruise.status === 'complete';
      pause.textContent = cruise.status === 'paused' ? words.resume : words.pause;
    }
    if (now && now < lastTelemetry) return;
    lastTelemetry = now + 200;
    progress.value = cruise.distance / cruise.route.distance;
    telemetry.textContent = words.telemetry(cruise.distance, cruise.route.distance, cruise.altitude, cruise.targetHeight);
  }

  return {
    close,
    update: (now, rawDt) => session.update(now, rawDt) ?? null
  };
}
