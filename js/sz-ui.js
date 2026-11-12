import { STR } from './sz-strings.js';
import { getLocationLabel, getLocationInfo, isTypingInField, SZ_LANDMARKS } from './sz-city-config.js';

const METRO_STATE_KEY = 'sz-metro-lines';

function localizeInterface() {
  const lookup = key => key.split('.').reduce((value, part) => value[part], STR);
  for (const element of document.querySelectorAll('[data-text]')) {
    element.textContent = lookup(element.dataset.text);
  }
  for (const [data, attribute] of [['data-label', 'aria-label'], ['data-tip', 'title'], ['data-content-text', 'content']]) {
    for (const element of document.querySelectorAll(`[${data}]`)) {
      element.setAttribute(attribute, lookup(element.getAttribute(data)));
    }
  }
  for (const button of document.querySelectorAll('[data-time]')) {
    const label = STR.timeNames[button.dataset.time];
    button.title = label;
    button.setAttribute('aria-label', label);
    button.querySelector('.seg-label').textContent = label;
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    const mode = button.dataset.mode;
    button.title = STR.shortcut(STR.modeNames[mode], button.querySelector('kbd').textContent);
    button.setAttribute('aria-label', STR.modeNames[mode]);
    button.querySelector('.mode-label').textContent = STR.modeButtons[mode];
  }
  for (const button of document.querySelectorAll('[data-camera]')) {
    button.querySelector('.pop-name').textContent = STR.cameraNames[button.dataset.camera];
  }
}

if (typeof document !== 'undefined') localizeInterface();

export function populateTeleportMenu(locations, locationLabel) {
  const menu = document.getElementById('teleport-popover');
  const feedback = document.getElementById('teleport-feedback');
  const existing = new Map([...menu.querySelectorAll('[data-teleport]')].map(button => [button.dataset.teleport, button]));
  for (const button of existing.values()) button.hidden = !locations[button.dataset.teleport];
  return Object.entries(locations).map(([key, location]) => {
    let button = existing.get(key);
    if (!button) {
      button = document.createElement('button');
      button.id = `tp-${key}`;
      button.className = 'pop-item tp-btn';
      button.dataset.teleport = key;
      button.type = 'button';
      for (const className of ['pop-name', 'pop-sub']) {
        const part = document.createElement('span');
        part.className = className;
        button.appendChild(part);
      }
      menu.insertBefore(button, feedback);
    }
    button.querySelector('.pop-name').textContent = location.name;
    const detail = locationLabel(location.x, location.z);
    button.querySelector('.pop-sub').textContent = detail === location.name ? '' : detail;
    return button;
  });
}

export function wireMetroMenu(mapSystem, sourceLines) {
  const list = document.getElementById('metro-lines');
  const lines = sourceLines.filter(line => line.hasCoverage);
  const refs = new Set(lines.map(line => line.ref));
  let selected = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(METRO_STATE_KEY));
    if (Array.isArray(saved)) selected = new Set(saved.filter(ref => refs.has(ref)));
  } catch { /* 存储不可用时仍能操作地图。 */ }

  const inputs = new Map();
  function apply(save) {
    for (const [ref, input] of inputs) input.checked = selected.has(ref);
    mapSystem.setMetroLines(selected);
    if (save) {
      try { localStorage.setItem(METRO_STATE_KEY, JSON.stringify([...selected])); } catch { /* 存储可选。 */ }
    }
  }
  for (const line of lines) {
    const row = document.createElement('label');
    row.className = 'pop-item metro-line';
    const name = document.createElement('span');
    name.textContent = STR.metro.line(line.ref);
    const swatch = document.createElement('span');
    swatch.className = 'metro-swatch';
    swatch.style.backgroundColor = line.colour || '';
    swatch.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.metroLine = line.ref;
    input.setAttribute('aria-label', name.textContent);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(line.ref);
      else selected.delete(line.ref);
      apply(true);
    });
    row.append(swatch, name, input);
    list.appendChild(row);
    inputs.set(line.ref, input);
  }
  document.getElementById('metro-show-all').addEventListener('click', () => {
    selected = new Set(refs);
    apply(true);
  });
  document.getElementById('metro-hide-all').addEventListener('click', () => {
    selected.clear();
    apply(true);
  });
  apply(false);
}

// 原生 [popover] 的定位：data-anchor 指定贴靠的控件，data-align 指定右边缘对齐的控件；
// 相机控件在触屏上会移到顶部，所以按上下可用空间决定弹层开向。
export function wirePopovers() {
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invokers = [...document.querySelectorAll(`[popovertarget="${pop.id}"]`)];
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      const invoker = invokers.includes(e.source) ? e.source
        : invokers.find(button => button === document.activeElement) ?? invokers[0];
      for (const button of invokers) button.classList.toggle('is-open', open && button === invoker);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });
  return closePopovers;
}

// 全局快捷键：模式 1–4、相机 V 与 5–0、HUD H、声音 N、喇叭 B；输入框内的按键不拦截。
// 按键码是开放集合，默认分支静默忽略，不按有限取值的 switch 抛错。
export function wireShortcuts({ onMode, onCamera, onCycleCamera, onToggleHud, onToggleSound, onHonk, onLane, onLaneCancel, onToggleLane, onToggleEmergencyBrake }) {
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    switch (e.code) {
      case 'Digit1':
        onMode('person');
        break;
      case 'Digit2':
        onMode('car');
        break;
      case 'Digit3':
        onMode('cyclist');
        break;
      case 'Digit4':
        onMode('helicopter');
        break;
      case 'Digit5':
        onCamera('chase');
        break;
      case 'Digit6':
        onCamera('action');
        break;
      case 'Digit7':
        onCamera('pov');
        break;
      case 'Digit8':
        onCamera('fifthAve');
        break;
      case 'Digit9':
        onCamera('timesSquare');
        break;
      case 'Digit0':
        onCamera('chryslerGCT');
        break;
      case 'KeyV':
        onCycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        onToggleHud();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) onToggleSound();
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) onHonk();
        break;
      case 'KeyJ':
      case 'KeyL':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) onLane?.(e.code === 'KeyJ' ? 1 : -1);
        break;
      case 'KeyK':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) onToggleLane?.();
        break;
      case 'KeyU':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) onToggleEmergencyBrake?.();
        break;
      case 'Escape':
        onLaneCancel?.();
        break;
      default:
        break;
    }
  });
}

export function wireDrivingAssists(controller, lane) {
  const message = document.getElementById('assist-status');
  const storageKey = 'sz-driving-assists';
  const labels = STR.assists;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    controller.emergencyBrakeEnabled = saved?.brake !== false;
    lane.enabled = saved?.lane !== false;
  } catch { /* 浏览器存储不可用时使用默认设置。 */ }

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ brake: controller.emergencyBrakeEnabled, lane: lane.enabled })); }
    catch { /* 浏览器存储不可用时本次仍生效。 */ }
  }

  let lastStatus, visible = false, feedbackTimer;
  function show(text, persistent = false) {
    clearTimeout(feedbackTimer);
    message.textContent = text ?? '';
    message.hidden = !visible || !text;
    if (!persistent && text) feedbackTimer = setTimeout(() => {
      message.textContent = lane.active ? labels.status[lane.status] : '';
      message.hidden = !visible || !message.textContent;
    }, 3200);
  }

  return {
    render(active, showStatus = false) {
      if (visible !== active) {
        visible = active;
        message.hidden = !active || !message.textContent;
      }
      if (showStatus || lastStatus !== lane.status) {
        lastStatus = lane.status;
        show(labels.status[lastStatus], lane.active);
      }
    },
    toggleLane() {
      lane.enabled = !lane.enabled;
      save();
      lastStatus = lane.status;
      show(lane.enabled ? labels.laneOn : labels.laneOff);
    },
    toggleEmergencyBrake() {
      controller.emergencyBrakeEnabled = !controller.emergencyBrakeEnabled;
      save();
      show(controller.emergencyBrakeEnabled ? labels.brakeOn : labels.brakeOff);
    }
  };
}

// HUD 位置读数：街角/道路名加就近楼名。楼名只作定位提示，普通楼没有名称时退回附近地标名。
export function createLocationReadout({ el, nearestBuildingName }) {
  let locationText = '';
  let locationBuilding = '';
  function nearestLandmarkName(x, z, radius = 240) {
    let best = null;
    for (const landmark of SZ_LANDMARKS) {
      if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.z)) continue;
      const distance = Math.hypot(landmark.x - x, landmark.z - z);
      if (distance > radius) continue;
      if (!best || distance < best.distance) best = { name: landmark.name, distance };
    }
    return best ? best.name : null;
  }
  return function renderLocation(x, z) {
    if (!el) return;
    const label = getLocationLabel(x, z);
    const buildingName = nearestBuildingName(x, z) ?? nearestLandmarkName(x, z) ?? '';
    if (label === locationText && buildingName === locationBuilding) return;
    locationText = label;
    locationBuilding = buildingName;
    const info = getLocationInfo(x, z);
    const place = document.createElement('div');
    if (info.road && info.kind === 'land') {
      place.className = 'location-signs';
      const sign = document.createElement('span');
      sign.className = 'street-sign';
      sign.textContent = label;
      place.appendChild(sign);
    } else {
      place.className = 'location-place';
      place.textContent = label;
    }
    if (buildingName) {
      const near = document.createElement('span');
      near.className = 'location-near';
      near.textContent = buildingName;
      place.appendChild(near);
    }
    el.replaceChildren(place);
  };
}

// HUD 读数每 250 ms 更新一次；帧率按墙钟累计算，慢帧和高刷屏都显示实际值。
export function createHudTelemetry({ els, controllerManager, cameraSystem, topSpeed, renderLocation }) {
  let frameCount = 0;
  let fpsTimer = 0;
  return {
    update(rawDt) {
      frameCount++;
      fpsTimer += Math.max(0, rawDt);
      if (fpsTimer < 0.25) return;
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const speed = Math.abs(activeEnt.speed);
      if (els.fps) {
        els.fps.textContent = String(currentFps);
        els.fps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (els.speed) els.speed.textContent = String(Math.round(speed * 3.6));
      if (els.speedMeter) els.speedMeter.style.transform = `scaleX(${Math.min(1, speed / topSpeed[mode])})`;
      if (els.altitude) els.altitude.textContent = Math.round(activeEnt.position.y).toLocaleString('zh-CN');
      // 跟随相机显示玩家所在街角，观光相机显示相机所在街角。
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(where.x, where.z);
    }
  };
}
