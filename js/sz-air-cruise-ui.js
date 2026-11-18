import { STR } from './sz-strings.js';
import { setObservationInputBlocked, setObservationPanel } from './sz-observation-session.js';

export function wireAirCruise({ cruise, cameraSystem, controllerManager, mapSystem, touchControls, gamepadControls,
  observationSessions, selectMode, selectCamera, closePopovers, modeLabel, cameraLabel, buildingDetails }) {
  const words = STR.cruise;
  const menu = document.getElementById('btn-air-cruise');
  const list = document.getElementById('air-cruise-routes');
  const panel = document.getElementById('air-cruise-panel');
  const title = document.getElementById('air-cruise-title');
  const status = document.getElementById('air-cruise-state');
  const progress = document.getElementById('air-cruise-progress');
  const telemetry = document.getElementById('air-cruise-telemetry');
  const speedButton = document.getElementById('air-cruise-speed');
  const pauseButton = document.getElementById('air-cruise-pause');
  const replayButton = document.getElementById('air-cruise-replay');
  const feedback = document.getElementById('air-cruise-feedback');
  // 游览 ×1 为 eVTOL 极速的一半（300 km/h），快速 ×2 为极速 600 km/h；路线按所选速度重算，弯道只按比例减速。
  const fastKmh = Math.round(cruise.fullSpeed * 3.6) || 600;
  const scenicKmh = Math.max(1, Math.round(fastKmh / 2));
  const estimates = [];
  const plans = new Map();
  const inputs = { controllerManager, touchControls, gamepadControls };
  let speed = scenicKmh;
  let lastStatus = '';
  let lastTelemetry = 0;
  const session = observationSessions.bind('air-cruise', {
    restart: true,
    prepare: route => route && !route.unavailable && route,
    // 巡游直接进入飞行状态：先接管航线，再切到飞行；切换失败时回滚，避免留下无人控制的巡游。
    commit: (route) => {
      if (!cruise.start(route)) return false;
      if (selectMode('helicopter')) return true;
      cruise.stop();
      return false;
    },
    enter(_route, previous) {
      if (!previous) {
        selectCamera('chase', true, true);
        modeLabel.textContent = controllerManager.getActiveEntity().label;
        cameraLabel.textContent = words.label;
        setObservationInputBlocked(inputs, true);
        document.body.dataset.cruising = '';
      }
      closePopovers();
      cameraSystem.initialized = false;
    },
    update(_route, now, playbackDt) {
      const prefetch = cruise.prefetch();
      if (!prefetch) return null;
      const ready = !buildingDetails.readyNear || (buildingDetails.readyNear(cruise.entity.position) && buildingDetails.readyNear(prefetch));
      // 播放步长来自入口帧时钟（隐藏/恢复首帧为 0）；巡游仍需单帧封顶，位置不随长帧前跳。
      cruise.update(Math.max(0, Math.min(0.1, playbackDt)), ready);
      render(now);
      return prefetch;
    },
    exit() {
      cruise.stop();
      delete document.body.dataset.cruising;
      setObservationInputBlocked(inputs, mapSystem.isFullMapOpen);
      modeLabel.textContent = controllerManager.getActiveEntity().label;
      cameraSystem.resetForTeleport();
      // 退出后直接停在当前上空，保持追尾视角，不恢复进入前的相机位置。
      selectCamera('chase', true, true);
      render(0, true);
    }
  });

  labelSpeed();
  // 速度键显示的是“下一步要切到的档位”：游览时显示快速 ×2，快速时显示游览 ×1。
  speedButton.addEventListener('click', () => setSpeed(speed === fastKmh ? scenicKmh : fastKmh));
  pauseButton.addEventListener('click', () => {
    cruise.togglePause();
    labelPause();
  });
  replayButton.addEventListener('click', () => {
    cruise.restart();
    labelPause();
  });

  function selected(route) {
    if (!route || typeof route.atSpeed !== 'function') return route;
    const key = `${route.id}@${speed}`;
    if (!plans.has(key)) plans.set(key, route.atSpeed(speed / 3.6));
    return plans.get(key);
  }

  function labelSpeed() {
    // 文案写的是点下去会切到的档位：当前游览就显示快速 ×2，当前快速就显示游览 ×1。
    const text = speed === fastKmh ? words.scenic : words.fast;
    speedButton.textContent = text;
    speedButton.setAttribute('aria-label', text);
    speedButton.setAttribute('aria-pressed', String(speed === fastKmh));
  }

  function labelPause() {
    const text = cruise.status === 'paused' ? words.resume : words.pause;
    pauseButton.textContent = text;
    pauseButton.setAttribute('aria-label', text);
    pauseButton.disabled = cruise.status === 'complete';
  }

  function setSpeed(kmh) {
    const next = Math.max(1, Math.round(kmh));
    if (next === speed) return;
    speed = next;
    labelSpeed();
    for (const [route, estimate] of estimates) {
      if (!route.unavailable) estimate.textContent = describe(selected(route));
    }
    cruise.setSpeed?.(speed / 3.6);
  }

  function describe(route) {
    // 估算按当前选择的档位计划，切换速度时卡片上的时间同步更新。
    const plan = selected(route);
    return words.estimate(plan.length3d ?? route.length3d, plan.estimateSeconds ?? route.estimateSeconds);
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

  document.getElementById('air-cruise-exit').addEventListener('click', close);

  // 退出后回到默认游览速度：下一次进入巡游仍以 300 km/h 起步，快速只在本次飞行中生效。
  function close() {
    session.exit();
    setSpeed(scenicKmh);
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
    }
    if (now && now < lastTelemetry) return;
    lastTelemetry = now + 200;
    labelPause();
    progress.value = cruise.distance / cruise.route.distance;
    telemetry.textContent = words.telemetry(cruise.distance, cruise.route.distance, cruise.altitude, cruise.targetHeight);
  }

  return {
    close,
    update: (now, playbackDt) => session.update(now, playbackDt) ?? null
  };
}
