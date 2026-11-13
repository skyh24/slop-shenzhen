import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { NYC_LANDMARKS, ISLAND_BOUNDS, getLocationLabel, isTypingInField } from './sz-city-config.js';
import { STR } from './sz-strings.js';
import { createMapRegions } from './sz-map-regions.js';
import { wireMapInspection } from './sz-map-inspection.js';
import { MAP, ROAD_LABELS, ROAD_NAME_COUNT, MapView, addLine, mapLayers, footprintLayers, droneMapLayer, drawPlayerArrow, drawWaypoint, overlaps } from './sz-map-layers.js';

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
  constructor({ controllerManager, cameraSystem, allBlocks = [], onTeleport, onToggle, drive = null, airCruise = null, drones = null, touchHints = false }) {
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.allBlocks = allBlocks;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;
    this.drive = drive;
    this.airCruise = airCruise;
    this.cruisePreview = null;
    this.touchHints = touchHints;

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext('2d') : null;
    this.elMiniDrone = document.getElementById('minimap-drone-label');
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
    this.mapLayersVisible = { landmarks: true, retail: true, regions: true, interchanges: true };
    this.regions = null;

    this.searchHighlight = '';
    this.searchPath = null;
    this.textWidths = new Map();

    this.waypoint = null;
    this.metroLines = new Set();
    this.transportTab = 'map-metro';
    this.hsrStation = null;
    this.hsrVisible = false;
    this.dronesVisible = false;
    this.droneControls = drones;
    this.droneLayer = drones ? droneMapLayer(drones.stations, drones.routes) : null;
    this.droneStation = null;
    this.droneFeedback = '';
    this.driveStart = null;
    this.driveEnd = null;
    this.driveRoute = null;
    this.drivePath = null;
    this.driveFeedback = '';
    this.drivePicks = [null, null];
    this.driveLayer = null;

    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.textWidths.clear();
        this.miniCache = null;
        this.fullStaticKey = '';
      });
    }

    this.initEvents();
    this.inspection = wireMapInspection(this);
    this.bindTransportTabs();
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
        this.refreshView();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        this.viewZoom = Math.max(this.minViewZoom(), this.viewZoom / 1.45);
        this.refreshView();
      });
    }
    if (centerPlayerBtn) {
      centerPlayerBtn.addEventListener('click', () => {
        const ent = this.viewEntity();
        this.viewCenterX = ent.position.x;
        this.viewCenterZ = ent.position.z;
        this.viewZoom = 0.9;
        this.refreshView();
      });
    }
    if (fullIslandBtn) {
      fullIslandBtn.addEventListener('click', () => {
        const b = ISLAND_BOUNDS;
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        this.viewZoom = this.fullExtentZoom();
        this.refreshView();
      });
    }

    if (this.elSearchInput) {
      this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) {
        if (this.airCruise?.active) e.preventDefault();
        this.toggleFullMap(false);
      } else if (e.code === 'KeyM' && !isTypingInField(e)) {
        this.toggleFullMap(!this.isFullMapOpen);
      }
    });
  }

  get isPlanningDrive() {
    return this.transportTab === 'map-plan-drive';
  }

  bindTransportTabs() {
    const first = document.getElementById('map-metro');
    if (!first) return;
    const tabs = [...first.parentElement.querySelectorAll('[role="tab"]')];
    this.transportTabs = new Map(tabs.map(tab => [tab.id, {
      tab, page: document.getElementById(tab.getAttribute('aria-controls'))
    }]));
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => this.selectTransportTab(tab.id));
      tab.addEventListener('keydown', event => {
        const target = { ArrowLeft: (index - 1 + tabs.length) % tabs.length,
          ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        this.selectTransportTab(tabs[target].id);
        tabs[target].focus();
      });
    }
    this.bindDroneCard();
  }

  selectTransportTab(id) {
    if (!this.transportTabs?.has(id) || this.transportTab === id) return;
    const previous = this.transportTab;
    this.transportTab = id;
    for (const [key, { tab, page }] of this.transportTabs) {
      const active = key === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      page.hidden = !active;
    }
    if (id === 'map-hsr' && !this.hsrUI) this.bindHsrCard();
    this.inspection?.reset();
    this.setDroneLayer(id === 'map-drones');
    if (previous === 'map-plan-drive' || this.isPlanningDrive) this.invalidateLayers();
    this.renderDriveUi();
    this.refreshView();
  }

  invalidateLayers() {
    this.miniCache = null;
    this.fullStaticKey = '';
  }

  focusStation({ x, z }) {
    this.viewCenterX = x;
    this.viewCenterZ = z;
    this.viewZoom = Math.max(this.viewZoom, 0.75);
  }

  bindHsrCard() {
    const get = suffix => document.getElementById('map-hsr-' + suffix);
    const list = get('stations'), layer = get('layer'), visit = get('visit'), status = get('status');
    this.hsrUI = { layer, visit, status, buttons: new Map() };
    for (const station of mapLayers().hsr) {
      const button = this.stationButton(station.name, () => this.selectHsrStation(station));
      this.hsrUI.buttons.set(station.id, button);
      list.append(button);
    }
    layer.addEventListener('change', () => this.setHsrVisible(layer.checked));
    visit.addEventListener('click', async () => {
      const station = this.hsrStation;
      if (!station) return;
      const { id, x, z, name, polygons } = station;
      const arrived = await this.onTeleport?.(x, z, undefined, {
        current: () => this.hsrStation === station, waypoint: { x, z, name }, stationVisit: { id, exterior: id === 'futian-station' ? [] : polygons }
      });
      if (!arrived) {
        status.textContent = STR.hsr.visitUnavailable;
        status.hidden = false;
      }
    });
  }

  stationButton(name, select) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pop-item';
    button.textContent = name;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', select);
    return button;
  }

  selectHsrStation(station, center = true) {
    this.hsrStation = station;
    const { visit, status, buttons } = this.hsrUI;
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === station.id));
    visit.disabled = false;
    status.textContent = station.underConstruction ? STR.hsr.xiliVisit
      : station.id === 'futian-station' ? STR.hsr.futianVisit : '';
    status.hidden = !status.textContent;
    if (center) this.focusStation(station);
    this.setHsrVisible(true);
  }

  setHsrVisible(visible) {
    this.hsrVisible = visible;
    this.hsrUI.layer.checked = visible;
    this.invalidateLayers();
    this.refreshView();
  }

  regionLayer() {
    if (!GEO.mapRegions) return null;
    return this.regions ??= createMapRegions(GEO.mapRegions.regions);
  }

  refreshView() {
    this.inspection?.refreshHover();
    this.renderFullMap();
  }

  initDriveEvents() {
    const get = id => document.getElementById(id);
    this.driveUi = { panel: get('map-drive-panel'), status: get('map-drive-status'),
      levels: get('map-drive-levels'), clear: get('map-drive-clear'), repickEnd: get('map-drive-repick-end'),
      start: get('map-drive-start'), progress: get('map-drive-progress'), hudProgress: get('drive-hud-progress'),
      pauses: [get('map-drive-pause'), get('drive-hud-pause')], resumes: [get('map-drive-resume'), get('drive-hud-resume')],
      stops: [get('map-drive-stop'), get('drive-hud-stop')], hud: get('drive-hud'), hudStatus: get('drive-hud-status') };
    const { clear, repickEnd, start, pauses, resumes, stops } = this.driveUi;
    clear?.addEventListener('click', () => this.resetDrivePlan());
    repickEnd?.addEventListener('click', () => this.resetDrivePlan(true));
    start?.addEventListener('click', () => {
      const route = this.driveRoute;
      const current = () => this.isFullMapOpen && this.driveRoute === route;
      const finish = started => {
        if (!current()) return;
        if (started) this.toggleFullMap(false);
        else this.driveFeedback = STR.drive.needsStart;
        this.renderDriveUi();
      };
      const started = this.drive.start(route, current);
      if (started?.then) started.then(finish);
      else finish(started);
    });
    for (const button of pauses) button?.addEventListener('click', () => this.drive.pause());
    for (const button of resumes) button?.addEventListener('click', () => this.drive.resume());
    for (const button of stops) button?.addEventListener('click', () => this.drive.stop('cancelled'));
  }

  resetDrivePlan(keepStart = false) {
    if (this.drive.active) return;
    this.drive.stop();
    if (!keepStart) {
      this.driveStart = null;
      this.drivePicks[0] = null;
    }
    this.drivePicks[1] = null;
    this.driveEnd = this.driveRoute = null;
    this.setDrivePath(null);
    this.driveLayer = null;
    this.driveFeedback = '';
    this.renderDriveUi();
  }

  setDrivePath(route) {
    this.drivePath = route ? new Path2D() : null;
    if (route) addLine(this.drivePath, route.samples);
    this.miniCache = null;
    this.fullStaticKey = '';
  }

  renderPointerHint(region = '') {
    if (!this.elHoverInfo) return;
    const hint = this.isPlanningDrive
      ? (this.touchHints ? STR.drive.touchHint : STR.drive.mapHint)
      : region || (this.touchHints ? STR.map.touchHint : STR.map.clickHint);
    if (this.elHoverInfo.textContent !== hint) this.elHoverInfo.textContent = hint;
    this.elHoverInfo.classList?.toggle('has-region', Boolean(region));
  }

  pickDrivePoint(x, z) {
    if (this.drive.active) return;
    if (this.driveEnd || (!this.driveLayer && this.drive.status !== 'idle')) this.resetDrivePlan(true);
    const start = !this.driveStart;
    this.drivePicks[start ? 0 : 1] = { x, z };
    const point = this.drive.snap(x, z, start);
    this.driveLayer = null;
    if (!point) {
      this.driveFeedback = STR.drive.noPoint;
    } else if (point.levels?.length > 1) {
      this.driveLayer = point.levels;
      this.driveFeedback = STR.drive.chooseLayer;
    } else {
      this.chooseDrivePoint(point);
      return;
    }
    this.renderDriveUi();
  }

  chooseDrivePoint(point) {
    this.driveLayer = null;
    this.driveFeedback = '';
    if (!this.driveStart) this.driveStart = point;
    else {
      this.driveEnd = point;
      this.driveRoute = this.drive.route(this.driveStart, point);
      this.setDrivePath(this.driveRoute);
      if (!this.driveRoute) this.driveFeedback = STR.drive.noRoute;
    }
    this.renderDriveUi();
  }

  renderDriveUi() {
    const ui = this.driveUi;
    if (!ui?.panel) return;
    const state = this.drive.status;
    const active = this.drive.active;
    const replacement = this.drive.activeRoute;
    if (replacement && this.driveRoute !== replacement) {
      this.driveRoute = replacement;
      this.drivePicks[0] = null;
      this.setDrivePath(replacement);
    }
    const hasRoute = Boolean(this.driveRoute);
    const canStart = hasRoute && !active && this.isFullMapOpen && this.drive.canStart(this.driveRoute);
    const stateText = STR.drive[state] ?? '';
    const routeStatus = hasRoute ? STR.drive.distance(this.driveRoute.length, this.driveRoute.seconds) : '';
    const hint = this.driveFeedback || (hasRoute ? (canStart ? STR.drive.ready : STR.drive.needsStart)
      : this.driveStart ? STR.drive.chooseEnd : STR.drive.chooseStart);
    const text = [routeStatus, active || stateText ? stateText : hint].filter(Boolean).join(' · ');
    if (ui.status.textContent !== text) ui.status.textContent = text;
    if (ui.hudStatus.textContent !== stateText) ui.hudStatus.textContent = stateText;
    const progress = this.drive.progress;
    const summary = active && progress?.length && !['occupied', 'preparing'].includes(state)
      ? STR.drive.progress(progress.speed, progress.travelled, progress.length) : '';
    for (const element of [ui.progress, ui.hudProgress]) {
      element.hidden = !summary;
      if (element.textContent !== summary) element.textContent = summary;
    }
    ui.clear.hidden = active || (!this.drivePicks[0] && !this.driveStart);
    ui.repickEnd.hidden = !this.drivePicks[1] || active;
    ui.start.hidden = active;
    ui.start.disabled = !canStart;
    ui.hud.hidden = !stateText;
    for (const button of ui.stops) button.hidden = !active;
    for (const button of ui.pauses) button.hidden = !active || ['occupied', 'preparing', 'pausing', 'paused'].includes(state);
    for (const button of ui.resumes) button.hidden = state !== 'paused';
    ui.levels.hidden = !this.driveLayer;
    if (this.driveLayer !== this.previousDriveLayer) {
      this.previousDriveLayer = this.driveLayer;
      ui.levels.replaceChildren(...(this.driveLayer ?? []).map(level => {
        const button = document.createElement('button');
        button.className = 'tool-btn';
        button.type = 'button';
        button.textContent = STR.drive.layer(level.level, level.heightLayer, level.y, level.name);
        button.addEventListener('click', () => this.chooseDrivePoint(level));
        return button;
      }));
    }
  }

  drawDrivePins(ctx, view, mini = false) {
    if (!this.isPlanningDrive && !this.drive?.active) return;
    const start = this.driveRoute?.from ?? this.driveStart;
    const end = this.driveRoute?.to ?? this.driveEnd;
    const picks = this.drivePicks;
    if (!mini) {
      for (const [pick, actual] of [[picks[0], start], [picks[1], end]]) {
        if (!pick || !actual) continue;
        const x = view.toX(pick.x), y = view.toY(pick.z);
        const ax = view.toX(actual.x), ay = view.toY(actual.z);
        if (Math.hypot(ax - x, ay - y) < 3) continue;
        ctx.save();
        ctx.strokeStyle = '#e1ebf5';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.restore();
      }
    }
    const pins = mini ? [] : [[picks[0], '#ccd5df', start ? '' : STR.drive.pickFrom],
      [picks[1], '#ccd5df', end ? '' : STR.drive.pickTo]];
    pins.push([start, '#8ce2a9', STR.drive.from], [end, MAP.route, STR.drive.to]);
    for (const [point, colour, label] of pins) {
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
      if (!mini && label) {
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
      } else {
        const region = this.regionLayer()?.regions.find(row => row.name?.toLowerCase() === q)
          ?? this.regionLayer()?.regions.find(row => row.name?.toLowerCase().includes(q));
        if (region) {
          const [x, z] = region.anchors[0];
          this.viewCenterX = x;
          this.viewCenterZ = z;
          this.viewZoom = Math.max(0.8, region.minZoom, this.viewZoom);
          this.mapLayersVisible[region.type === 'retail' ? 'retail' : 'regions'] = true;
          document.getElementById(region.type === 'retail' ? 'map-layer-retail' : 'map-layer-regions')
            ?.setAttribute('aria-pressed', 'true');
        }
      }
    }
    this.refreshView();
  }

  bindDroneCard() {
    const get = suffix => document.getElementById('map-drone-' + suffix);
    const ui = this.droneUI = {
      route: get('route'), status: get('status'), approach: get('approach'), follow: get('follow'), buttons: new Map()
    };
    if (!this.droneLayer?.stations.length) {
      ui.status.textContent = STR.drones.noStations;
      return;
    }
    const list = get('stations');
    for (const station of this.droneLayer.stations) {
      const name = STR.drones.stationNames[station.id] ?? station.name;
      const button = this.stationButton(name, () => this.selectDroneStation(station.id, true));
      ui.buttons.set(station.id, button);
      list.append(button);
    }
    ui.approach.addEventListener('click', async () => {
      const station = this.droneStation;
      if (await this.droneControls.approach(station, () => this.isFullMapOpen && station === this.droneStation)) this.toggleFullMap(false);
      else {
        this.droneFeedback = STR.drones.approachUnavailable;
        this.renderDroneCard();
      }
    });
    ui.follow.addEventListener('click', async () => {
      const station = this.droneStation;
      const { suspended, route } = this.droneControls.status(station.id);
      const demo = suspended || Boolean(route?.simulationOnly);
      if (await this.droneControls.follow(station, demo, { remote: true,
        current: () => this.isFullMapOpen && station === this.droneStation })) this.toggleFullMap(false);
      else {
        this.droneFeedback = STR.drones.visitUnavailable;
        this.renderDroneCard();
      }
    });
  }

  setDroneLayer(visible) {
    if (!this.droneLayer?.stations.length || this.dronesVisible === visible) return;
    this.dronesVisible = visible;
    if (visible) {
      this.selectDroneStation(this.droneStation?.id ?? this.droneLayer.stations[0].id, false);
    } else {
      this.droneControls.preview(null);
      this.invalidateLayers();
    }
  }

  pickTransportStation(point) {
    const stations = this.transportTab === 'map-drones' && this.dronesVisible ? this.droneLayer.stations
      : this.transportTab === 'map-hsr' && this.hsrVisible ? mapLayers().hsr : [];
    let selected;
    let distance = 10 / this.viewZoom;
    for (const station of stations) {
      const d = Math.hypot(station.x - point.x, station.z - point.z);
      if (d > distance) continue;
      selected = station;
      distance = d;
    }
    if (!selected) return false;
    if (this.transportTab === 'map-drones') this.selectDroneStation(selected.id, false);
    else this.selectHsrStation(selected, false);
    return true;
  }

  selectDroneStation(id, center) {
    const station = this.droneLayer.stations.find(item => item.id === id);
    if (!station) return;
    this.droneStation = station;
    this.droneFeedback = '';
    for (const [key, button] of this.droneUI.buttons) button.setAttribute('aria-pressed', String(key === id));
    if (center) this.focusStation(station);
    this.droneControls.preview(id);
    this.invalidateLayers();
    this.renderDroneCard();
    this.refreshView();
  }

  renderDroneCard() {
    if (!this.droneStation || !this.dronesVisible || !this.isFullMapOpen) return;
    const ui = this.droneUI, strings = STR.drones;
    const { route, suspended, mission, available, failed, blocked, canApproach } = this.droneControls.status(this.droneStation.id);
    const demo = suspended || Boolean(route?.simulationOnly);
    const active = mission && mission.pose.phase !== 'complete';
    const phase = active && strings.phase[mission.pose.phase];
    const loading = !failed && route?.path.points && !route.path.reason;
    const lines = [this.droneFeedback, suspended && strings.statusSuspended,
      route?.simulationOnly && (route.path.detour ? strings.detour : strings.simulationOnly),
      !available && (loading ? strings.preparing : strings.unavailable), blocked && strings.blocked,
      active && (mission.demo ? strings.simulation + ' · ' : '') + (mission.pose.returning ? strings.returning(phase) : phase)]
      .filter(Boolean);
    const status = lines.join(' / ') || strings.phase.loading;
    if (ui.status.textContent !== status) ui.status.textContent = status;
    const label = demo ? strings.visitSimulation : STR.map.visit;
    if (ui.follow.textContent !== label) ui.follow.textContent = label;
    const name = station => strings.stationNames[station.id] ?? station.name;
    const routeLabel = route?.from && route.to ? name(route.from) + ' ⇄ ' + name(route.to) + ' · ' + strings.estimate : strings.estimate;
    if (ui.route.textContent !== routeLabel) ui.route.textContent = routeLabel;
    ui.approach.hidden = !this.droneStation.approach || !canApproach;
    ui.follow.disabled = !available || blocked || Boolean(active && mission.demo !== demo);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) {
      this.inspection?.reset();
      if (this.cruisePreview) {
        this.viewZoom = this.cruisePreview.zoom;
        this.cruisePreview = null;
      }
      this.setDroneLayer(false);
    }
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.viewEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.resizeFullCanvas();
      if (this.drive?.active) this.selectTransportTab('map-plan-drive');
      this.setDroneLayer(this.transportTab === 'map-drones');
      this.renderPointerHint();
      this.renderDriveUi();
      this.renderFullMap();
    }
  }

  viewEntity() {
    return this.airCruise?.entity ?? this.controllerManager.getActiveEntity();
  }

  showCruiseRoute(route) {
    this.toggleFullMap(true);
    this.cruisePreview = { route, zoom: this.viewZoom };
    const { w, h } = this.fullSize();
    const xs = route.points.map(p => p.x), zs = route.points.map(p => p.z);
    const west = Math.min(...xs), east = Math.max(...xs), north = Math.min(...zs), south = Math.max(...zs);
    this.viewCenterX = (west + east) / 2;
    this.viewCenterZ = (north + south) / 2;
    this.viewZoom = Math.max(this.minViewZoom(), Math.min(MAX_ZOOM, w * 0.85 / (east - west), h * 0.7 / (south - north)));
    this.renderFullMap();
  }

  drawCruiseRoute(ctx, v) {
    const route = this.cruisePreview?.route ?? this.airCruise?.route;
    if (!route) return;
    let cached = this.cruiseMapPath;
    if (cached?.route !== route) {
      const path = new Path2D();
      addLine(path, route.points);
      cached = this.cruiseMapPath = { route, path };
    }
    ctx.save();
    v.world(ctx);
    ctx.lineWidth = 7 / v.s;
    ctx.strokeStyle = '#081923';
    ctx.stroke(cached.path);
    ctx.lineWidth = 3 / v.s;
    ctx.strokeStyle = '#63e5fa';
    ctx.stroke(cached.path);
    v.screen(ctx);
    for (const [i, point] of [route.points[0], route.points.at(-1)].entries()) {
      const x = v.toX(point.x), z = v.toY(point.z);
      ctx.beginPath();
      ctx.arc(x, z, 5, 0, Math.PI * 2);
      ctx.fillStyle = i ? '#f8ca69' : '#63e5fa';
      ctx.fill();
      ctx.strokeStyle = '#081923';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
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

  maxViewZoom() { return MAX_ZOOM; }

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
    if (!isMinimap) this.regionLayer()?.draw(ctx, v, this.mapLayersVisible);
    if (v.s >= 0.18) {
      footprintLayers().tones.forEach((layer, i) => {
        ctx.fillStyle = MAP.buildings[i];
        layer.each(v, path => ctx.fill(path));
      });
    }
    if (!isMinimap && v.s >= 1.15) this.regions?.draw(ctx, v, this.mapLayersVisible, true);
    if (v.s >= 0.06) {
      ctx.fillStyle = MAP.gardenPath;
      layers.gardenPaths.each(v, path => ctx.fill(path));
    }
    for (const road of layers.roads) {
      if ((!isMinimap && !this.mapLayersVisible.interchanges && road.elevated)
        || !v.sees(road.bounds) || (v.s < 0.06 && !road.highway && road.w < 15)) continue;
      ctx.strokeStyle = road.elevated ? MAP.bridge : road.highway ? MAP.highway : MAP.streets;
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
      ctx.strokeStyle = '#d2a177';
      ctx.lineWidth = 0.85 / v.s;
      for (const rail of layers.hsrRails ?? []) if (v.sees(rail.bounds)) ctx.stroke(rail.path);
      for (const station of layers.hsr) {
        if (!v.sees(station.bounds)) continue;
        if (station.path) {
          ctx.fillStyle = MAP.railFill;
          ctx.fill(station.path);
          ctx.strokeStyle = MAP.rail;
          ctx.lineWidth = 2.2 / v.s;
          ctx.setLineDash(station.underConstruction ? [8 / v.s, 5 / v.s] : []);
          ctx.stroke(station.path);
          ctx.setLineDash([]);
        }
        const selected = this.hsrStation?.id === station.id;
        this.drawTransportMarker(ctx, v, station, MAP.rail, selected, isMinimap ? '' : station.name);
      }
    }
    if (this.dronesVisible) {
      const drones = this.droneLayer;
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
          const selected = this.droneStation?.id === station.id;
          const name = STR.drones.stationNames[station.id] ?? station.name;
          const label = !isMinimap && (selected || v.s >= 0.32) ? name : '';
          this.drawTransportMarker(ctx, v, station, station.available === false ? '#ab9d87' : MAP.droneStation, selected, label);
        }
      }
    }
    if (this.searchPath && !isMinimap) {
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(3 / v.s, 9);
      ctx.stroke(this.searchPath);
    }
    if (this.drivePath && (this.isPlanningDrive || this.drive?.active)) {
      ctx.strokeStyle = MAP.halo;
      ctx.lineWidth = 7 / v.s;
      ctx.stroke(this.drivePath);
      ctx.strokeStyle = MAP.route;
      ctx.lineWidth = 4 / v.s;
      ctx.stroke(this.drivePath);
    }
    ctx.restore();
  }

  drawTransportMarker(ctx, view, station, colour, selected, label) {
    const x = station.x, z = station.z;
    ctx.beginPath();
    ctx.arc(x, z, (selected ? 6 : 4) / view.s, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 2 / view.s;
    ctx.strokeStyle = selected ? '#f3f7ff' : MAP.halo;
    ctx.stroke();
    if (!label) return;
    ctx.font = `600 ${11 / view.s}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 / view.s;
    ctx.strokeStyle = MAP.halo;
    ctx.strokeText(label, x, z - 9 / view.s);
    ctx.fillStyle = '#d8ecff';
    ctx.fillText(label, x, z - 9 / view.s);
  }

  drawRoadLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 260, placed = [], majorOnly = false, mini = false } = {}) {
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
      if ((majorOnly && !l.major && !hit)
        || (!this.mapLayersVisible.interchanges && !hit && l.elevated && !mini)) continue;
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
    this.renderDroneCard();
    const driveActive = Boolean(this.drive?.active);
    if (driveActive !== this.previousDriveActive) {
      this.previousDriveActive = driveActive;
      this.invalidateLayers();
    }
    if (driveActive || (this.isFullMapOpen && this.isPlanningDrive) || this.drive?.status !== this.previousDriveStatus) {
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

    const mission = this.droneControls?.followedMission;
    const ent = mission?.pose ?? this.viewEntity();
    if (this.elMiniDrone) this.elMiniDrone.hidden = !mission;
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
      this.drawRoadLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 28, sameNameGap: 180, mini: true });
    }

    const v = new MapView(px, pz, scale, w, h, dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#080c11';
    ctx.fillRect(0, 0, bw, bh);
    const k = scale / c.s;
    ctx.drawImage(c.canvas, dpr * ((c.cx - w / c.s - px) * scale + w * 0.5), dpr * ((c.cz - h / c.s - pz) * scale + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);

    const track = mission && this.droneLayer?.routes.find(route => route.id === mission.routeId);
    if (track && v.sees(track.bounds)) {
      ctx.save();
      v.world(ctx);
      ctx.strokeStyle = MAP.droneRoute;
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([5 / scale, 4 / scale]);
      ctx.stroke(track.path);
      ctx.restore();
    }

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
    ctx.rotate(-(mission ? ent.yaw : ent.heading) + Math.PI);
    drawPlayerArrow(ctx, -9, 6.5, 7, mission ? MAP.droneStation : undefined);
    ctx.restore();

    ctx.restore();
  }

  renderFullMap() {
    if (!this.fullCtx || !this.fullCanvas || !this.isFullMapOpen) return;
    const ctx = this.fullCtx;
    const dpr = this.fullDpr || 1;
    const { w, h } = this.fullSize();
    const v = new MapView(this.viewCenterX, this.viewCenterZ, this.viewZoom, w, h, dpr);

    const ent = this.viewEntity();
    const { x: playerX, z: playerZ } = ent.position;
    if (this.elPlayerInfo && (this.mapPlayerX !== playerX || this.mapPlayerZ !== playerZ)) {
      this.mapPlayerX = playerX;
      this.mapPlayerZ = playerZ;
      const text = this.airCruise?.active ? STR.cruise.mapLocation(getLocationLabel(playerX, playerZ))
        : STR.map.playerLocation(getLocationLabel(playerX, playerZ));
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
    this.regions?.drawHighlight(ctx, v, this.inspection?.highlight, this.mapLayersVisible);
    v.screen(ctx);
    const selection = this.inspection?.selection;
    if (selection) {
      const x = v.toX(selection.x), z = v.toY(selection.z);
      ctx.beginPath();
      ctx.arc(x, z, 8, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = MAP.search;
      ctx.stroke();
    }
    this.drawDrivePins(ctx, v);
    this.drawCruiseRoute(ctx, v);
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
    const pins = (this.mapLayersVisible.landmarks ? NYC_LANDMARKS : []).map(lm => ({ lm, lx: toX(lm.x), ly: toY(lm.z) }))
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

    this.regions?.drawLabels(ctx, v, this.mapLayersVisible, placed, FONT, (c, name) => this.textWidth(c, name));

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
