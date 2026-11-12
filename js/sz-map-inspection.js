import { GEO } from './sz-geodata.js';
import { NYC_LANDMARKS } from './sz-city-config.js';
import { REGION_COLOURS, regionName } from './sz-map-regions.js';
import { STR } from './sz-strings.js';

function wireMapInspection(map) {
  const canvas = map.fullCanvas;
  if (!canvas) return null;
  const get = id => document.getElementById(id);
  const selectionPanel = get('map-selection');
  const selectionText = get('map-selection-text');
  const go = get('map-selection-go');
  const legend = get('map-region-legend-list');
  const label = region => STR.map.regionInfo(regionName(region), STR.map.regionTypes[region.type]);

  let pointer = null;
  let hover = null;
  let selected = null;
  let pan = null;
  let frame = 0;
  let wheelTimer = 0;
  let needsDraw = false;
  let feedback = '';

  function readPointer({ clientX, clientY }) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const mx = clientX - r.left, my = clientY - r.top;
    if (mx < 0 || my < 0 || mx >= r.width || my >= r.height) return null;
    const { w, h } = map.fullSize();
    return { ...map.screenToWorld(mx * w / r.width, my * h / r.height, w, h), w, h };
  }

  function updateHint() {
    const text = hover ? label(hover) : '';
    map.renderPointerHint(text !== selected?.label ? text : '');
  }

  function refreshHover() {
    const old = hover;
    const point = !pan && !wheelTimer && !map.isPlanningDrive && pointer ? readPointer(pointer) : null;
    hover = point ? map.regionLayer()?.hit(point.x, point.z, map.viewZoom, map.mapLayersVisible, old) ?? null : null;
    updateHint();
    return old !== hover;
  }

  function queueFrame(draw = false) {
    needsDraw ||= draw;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      const changed = refreshHover();
      if (needsDraw || changed) map.renderFullMap();
      needsDraw = false;
    });
  }

  function clearHover() {
    hover = null;
    updateHint();
  }

  function updateSelection() {
    selectionPanel.hidden = !selected;
    selectionText.textContent = feedback || selected?.label || '';
    updateHint();
  }

  function visiblePin(point) {
    if (!map.mapLayersVisible.landmarks) return null;
    let nearest = null;
    let distance = 7;
    for (const landmark of NYC_LANDMARKS) {
      const s = map.viewZoom;
      if (Math.abs(landmark.x - map.viewCenterX) * s > point.w * 0.48
        || Math.abs(landmark.z - map.viewCenterZ) * s > point.h * 0.48) continue;
      const d = Math.hypot(landmark.x - point.x, landmark.z - point.z) * s;
      if (d > distance) continue;
      nearest = landmark;
      distance = d;
    }
    return nearest;
  }

  function pick(point, pointerType) {
    if (map.isPlanningDrive) {
      if (!map.drive.active) map.pickDrivePoint(point.x, point.z);
      return;
    }
    const pin = visiblePin(point);
    const region = pin ? null : map.regionLayer()?.hit(point.x, point.z, map.viewZoom, map.mapLayersVisible) ?? null;
    selected = { x: pin?.x ?? point.x, z: pin?.z ?? point.z, landmarkId: pin?.id,
      label: pin?.name ?? (region ? label(region) : STR.map.selectedPoint),
      region: pointerType === 'mouse' ? null : region };
    feedback = '';
    updateSelection();
  }

  go.addEventListener('click', () => {
    if (!selected || map.isPlanningDrive) return;
    const { x, z, landmarkId } = selected;
    if (map.onTeleport?.(x, z, undefined, { landmarkId })) {
      selected = null;
      feedback = '';
    } else {
      feedback = STR.map.noArrival;
    }
    updateSelection();
    map.renderFullMap();
  });

  get('map-selection-clear').addEventListener('click', () => {
    selected = null;
    feedback = '';
    updateSelection();
    map.renderFullMap();
  });

  for (const button of document.querySelectorAll('[data-map-layer]')) {
    const key = button.dataset.mapLayer;
    button.addEventListener('click', () => {
      const on = map.mapLayersVisible[key] = !map.mapLayersVisible[key];
      button.setAttribute('aria-pressed', String(on));
      map.fullStaticKey = '';
      refreshHover();
      map.renderFullMap();
    });
  }

  for (const [type, colour] of Object.entries(REGION_COLOURS)) {
    const item = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'map-region-swatch';
    swatch.style.setProperty('--region-colour', colour);
    swatch.setAttribute('aria-hidden', 'true');
    const name = STR.map.regionTypes[type];
    const available = GEO.mapRegions?.coverage[type] > 0;
    item.classList.toggle('map-region-gap', !available);
    item.append(swatch, available ? name : STR.map.regionGap(name));
    legend.appendChild(item);
  }

  function cancelPan() {
    const old = pan;
    pan = null;
    map.fullCanvasWrap?.classList.remove('is-panning');
    if (old && canvas.hasPointerCapture(old.id)) canvas.releasePointerCapture(old.id);
  }

  function resetInput() {
    cancelPan();
    pointer = null;
    clearTimeout(wheelTimer);
    wheelTimer = 0;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    needsDraw = false;
    clearHover();
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !map.isFullMapOpen || pan) return;
    e.preventDefault();
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: map.viewCenterX, cz: map.viewCenterZ, moved: false };
    pointer = null;
    clearHover();
    queueFrame(true);
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', e => {
    if (!map.isFullMapOpen) return;
    if (pan) {
      if (e.pointerId !== pan.id) return;
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) <= 5) return;
      e.preventDefault();
      pan.moved = true;
      map.fullCanvasWrap?.classList.add('is-panning');
      map.viewCenterX = pan.cx - dx / map.viewZoom;
      map.viewCenterZ = pan.cz - dy / map.viewZoom;
      queueFrame(true);
    } else if (e.pointerType === 'mouse') {
      pointer = e;
      queueFrame();
    }
  });

  canvas.addEventListener('pointerup', e => {
    if (!pan || e.pointerId !== pan.id) return;
    const clicked = !pan.moved && Math.hypot(e.clientX - pan.x, e.clientY - pan.y) <= 5;
    cancelPan();
    const point = readPointer(e);
    pointer = e.pointerType === 'mouse' && point ? e : null;
    if (clicked && point) pick(point, e.pointerType);
    queueFrame(true);
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, e => {
      if (pan && e.pointerId === pan.id) {
        resetInput();
        queueFrame(true);
      }
    });
  }
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    queueFrame();
  });
  window.addEventListener('blur', resetInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetInput(); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (pan) return;
    const point = readPointer(e);
    if (!point) return;
    const old = map.viewZoom;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const next = Math.max(map.minViewZoom(), Math.min(map.maxViewZoom(), old * factor));
    map.viewZoom = next;
    map.viewCenterX = point.x - (point.x - map.viewCenterX) * old / next;
    map.viewCenterZ = point.z - (point.z - map.viewCenterZ) * old / next;
    pointer = e;
    clearHover();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = 0;
      queueFrame();
    }, 120);
    queueFrame(true);
  }, { passive: false });

  return {
    refreshHover,
    reset() {
      resetInput();
      selected = null;
      feedback = '';
      updateSelection();
    },
    get highlight() { return pan || wheelTimer || map.isPlanningDrive ? null : hover ?? selected?.region; },
    get selection() { return map.isPlanningDrive ? null : selected; }
  };
}

export { wireMapInspection };
