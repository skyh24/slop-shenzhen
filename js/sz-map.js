import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { NYC_LANDMARKS, ISLAND_BOUNDS, getLocationLabel, isTypingInField } from './sz-city-config.js';
import { STR } from './sz-strings.js';
import { MAP, ROAD_LABELS, ROAD_NAME_COUNT, MapView, addLine, mapLayers, footprintLayers, drawPlayerArrow, drawWaypoint, overlaps } from './sz-map-layers.js';

// 保留纽约地图控件和缓存机制；地理图层改用深圳同一份真实数据。
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MIN_ZOOM = 0.015;
const MAX_ZOOM = 3;
const RADAR_SCALE = 0.32;
const GRID_BEARING = 0;

function roadMatches(label, query) {
  return label.lower.includes(query) || label.raw.includes(query) || STR.map.roadInitials[label.text]?.startsWith(query);
}

class NYCMapSystem {
  constructor({ controllerManager, cameraSystem, allBlocks = [], onTeleport, onToggle, drive = null, touchHints = false }) {
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.allBlocks = allBlocks;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;
    this.drive = drive;
    this.touchHints = touchHints;

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext('2d') : null;
    this.elMiniStreet = document.getElementById('minimap-street-label');
    this.miniStreetText = '';
    this.miniScale = RADAR_SCALE;
    this.miniCache = null;
    const elCounts = document.getElementById('fullmap-counts');
    if (elCounts) elCounts.textContent = STR.map.counts(ROAD_NAME_COUNT, REAL_BUILDINGS.length);

    const needle = document.getElementById('map-compass-needle');
    if (needle) needle.setAttribute('transform', `rotate(${-GRID_BEARING} 22 22)`);

    this.modal = document.getElementById('fullmap-modal');
    this.fullCanvas = document.getElementById('fullmap-canvas');
    this.fullCanvasWrap = document.getElementById('fullmap-canvas-wrap');
    this.fullCtx = this.fullCanvas ? this.fullCanvas.getContext('2d') : null;
    this.fullDpr = 1;
    this.fullStatic = null;
    this.fullStaticKey = '';
    this.elHoverInfo = document.getElementById('fullmap-hover-info');
    this.elPlayerInfo = document.getElementById('fullmap-player-info');
    this.elSearchInput = document.getElementById('fullmap-search');
    if (this.elSearchInput) this.elSearchInput.placeholder = STR.map.searchPlaceholder;

    this.isFullMapOpen = false;

    this.viewCenterX = 0;
    this.viewCenterZ = 0;
    this.viewZoom = 0.22;
    this.isPanning = false;
    this.panPointerId = null;
    this.panStart = { x: 0, y: 0, cx: 0, cz: 0 };
    this.dragMoved = false;

    this.searchHighlight = '';
    this.searchPath = null;
    this.textWidths = new Map();

    this.waypoint = null;
    this.metroLines = new Set();
    this.hsrVisible = false;
    this.dronesVisible = false;
    this.isPlanningDrive = false;
    this.driveStart = null;
    this.driveEnd = null;
    this.driveRoute = null;
    this.drivePath = null;
    this.driveFeedback = '';

    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.textWidths.clear();
        this.miniCache = null;
        this.fullStaticKey = '';
      });
    }

    this.initEvents();
  }

  initEvents() {
    const closeBtn = document.getElementById('close-fullmap-btn');
    const miniCard = document.getElementById('minimap-card');
    const zoomInBtn = document.getElementById('map-zoom-in');
    const zoomOutBtn = document.getElementById('map-zoom-out');
    const centerPlayerBtn = document.getElementById('map-center-player');
    const fullIslandBtn = document.getElementById('map-view-all');
    if (this.drive) this.initDriveEvents();

    if (miniCard) {
      miniCard.addEventListener('click', () => this.toggleFullMap(true));
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggleFullMap(false));
    }

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        this.viewZoom = Math.min(MAX_ZOOM, this.viewZoom * 1.45);
        this.renderFullMap();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        this.viewZoom = Math.max(this.minViewZoom(), this.viewZoom / 1.45);
        this.renderFullMap();
      });
    }
    if (centerPlayerBtn) {
      centerPlayerBtn.addEventListener('click', () => {
        const ent = this.controllerManager.getActiveEntity();
        this.viewCenterX = ent.position.x;
        this.viewCenterZ = ent.position.z;
        this.viewZoom = 0.9;
        this.renderFullMap();
      });
    }
    if (fullIslandBtn) {
      fullIslandBtn.addEventListener('click', () => {
        const b = ISLAND_BOUNDS;
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        this.viewZoom = this.fullExtentZoom();
        this.renderFullMap();
      });
    }

    if (this.elSearchInput) {
      this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) {
        const metro = document.getElementById('metro-popover');
        if (typeof metro?.hidePopover !== 'function' || !metro.matches(':popover-open')) this.toggleFullMap(false);
      } else if (e.code === 'KeyM' && !isTypingInField(e)) {
        this.toggleFullMap(!this.isFullMapOpen);
      }
    });

    const hsrButton = document.getElementById('map-hsr');
    if (hsrButton) {
      hsrButton.addEventListener('click', () => {
        this.hsrVisible = !this.hsrVisible;
        hsrButton.setAttribute('aria-pressed', String(this.hsrVisible));
        hsrButton.classList.toggle('active', this.hsrVisible);
        this.miniCache = null;
        this.fullStaticKey = '';
        this.renderFullMap();
      });
    }

    const droneButton = document.getElementById('map-drones');
    if (droneButton) {
      droneButton.addEventListener('click', () => {
        this.dronesVisible = !this.dronesVisible;
        droneButton.setAttribute('aria-pressed', String(this.dronesVisible));
        droneButton.classList.toggle('active', this.dronesVisible);
        this.miniCache = null;
        this.fullStaticKey = '';
        this.renderFullMap();
      });
    }

    if (this.fullCanvas) {
      this.fullCanvas.style.touchAction = 'none';
      this.fullCanvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.isFullMapOpen || this.panPointerId !== null) return;
        e.preventDefault();
        this.panPointerId = e.pointerId;
        this.fullCanvas.setPointerCapture(e.pointerId);
        this.isPanning = true;
        this.dragMoved = false;
        this.panStart.x = e.clientX;
        this.panStart.y = e.clientY;
        this.panStart.cx = this.viewCenterX;
        this.panStart.cz = this.viewCenterZ;
        if (this.fullCanvasWrap) this.fullCanvasWrap.classList.add('is-panning');
      });

      this.fullCanvas.addEventListener('pointermove', (e) => {
        if (!this.isFullMapOpen || !this.fullCanvas) return;
        if (this.isPanning ? e.pointerId !== this.panPointerId : e.pointerType !== 'mouse') return;
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (this.isPanning) {
          e.preventDefault();
          const dx = e.clientX - this.panStart.x;
          const dy = e.clientY - this.panStart.y;
          if (Math.hypot(dx, dy) > 5) this.dragMoved = true;
          this.viewCenterX = this.panStart.cx - dx / this.viewZoom;
          this.viewCenterZ = this.panStart.cz - dy / this.viewZoom;
          this.renderFullMap();
          return;
        }

        if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
          const wPos = this.screenToWorld(mx, my, rect.width, rect.height);
          if (this.elHoverInfo && !this.isPlanningDrive) {
            this.elHoverInfo.textContent = STR.map.teleportHint(getLocationLabel(wPos.x, wPos.z));
          }
        }
      });

      this.fullCanvas.addEventListener('pointerup', (e) => {
        if (e.pointerId !== this.panPointerId) return;
        const clicked = !this.dragMoved && Math.hypot(e.clientX - this.panStart.x, e.clientY - this.panStart.y) <= 5;
        this.cancelPan();
        if (clicked && this.isFullMapOpen && this.fullCanvas) {
          const rect = this.fullCanvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
            const wPos = this.screenToWorld(mx, my, rect.width, rect.height);
            if (this.isPlanningDrive) {
              if (!this.drive.active) this.pickDrivePoint(wPos.x, wPos.z);
            } else {
              // 只在点中可见地标图钉时走正面到达，普通地图点仍按原位置处理。
              let landmarkId;
              let closest = 7;
              for (const landmark of NYC_LANDMARKS) {
                const lx = (landmark.x - this.viewCenterX) * this.viewZoom;
                const lz = (landmark.z - this.viewCenterZ) * this.viewZoom;
                if (Math.abs(lx) > rect.width * 0.48 || Math.abs(lz) > rect.height * 0.48) continue;
                const distance = Math.hypot(lx + rect.width / 2 - mx, lz + rect.height / 2 - my);
                if (distance > closest) continue;
                closest = distance;
                landmarkId = landmark.id;
              }
              const destination = this.onTeleport?.(wPos.x, wPos.z, undefined, { landmarkId });
              if (!destination && this.elHoverInfo) this.elHoverInfo.textContent = STR.map.noArrival;
            }
            this.renderFullMap();
          }
        }
      });
      for (const type of ['pointercancel', 'lostpointercapture']) {
        this.fullCanvas.addEventListener(type, (e) => {
          if (e.pointerId === this.panPointerId) this.cancelPan();
        });
      }
      window.addEventListener('blur', () => this.cancelPan());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.cancelPan();
      });

      this.fullCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = this.screenToWorld(mx, my, rect.width, rect.height);
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        this.viewZoom = Math.max(this.minViewZoom(), Math.min(MAX_ZOOM, this.viewZoom * factor));
        this.viewCenterX = before.x - (mx - rect.width * 0.5) / this.viewZoom;
        this.viewCenterZ = before.z - (my - rect.height * 0.5) / this.viewZoom;
        this.renderFullMap();
      }, { passive: false });
    }
  }

  initDriveEvents() {
    const get = id => document.getElementById(id);
    this.driveUi = { toggle: get('map-plan-drive'), panel: get('map-drive-panel'), status: get('map-drive-status'),
      clear: get('map-drive-clear'), arrive: get('map-drive-to-start'), start: get('map-drive-start'),
      stop: get('map-drive-stop'), hud: get('drive-hud'), hudStatus: get('drive-hud-status'), hudStop: get('drive-hud-stop') };
    const { toggle, clear, arrive, start, stop, hudStop } = this.driveUi;
    toggle?.addEventListener('click', () => {
      if (this.drive.active) return;
      this.isPlanningDrive = !this.isPlanningDrive;
      this.resetDrivePlan();
      this.renderPointerHint();
    });
    clear?.addEventListener('click', () => this.resetDrivePlan());
    arrive?.addEventListener('click', () => {
      this.driveFeedback = this.drive.goToStart(this.driveRoute) ? '' : STR.drive.startUnavailable;
      this.renderDriveUi();
    });
    start?.addEventListener('click', () => {
      if (this.drive.start(this.driveRoute)) this.toggleFullMap(false);
      this.renderDriveUi();
    });
    for (const button of [stop, hudStop]) button?.addEventListener('click', () => this.drive.stop('manual'));
  }

  resetDrivePlan() {
    this.drive.stop();
    this.driveStart = this.driveEnd = this.driveRoute = this.drivePath = null;
    this.driveFeedback = '';
    this.miniCache = null;
    this.fullStaticKey = '';
    this.renderDriveUi();
  }

  renderPointerHint() {
    if (!this.elHoverInfo) return;
    this.elHoverInfo.textContent = this.isPlanningDrive
      ? (this.touchHints ? STR.drive.touchHint : STR.drive.mapHint)
      : (this.touchHints ? STR.map.touchHint : STR.map.clickHint);
  }

  pickDrivePoint(x, z) {
    if (this.driveRoute) this.resetDrivePlan();
    const point = this.drive.snap(x, z);
    this.driveFeedback = '';
    if (!point) {
      this.driveFeedback = STR.drive.noPoint;
    } else if (!this.driveStart) {
      this.driveStart = point;
    } else {
      this.driveEnd = point;
      this.driveRoute = this.drive.route(this.driveStart, point);
      if (this.driveRoute) {
        this.drivePath = new Path2D();
        addLine(this.drivePath, this.driveRoute.samples);
        this.miniCache = null;
        this.fullStaticKey = '';
      } else {
        this.driveFeedback = STR.drive.noRoute;
      }
    }
    this.renderDriveUi();
  }

  renderDriveUi() {
    const ui = this.driveUi;
    if (!ui?.panel) return;
    const state = this.drive.status;
    const active = this.drive.active;
    const hasRoute = Boolean(this.driveRoute);
    const canStart = hasRoute && !active && this.isFullMapOpen && this.drive.canStart(this.driveRoute);
    const stateText = STR.drive[state] ?? '';
    const routeStatus = hasRoute ? STR.drive.distance(this.driveRoute.length) : '';
    const hint = this.driveFeedback || (hasRoute ? (canStart ? STR.drive.ready : STR.drive.needsStart)
      : this.driveStart ? STR.drive.chooseEnd : STR.drive.chooseStart);
    const text = [routeStatus, active ? stateText : hint].filter(Boolean).join(' · ');
    if (ui.status.textContent !== text) ui.status.textContent = text;
    const pressed = String(this.isPlanningDrive);
    if (ui.toggle.getAttribute('aria-pressed') !== pressed) ui.toggle.setAttribute('aria-pressed', pressed);
    ui.toggle.disabled = active;
    ui.panel.hidden = !this.isPlanningDrive;
    ui.clear.hidden = !this.driveStart || active;
    ui.arrive.hidden = !hasRoute || active || canStart;
    ui.start.hidden = !hasRoute || active;
    ui.start.disabled = !canStart;
    ui.stop.hidden = !active;
    ui.hud.hidden = !stateText;
    ui.hudStop.hidden = !active;
    if (ui.hudStatus.textContent !== stateText) ui.hudStatus.textContent = stateText;
  }

  drawDrivePins(ctx, view, mini = false) {
    if (!this.isPlanningDrive) return;
    const start = this.driveRoute?.from ?? this.driveStart;
    const end = this.driveRoute?.to ?? this.driveEnd;
    for (const [point, colour, label] of [[start, '#8ce2a9', STR.drive.from], [end, MAP.route, STR.drive.to]]) {
      if (!point || !view.sees({ minX: point.x, maxX: point.x, minZ: point.z, maxZ: point.z })) continue;
      const x = view.toX(point.x), y = view.toY(point.z);
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(x, y, mini ? 5 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, mini ? 3 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (!mini) {
        ctx.font = `700 11px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.lineWidth = 4;
        ctx.strokeStyle = MAP.halo;
        ctx.strokeText(label, x + 10, y - 6);
        ctx.fillText(label, x + 10, y - 6);
      }
    }
  }

  search(text) {
    const q = String(text || '').trim().toLowerCase();
    this.searchHighlight = q;
    this.searchPath = null;
    if (q.length > 0) {
      const lmMatch = [...NYC_LANDMARKS, ...(GEO.metro?.stations || [])].find(place =>
        [place.name, place.short, place.nameEn, place.id, ...(place.aliases ?? [])].some(value => value?.toLowerCase().includes(q))
        || STR.map.landmarkInitials[place.id]?.startsWith(q));
      const roads = ROAD_LABELS.filter(label => roadMatches(label, q));
      if (roads.length) {
        this.searchPath = new Path2D();
        const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const l of roads) {
          addLine(this.searchPath, l.road.pts);
          b.minX = Math.min(b.minX, l.minX);
          b.maxX = Math.max(b.maxX, l.maxX);
          b.minZ = Math.min(b.minZ, l.minZ);
          b.maxZ = Math.max(b.maxZ, l.maxZ);
        }
        this.searchBounds = b;
      }
      if (lmMatch) {
        this.viewCenterX = lmMatch.x;
        this.viewCenterZ = lmMatch.z;
        this.viewZoom = Math.max(this.viewZoom, 0.9);
      } else if (roads.length) {
        const b = this.searchBounds;
        const { w, h } = this.fullSize();
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        const fit = Math.min(w / ((b.maxX - b.minX) * 1.3 + 1), h / ((b.maxZ - b.minZ) * 1.3 + 1));
        this.viewZoom = Math.max(0.05, Math.min(1.2, fit));
      }
    }
    this.renderFullMap();
  }

  cancelPan() {
    const id = this.panPointerId;
    this.panPointerId = null;
    this.isPanning = false;
    if (this.fullCanvasWrap) this.fullCanvasWrap.classList.remove('is-panning');
    if (id !== null && this.fullCanvas && this.fullCanvas.hasPointerCapture(id)) this.fullCanvas.releasePointerCapture(id);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) this.cancelPan();
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      this.renderPointerHint();
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.resizeFullCanvas();
      this.renderFullMap();
    }
  }

  resizeFullCanvas() {
    if (!this.fullCanvas) return;

    const w = this.fullCanvas.clientWidth || window.innerWidth;
    const h = this.fullCanvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6e6 / Math.max(1, w * h)));
    this.fullDpr = dpr;
    this.fullCanvas.width = Math.max(1, Math.floor(w * dpr));
    this.fullCanvas.height = Math.max(1, Math.floor(h * dpr));
  }

  fullSize() {
    const dpr = this.fullDpr || 1;
    if (!this.fullCanvas) return { w: 1200, h: 800 };
    return { w: this.fullCanvas.width / dpr, h: this.fullCanvas.height / dpr };
  }

  fullExtentZoom() {
    const { minX, maxX, minZ, maxZ } = ISLAND_BOUNDS;
    const { w, h } = this.fullSize();
    return Math.min(w / ((maxX - minX) * 1.24), h / ((maxZ - minZ) * 1.06), MAX_ZOOM);
  }

  minViewZoom() {
    return Math.min(MIN_ZOOM, this.fullExtentZoom());
  }

  screenToWorld(sx, sy, width, height) {
    return {
      x: this.viewCenterX + (sx - width * 0.5) / this.viewZoom,
      z: this.viewCenterZ + (sy - height * 0.5) / this.viewZoom
    };
  }

  setMetroLines(refs) {
    this.metroLines = new Set(refs);
    this.miniCache = null;
    this.fullStaticKey = '';
    this.renderFullMap();
  }

  textWidth(ctx, text) {
    const key = `${ctx.font}|${ctx.letterSpacing || ''}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  drawWorld(ctx, v, isMinimap) {
    const layers = mapLayers();
    v.world(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 只显示真实覆盖范围，覆盖之外的背景不声明为水域。
    ctx.save();
    const coverage = new Path2D();
    layers.coverage.each(v, path => coverage.addPath(path));
    ctx.clip(coverage);
    ctx.fillStyle = MAP.water;
    ctx.fillRect(v.minX, v.minZ, v.maxX - v.minX, v.maxZ - v.minZ);
    for (const [name, color] of [['land', MAP.land], ['green', MAP.park], ['wetland', MAP.lawn], ['water', MAP.pond]]) {
      ctx.fillStyle = color;
      layers[name].each(v, path => ctx.fill(path));
    }
    if (v.s >= 0.18) {
      footprintLayers().tones.forEach((layer, i) => {
        ctx.fillStyle = MAP.buildings[i];
        layer.each(v, path => ctx.fill(path));
      });
    }
    if (v.s >= 0.06) {
      ctx.fillStyle = MAP.gardenPath;
      layers.gardenPaths.each(v, path => ctx.fill(path));
    }
    for (const road of layers.roads) {
      if (!v.sees(road.bounds) || (v.s < 0.06 && !road.highway && road.w < 15)) continue;
      ctx.strokeStyle = road.bridge ? MAP.bridge : road.highway ? MAP.highway : MAP.streets;
      ctx.lineWidth = Math.max(0.7 / v.s, road.w);
      ctx.globalAlpha = road.tunnel ? 0.4 : 1;
      ctx.stroke(road.path);
    }
    ctx.globalAlpha = 1;
    if (this.metroLines.size > 0) {
      for (const segment of layers.metro) {
        if (!v.sees(segment.bounds)) continue;
        const line = segment.lines.find(line => this.metroLines.has(line.ref));
        if (!line) continue;
        ctx.strokeStyle = line.colour;
        ctx.lineWidth = 2.5 / v.s;
        ctx.stroke(segment.path);
      }
      ctx.fillStyle = '#ffffff';
      for (const station of GEO.metro?.stations || []) {
        if (!station.lineRefs?.some(ref => this.metroLines.has(ref))) continue;
        ctx.beginPath();
        ctx.arc(station.x, station.z, 3 / v.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.hsrVisible) {
      for (const station of layers.hsr) {
        if (!v.sees(station.bounds)) continue;
        ctx.fillStyle = MAP.railFill;
        ctx.fill(station.path);
        ctx.strokeStyle = MAP.rail;
        ctx.lineWidth = 2.2 / v.s;
        ctx.setLineDash(station.underConstruction ? [8 / v.s, 5 / v.s] : []);
        ctx.stroke(station.path);
        ctx.setLineDash([]);
        if (!isMinimap) {
          const label = `${station.name}（${station.note}）`;
          ctx.font = '600 ' + (11 / v.s) + 'px ' + FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 3 / v.s;
          ctx.strokeStyle = MAP.halo;
          const X = v.toX((station.bounds.minX + station.bounds.maxX) / 2);
          const Y = v.toY((station.bounds.minZ + station.bounds.maxZ) / 2);
          ctx.strokeText(label, X, Y);
          ctx.fillStyle = '#cfe0ff';
          ctx.fillText(label, X, Y);
        }
      }
    }
    if (this.dronesVisible) {
      const drones = layers.drones;
      if (drones) {
        ctx.strokeStyle = MAP.droneRoute;
        ctx.lineWidth = 2 / v.s;
        ctx.setLineDash([9 / v.s, 6 / v.s]);
        for (const route of drones.routes) {
          if (!v.sees(route.bounds)) continue;
          ctx.stroke(route.path);
        }
        ctx.setLineDash([]);
        for (const station of drones.stations) {
          if (!v.sees(station.bounds)) continue;
          ctx.fillStyle = MAP.droneStation;
          ctx.beginPath();
          ctx.arc(v.toX(station.x), v.toY(station.z), 4 / v.s, 0, Math.PI * 2);
          ctx.fill();
          if (!isMinimap && v.s >= 0.32) {
            // 缩到城市级时只画站点名，放大后才显示核实日期，避免标签互相压住。
            const label = v.s >= 0.85 ? `${station.name}（${station.verifiedAt} 核实）` : station.name;
            ctx.font = '600 ' + (10 / v.s) + 'px ' + FONT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 3 / v.s;
            ctx.strokeStyle = MAP.halo;
            ctx.strokeText(label, v.toX(station.x), v.toY(station.z) - 10 / v.s);
            ctx.fillStyle = '#d8ecff';
            ctx.fillText(label, v.toX(station.x), v.toY(station.z) - 10 / v.s);
          }
        }
      }
    }
    if (this.searchPath && !isMinimap) {
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(3 / v.s, 9);
      ctx.stroke(this.searchPath);
    }
    if (this.drivePath) {
      ctx.strokeStyle = MAP.halo;
      ctx.lineWidth = 7 / v.s;
      ctx.stroke(this.drivePath);
      ctx.strokeStyle = MAP.route;
      ctx.lineWidth = 4 / v.s;
      ctx.stroke(this.drivePath);
    }
    ctx.restore();
  }

  drawRoadLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 260, placed = [], majorOnly = false } = {}) {
    const s = v.s;
    const q = this.searchHighlight;
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const inset = (fontPx * 2.5) / s;
    const minX = v.minX + inset;
    const maxX = v.maxX - inset;
    const minZ = v.minZ + inset;
    const maxZ = v.maxZ - inset;
    const cands = [];
    for (const l of ROAD_LABELS) {
      if (l.maxX < minX || l.minX > maxX || l.maxZ < minZ || l.minZ > maxZ) continue;
      const hit = q.length > 0 && roadMatches(l, q);
      if (majorOnly && !l.major && !hit) continue;
      const width = this.textWidth(ctx, l.text);
      const need = (width + 14) / s;
      for (const a of l.anchors) {
        if (a.len < need || a.x < minX || a.x > maxX || a.z < minZ || a.z > maxZ) continue;
        const d = Math.hypot(a.x - v.cx, a.z - v.cz) * s;
        cands.push({ l, a, width, hit, score: (hit ? 1e6 : 0) + (l.highway ? 3000 : 0) + (l.major ? 2000 : 0) + Math.min(a.len * s, 400) - d * 0.5 });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    const byName = new Map();
    let n = 0;
    for (const c of cands) {
      if (n >= maxLabels) break;
      const X = v.toX(c.a.x);
      const Y = v.toY(c.a.z);
      const same = byName.get(c.l.text);
      if (same && same.some(([x, y]) => Math.hypot(x - X, y - Y) < sameNameGap)) continue;
      const hw = c.width * 0.5 + 3;
      const hh = fontPx * 0.5 + 2;
      const ca = Math.abs(Math.cos(c.a.ang));
      const sa = Math.abs(Math.sin(c.a.ang));
      const bx = hw * ca + hh * sa;
      const by = hw * sa + hh * ca;
      const box = [X - bx, Y - by, X + bx, Y + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      if (same) same.push([X, Y]);
      else byName.set(c.l.text, [[X, Y]]);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(c.a.ang);
      ctx.fillStyle = c.hit ? MAP.search : c.l.highway ? '#e3a857' : c.l.major ? '#e8ebf0' : '#9ba5b3';
      ctx.strokeText(c.l.text, 0, 0);
      ctx.fillText(c.l.text, 0, 0);
      ctx.restore();
      n++;
    }
    ctx.textBaseline = 'alphabetic';
  }

  update() {
    if (this.isFullMapOpen && this.isPlanningDrive || this.drive?.status !== this.previousDriveStatus) {
      this.renderDriveUi();
      this.previousDriveStatus = this.drive?.status;
    }
    if (this.isFullMapOpen) {
      this.renderFullMap();
    } else {
      this.renderMinimap();
    }
  }

  renderMinimap() {
    if (!this.miniCtx || !this.miniCanvas) return;

    if (!this.miniCanvas.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const ctx = this.miniCtx;

    const w = this.miniCanvas.clientWidth;
    const h = this.miniCanvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.miniCanvas.width !== bw || this.miniCanvas.height !== bh) {
      this.miniCanvas.width = bw;
      this.miniCanvas.height = bh;
      this.miniCache = null;
    }

    const ent = this.controllerManager.getActiveEntity();
    const px = ent.position.x;
    const pz = ent.position.z;

    const target = Math.max(0.05, RADAR_SCALE / (1 + Math.max(0, ent.position.y - 25) / 180));
    this.miniScale += (target - this.miniScale) * 0.08;
    const scale = this.miniScale;

    if (this.elMiniStreet) {
      const label = getLocationLabel(px, pz);
      if (label !== this.miniStreetText) {
        this.miniStreetText = label;
        this.elMiniStreet.textContent = label;
      }
    }

    const fp = footprintLayers(this.allBlocks);
    const version = fp ? fp.version : 0;
    let c = this.miniCache;
    if (!c || c.version !== version || Math.abs(scale / c.s - 1) > 0.12 ||
      Math.abs(px - c.cx) > w / c.s - w / (2 * scale) - 8 / scale ||
      Math.abs(pz - c.cz) > h / c.s - h / (2 * scale) - 8 / scale) {
      if (!c) {
        c = this.miniCache = { canvas: document.createElement('canvas') };
        c.canvas.width = bw * 2;
        c.canvas.height = bh * 2;
        c.ctx = c.canvas.getContext('2d');
      }
      c.cx = px;
      c.cz = pz;
      c.s = scale;
      c.version = version;
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.fillStyle = '#080c11';
      c.ctx.fillRect(0, 0, bw * 2, bh * 2);
      const cv = new MapView(px, pz, scale, w * 2, h * 2, dpr);
      this.drawWorld(c.ctx, cv, true);
      cv.screen(c.ctx);
      this.drawRoadLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 28, sameNameGap: 180 });
    }

    const v = new MapView(px, pz, scale, w, h, dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#080c11';
    ctx.fillRect(0, 0, bw, bh);
    const k = scale / c.s;
    ctx.drawImage(c.canvas, dpr * ((c.cx - w / c.s - px) * scale + w * 0.5), dpr * ((c.cz - h / c.s - pz) * scale + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);

    v.screen(ctx);
    this.drawDrivePins(ctx, v, true);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    if (this.waypoint) {
      const wx = toX(this.waypoint.x);
      const wy = toY(this.waypoint.z);
      drawWaypoint(ctx, wx, wy, 4.5);
    }

    for (const lm of NYC_LANDMARKS) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) < w * 0.48 && Math.abs(ly) < h * 0.48) {
        ctx.fillStyle = MAP.halo;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const camDir = this.cameraSystem.currentLookAt.clone().sub(this.cameraSystem.currentPos);
    const camAngle = Math.atan2(camDir.x, camDir.z);

    ctx.save();
    ctx.rotate(-camAngle + Math.PI);
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 58);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 58, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.rotate(-ent.heading + Math.PI);
    drawPlayerArrow(ctx, -9, 6.5, 7);
    ctx.restore();

    ctx.restore();
  }

  renderFullMap() {
    if (!this.fullCtx || !this.fullCanvas || !this.isFullMapOpen) return;
    const ctx = this.fullCtx;
    const dpr = this.fullDpr || 1;
    const { w, h } = this.fullSize();
    const v = new MapView(this.viewCenterX, this.viewCenterZ, this.viewZoom, w, h, dpr);

    const ent = this.controllerManager.getActiveEntity();
    if (this.elPlayerInfo) {
      const text = STR.map.playerLocation(getLocationLabel(ent.position.x, ent.position.z));
      if (text !== this.playerInfoText) {
        this.playerInfoText = text;
        this.elPlayerInfo.textContent = text;
      }
    }

    const fp = footprintLayers(this.allBlocks);
    const key = `${v.cx}|${v.cz}|${v.s}|${this.fullCanvas.width}|${this.fullCanvas.height}|${this.searchHighlight}|${fp ? fp.version : 0}`;
    if (!this.fullStatic) this.fullStatic = document.createElement('canvas');
    if (key !== this.fullStaticKey) {
      this.fullStaticKey = key;
      const sc = this.fullStatic;
      if (sc.width !== this.fullCanvas.width || sc.height !== this.fullCanvas.height) {
        sc.width = this.fullCanvas.width;
        sc.height = this.fullCanvas.height;
      }
      this.renderFullMapStatic(sc.getContext('2d'), v);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fullStatic, 0, 0);
    v.screen(ctx);
    this.drawDrivePins(ctx, v);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    if (this.waypoint) {
      const wx = toX(this.waypoint.x);
      const wy = toY(this.waypoint.z);
      drawWaypoint(ctx, wx, wy, 7);
    }

    const px = toX(ent.position.x);
    const py = toY(ent.position.z);

    ctx.save();
    ctx.translate(px, py);
    const pulse = (performance.now() % 1800) / 1800;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.24 * (1 - pulse)})`;
    ctx.beginPath();
    ctx.arc(0, 0, 10 + pulse * 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(-ent.heading + Math.PI);
    drawPlayerArrow(ctx, -11, 7.5, 8);
    ctx.restore();

    ctx.restore();
  }

  renderFullMapStatic(ctx, v) {
    const { w, h, s } = v;
    ctx.save();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#080c11';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    this.drawWorld(ctx, v, false);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    ctx.font = `700 11px ${FONT}`;
    const pins = NYC_LANDMARKS.map(lm => ({ lm, lx: toX(lm.x), ly: toY(lm.z) }))
      .filter(({ lx, ly }) => Math.abs(lx) <= w * 0.48 && Math.abs(ly) <= h * 0.48)
      .sort((a, b) => Number(Boolean(b.lm.mapPriority)) - Number(Boolean(a.lm.mapPriority)));
    const placed = pins.map(({ lx, ly }) => [lx - 6, ly - 6, lx + 6, ly + 6]);
    for (const pin of pins) {
      const { lx, ly, lm } = pin;
      const width = this.textWidth(ctx, lm.short);
      const positions = [[lx + 9, ly + 4], [lx - width - 9, ly + 4],
        [lx - width / 2, ly - 9], [lx - width / 2, ly + 18]];
      for (const [x, y] of positions) {
        const box = [x - 2, y - 11, x + width + 2, y + 3];
        if (box[0] < -w / 2 || box[2] > w / 2 || box[1] < -h / 2 || box[3] > h / 2 || overlaps(placed, box)) continue;
        pin.label = { x, y };
        placed.push(box);
        break;
      }
    }

    const fontPx = Math.max(9, Math.min(12, Math.round(9.5 * Math.sqrt(Math.max(s, 0.4)))));
    this.drawRoadLabels(ctx, v, { fontPx, maxLabels: 420, sameNameGap: 300, placed, majorOnly: s < 0.3 });

    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (const { lm, lx, ly, label } of pins) {
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(lx, ly, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
      ctx.fill();
      if (label) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = MAP.halo;
        ctx.strokeText(lm.short, label.x, label.y);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(lm.short, label.x, label.y);
      }
    }

    this.drawScaleBar(ctx, v);
    ctx.restore();
  }

  drawScaleBar(ctx, v) {
    const target = 120 / v.s;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= target).pop() || pow;
    const len = step * v.s;
    const x0 = -v.w * 0.5 + 24;
    const y0 = v.h * 0.5 - 26;
    const label = STR.map.scale(step);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 6);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.lineTo(x0 + len, y0 - 6);
    ctx.strokeStyle = MAP.halo;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236, 239, 244, 0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `650 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    ctx.strokeText(label, x0 + len + 8, y0 + 3);
    ctx.fillStyle = 'rgba(236, 239, 244, 0.95)';
    ctx.fillText(label, x0 + len + 8, y0 + 3);
  }
}

export { NYCMapSystem, NYCMapSystem as SZMapSystem };
