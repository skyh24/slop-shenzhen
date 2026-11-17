import { STR } from './sz-strings.js';
import { captureCameraState, restoreCameraState, setObservationInputBlocked, setObservationPanel } from './sz-observation-session.js';

export function wireAirCruise({ cruise, cameraSystem, controllerManager, mapSystem, touchControls, gamepadControls,
  observationSessions, selectCamera, closePopovers, modeLabel, cameraLabel, buildingDetails }) {
  const words = STR.cruise;
  const menu = document.getElementById('btn-air-cruise');
  const list = document.getElementById('air-cruise-routes');
  const panel = document.getElementById('air-cruise-panel');
  const title = document.getElementById('air-cruise-title');
  const status = document.getElementById('air-cruise-state');
  const progress = document.getElementById('air-cruise-progress');
  const telemetry = document.getElementById('air-cruise-telemetry');
  const pause = document.getElementById('air-cruise-pause');
  const boost = document.getElementById('air-cruise-boost');
  const feedback = document.getElementById('air-cruise-feedback');
  // 巡游常速 300 km/h，加速键切到 eVTOL 极速（600 km/h）；路线按所选速度重算，弯道只按比例减速。
  const cruiseKmh = 300;
  const boostKmh = Math.max(cruiseKmh, Math.round(cruise.fullSpeed * 3.6));
  const estimates = [];
  const plans = new Map();
  const inputs = { controllerManager, touchControls, gamepadControls };
  let speed = cruiseKmh;
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

  boost.hidden = boostKmh <= cruiseKmh;
  labelBoost();
  boost.addEventListener('click', () => setSpeed(speed === boostKmh ? cruiseKmh : boostKmh));

  function selected(route) {
    if (!route || typeof route.atSpeed !== 'function') return route;
    const key = `${route.id}@${speed}`;
    if (!plans.has(key)) plans.set(key, route.atSpeed(speed / 3.6));
    return plans.get(key);
  }

  function labelBoost() {
    boost.textContent = speed === boostKmh ? words.normalSpeed(cruiseKmh) : words.boostSpeed(boostKmh);
    boost.setAttribute('aria-pressed', String(speed === boostKmh));
  }

  function setSpeed(kmh) {
    const next = Math.max(1, Math.round(kmh));
    if (next === speed) return;
    speed = next;
    labelBoost();
    for (const [route, estimate] of estimates) {
      if (!route.unavailable) estimate.textContent = describe(selected(route));
    }
    cruise.setSpeed?.(speed / 3.6);
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
  document.getElementById('air-cruise-exit').addEventListener('click', close);

  // 退出后回到默认常速：下一次进入巡游仍以 300 km/h 起步，加速只在本次飞行中生效。
  function close() {
    session.exit();
    setSpeed(cruiseKmh);
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
