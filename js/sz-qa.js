// QA 调试入口：只在回环地址（127.0.0.1 / localhost）且 ?qa=1 时安装。
// 固定机位、?skip= 阶段开关、window.__sz* 模块对象、调试函数、帧与 GPU 采样都集中在这里；
// 入口只把运行时对象交给 install()，普通游玩地址下不向 window 暴露任何调试对象。
import * as THREE from 'three/webgpu';
import { GEO } from './sz-geodata.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

// 可以从构建流程里跳过的阶段名。占位对象只实现调用方实际用到的最少成员；
// 跳过只用于启动/帧时二分，不保证被跳过的系统还能正常游玩。
const STAGE_STUBS = {
  landmarks: () => ({ group: emptyGroup(), colliders: [], surfaces: [], skipIds: new Set(), dispose: () => {} }),
  themeParks: () => ({ group: emptyGroup(), colliders: [], surfaces: [], skipIds: new Set(), trees: [],
    pathAt: () => [], reserved: () => false, update() {}, snapshot: () => null, dispose() {} }),
  blocks: () => ({ group: emptyGroup(), colliders: [], allBlocks: [] }),
  lightshow: () => ({ group: emptyGroup(), update: () => {} }),
  signs: () => ({ group: emptyGroup(), update: () => {}, nearestName: () => null, statistics: {} }),
  details: () => ({ group: emptyGroup(), update: () => {}, statistics: {} }),
  paint: () => ({ group: emptyGroup() }),
  elevated: () => ({ group: emptyGroup(), links: [], surfaces: [], colliders: [], drive: { links: [], heightAt: () => null } }),
  streetscape: () => ({ group: emptyGroup(), observedTrees: [], findArrival: () => null, pathAt: () => [], statistics: {}, dispose() {} }),
  lamps: () => ({ group: emptyGroup(), update: () => {} }),
  trees: () => ({ group: emptyGroup(), colliders: [], update: () => {}, statistics: {} }),
  apec: () => ({ group: emptyGroup(), enabled: false, setEnabled: () => false, update: () => {} }),
  apecCity: () => ({ group: emptyGroup(), update: () => {} }),
  metro: () => ({ group: emptyGroup(), colliders: [], update: () => {} }),
  stations: () => null,
  drones: () => ({ group: emptyGroup(), colliders: [], stations: [], routes: [],
    status: () => ({}), preview() {}, update() {}, dispose() {} }),
  traffic: () => ({ group: emptyGroup(), update: () => {}, nearColliders: () => [], statistics: {}, vehicles: [], network: null }),
  pedestrians: () => ({ group: emptyGroup(), update: () => {}, statistics: {}, dispose() {} })
};

function emptyGroup() {
  return new THREE.Group();
}

// ?qa=1&cam=x,y,z,tx,ty,tz：固定机位只用于同机位截图对照，格式不对直接报错。
function parseCamera(value) {
  if (!value) return null;
  const numbers = value.split(',').map(Number);
  if (numbers.length !== 6 || !numbers.every(Number.isFinite)) {
    throw new Error('Invalid QA camera: expected x,y,z,tx,ty,tz');
  }
  return numbers;
}

function summarizeSamples(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
}

export function createQaSession({ search, hostname, defaultChunkSize }) {
  return new QaSession(new URLSearchParams(search), hostname, defaultChunkSize);
}

class QaSession {
  constructor(query, hostname, defaultChunkSize) {
    this.enabled = LOOPBACK_HOSTS.has(hostname) && query.get('qa') === '1';
    // chunk 参数改变普通楼的渲染分块，用于对照 draw call 与剔除粒度。
    this.chunkSize = this.enabled && query.get('chunks') === '500' ? 500 : defaultChunkSize;
    this.camera = this.enabled ? parseCamera(query.get('cam')) : null;
    // ?skip=landmarks,trees,…：只在 qa 下生效，其它地址下仍然走完整构建。
    this.skipped = new Set((this.enabled ? query.get('skip') ?? '' : '').split(',').map(name => name.trim()).filter(Boolean));
    this.cruiseEvidence = this.enabled && query.get('cruiseEvidence') === '1';
    this.railEvidence = this.enabled && query.get('railEvidence') === '1';
    this.railRecord = this.railEvidence && query.get('record') === '1';
    this.startup = {};
    this.startupAt = {};
    this.compilation = {};
    this.frames = [];
    this.gpu = [];
    this.queue = [];
    this.previousFrameAt = null;
    this.queryPending = false;
    this.queuePending = false;
    this.sampledFrames = 0;
    this.runtime = null;
    this.publishTalent = this.enabled && query.get('telemetry') === 'talent';
    this.nextTalentSample = 0;
  }

  // 跳过某个构建阶段时返回占位对象，否则执行构建函数。
  stage(name, build) {
    return this.measureBuild(name, () => {
      if (!this.enabled || !this.skipped.has(name)) return build();
      const stub = STAGE_STUBS[name];
      if (!stub) throw new Error(`Unknown skip stage: ${name}`);
      return stub();
    });
  }

  measureBuild(name, build) {
    if (!this.enabled) return build();
    const started = performance.now();
    try {
      return build();
    } finally {
      this.markStartup(`build.${name}`, performance.now() - started);
    }
  }

  markStartup(label, ms) {
    if (!this.enabled) return;
    this.startup[label] = ms;
    if (!label.startsWith('data.')) this.markMilestone(label);
  }

  markMilestone(label) {
    if (this.enabled) this.startupAt[label] = performance.now();
  }

  // 按场景顶层组归因，未命名对象归入未标记组。批次按首个对象归属，调用按各自对象归属。
  compileEvent(object, event, value = 1) {
    if (!this.enabled) return;
    let root = object;
    while (root.parent && !root.parent.isScene) root = root.parent;
    const key = root.name || 'unlabelled';
    const row = this.compilation[key] ??= { jobs: 0, calls: 0, shared: 0, rejected: 0, callMs: 0 };
    row[event] += value;
  }

  // 固定机位在相机系统更新之后覆盖位置，仍然用同一套玩家输入走路。
  applyCamera(camera) {
    if (!this.camera) return;
    const [x, y, z, tx, ty, tz] = this.camera;
    camera.position.set(x, y, z);
    camera.lookAt(tx, ty, tz);
    camera.updateMatrixWorld();
  }

  // 帧采样：返回 null 表示本帧不计样本；其余方法接受 null 令牌并直接返回 0。
  beginFrame(ready) {
    if (!this.enabled || !ready || document.hidden) return null;
    return { start: performance.now(), simulationEnd: 0, renderStart: 0 };
  }

  markSimulation(token) {
    if (!token) return 0;
    token.simulationEnd = performance.now();
    return token.simulationEnd;
  }

  markRender(token) {
    if (!token) return 0;
    token.renderStart = performance.now();
    return token.renderStart;
  }

  endFrame(token, now, renderer) {
    if (!token) return;
    this.sampleTalent(now, renderer);
    if (this.railOutput && now >= this.nextRailSample) this.sampleRailEvidence(now, renderer);
    if (this.previousFrameAt !== null) {
      this.frames.push({
        at: now, intervalMs: now - this.previousFrameAt, simulationMs: token.simulationEnd - token.start,
        sceneUiMs: token.renderStart - token.simulationEnd, renderCpuMs: performance.now() - token.renderStart,
        drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
        gpuBytes: renderer.info.memory.total
      });
    }
    this.previousFrameAt = now;
    const cutoff = now - 10000;
    while (this.frames[0]?.at < cutoff) this.frames.shift();
    while (this.gpu[0]?.at < cutoff) this.gpu.shift();
    while (this.queue[0]?.at < cutoff) this.queue.shift();
    if (this.cruiseEvidence) this.recordCruiseEvidence(now, renderer);
    this.sampledFrames++;
    if (this.sampledFrames % 30 !== 0) return;
    const device = renderer.backend.device;
    if (device && !this.queuePending) {
      const started = performance.now();
      this.queuePending = true;
      device.queue.onSubmittedWorkDone().then(() => {
        if (!document.hidden) this.queue.push({ at: now, ms: performance.now() - started });
      }).catch(error => console.warn('[profile queue]', error)).finally(() => { this.queuePending = false; });
    }
    if (renderer.backend.trackTimestamp && !this.queryPending) {
      this.queryPending = true;
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(ms => {
        if (Number.isFinite(ms) && !document.hidden) this.gpu.push({ at: now, ms });
      }).catch(error => console.warn('[profile timestamp]', error)).finally(() => { this.queryPending = false; });
    }
  }

  sampleRailEvidence(now, renderer) {
    this.nextRailSample = now + 1000;
    const { modules, controllerManager, cameraSystem, lightingSystem, mapSystem } = this.runtime;
    const player = controllerManager.getActiveEntity();
    const north = modules.northStation?.snapshot();
    if (north) {
      const { log, ...state } = north;
      this.railLog = log;
      this.railCurrent = state;
    }
    const range = this.frames.filter(frame => frame.at > now - 1000);
    const summary = key => {
      const values = range.map(frame => frame[key]).sort((a, b) => a - b);
      return values.length ? [values[Math.floor((values.length - 1) / 2)], values[Math.ceil(values.length * 0.95) - 1], values.at(-1)] : null;
    };
    this.railRows.push({ at: now, simulation: north?.time, trains: north?.trains, queued: north?.queued,
      frameCount: range.length, intervalMs: summary('intervalMs'), drawCalls: summary('drawCalls'), triangles: summary('triangles'),
      camera: cameraSystem.camera.position.toArray(), mode: controllerManager.activeMode, view: cameraSystem.activePresetId,
      player: player.position.toArray(), support: player._support, time: lightingSystem.activePresetId,
      map: mapSystem.isFullMapOpen, focused: document.hasFocus(), memory: { ...renderer.info.memory } });
    if (this.railRows.length > 900) this.railRows.shift();
    this.railOutput.textContent = JSON.stringify({ current: this.railCurrent, log: this.railLog,
      visibility: this.railVisibility, rows: this.railRows, startup: this.startup, errors: this.railErrors });
  }

  installRailEvidence(runtime) {
    this.railOutput = document.createElement('script');
    this.railOutput.id = 'qa-rail-evidence';
    this.railOutput.type = 'application/json';
    this.railRows = [];
    this.railVisibility = [];
    this.railErrors = [];
    this.nextRailSample = 0;
    document.body.append(this.railOutput);
    document.addEventListener('visibilitychange', () => {
      this.railVisibility.push({ at: performance.now(), hidden: document.hidden, time: runtime.modules.northStation?.snapshot().time });
    });
    window.addEventListener('error', event => this.railErrors.push({ at: performance.now(), error: event.message }));
    window.addEventListener('unhandledrejection', event => this.railErrors.push({ at: performance.now(), error: String(event.reason) }));
    if (!this.railRecord || !window.MediaRecorder || !runtime.renderer.domElement.captureStream) return;
    // 本机取证只录 WebGPU 场景画布，按钮本身不进入正式玩法。
    const record = document.createElement('button');
    record.textContent = 'QA record rail';
    Object.assign(record.style, { position: 'fixed', top: '75px', right: '20px', zIndex: 3000 });
    let recorder, stream, chunks;
    record.addEventListener('click', () => {
      if (recorder?.state === 'recording') { recorder.stop(); return; }
      stream = runtime.renderer.domElement.captureStream(16);
      chunks = [];
      recorder = new MediaRecorder(stream, { videoBitsPerSecond: 1700000 });
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => {
        stream.getTracks().forEach(track => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = 'shenzhen-north-rail.webm';
        link.textContent = 'QA save rail video';
        Object.assign(link.style, { position: 'fixed', top: '100px', right: '20px', zIndex: 3000, background: 'white' });
        link.addEventListener('click', () => { setTimeout(() => URL.revokeObjectURL(url), 1000); link.remove(); });
        document.body.append(link);
        record.textContent = 'QA record rail';
      });
      recorder.start(1000);
      record.textContent = 'QA stop rail recording';
    });
    document.body.append(record);
  }

  recordCruiseEvidence(now, renderer) {
    const { cruise, controllerManager, buildingSigns, buildingDetails, lightingSystem, cameraSystem, mapSystem } = this.runtime;
    const { status, route, distance, altitude, entity } = cruise;
    const last = this.cruiseRows.at(-1);
    if (last && last.status === status && last.id === route?.id && now - last.at < 1000) return;
    const range = this.frames.filter(frame => frame.at > now - 1000);
    const stats = key => {
      const values = range.map(frame => frame[key]).sort((a, b) => a - b);
      return values.length && [values[Math.floor((values.length - 1) / 2)], values[Math.ceil(values.length * 0.95) - 1], values.at(-1)];
    };
    const player = controllerManager.getActiveEntity();
    this.cruiseRows.push({
      at: now, id: route?.id, status, distance, altitude, speed: entity?.speed, speedLimit: route?.speedMps,
      position: entity?.position.toArray(), heading: entity?.heading,
      mode: controllerManager.activeMode, player: player.position.toArray(), playerHeading: player.heading,
      playerVisualHeading: player.mesh.rotation.y, playerSpeed: player.speed,
      camera: cameraSystem.camera.position.toArray(), time: lightingSystem.activePresetId, map: mapSystem.isFullMapOpen,
      focused: document.hasFocus(), frameCount: range.length,
      intervalMs: stats('intervalMs'), drawCalls: stats('drawCalls'), triangles: stats('triangles'),
      memory: { ...renderer.info.memory }, heapBytes: performance.memory?.usedJSHeapSize,
      details: buildingDetails.statistics.chunks, pending: buildingDetails.statistics.pending,
      signs: buildingSigns.statistics.textures
    });
    if (this.cruiseRows.length > 3600) this.cruiseRows.shift();
    this.cruiseOutput.textContent = JSON.stringify(this.cruiseRows);
  }

  // 安装 window 入口：只挂快照、调试函数和模块对象，不改变玩法。
  install(runtime) {
    if (!this.enabled || this.runtime) return;
    this.runtime = runtime;
    for (const name of this.skipped) {
      if (!(name in STAGE_STUBS)) console.warn('[qa] unknown skip stage', name);
    }
    const modules = runtime.modules;
    window.__szLamps = modules.lamps;
    window.__szTrees = modules.trees;
    window.__szVegetation = modules.vegetation;
    window.__szApec = modules.apec;
    window.__szApecCity = modules.apecCity;
    window.__szDrones = modules.drones;
    if (modules.drones?.statistics) console.info('[drone routes]', JSON.stringify(modules.drones.statistics));
    window.__szLightShow = modules.lightShow;
    window.__szElevatedRoads = modules.elevatedRoads;
    window.__szRoadStructures = modules.roadStructures;
    window.__szMetroEntrances = modules.metroEntrances;
    window.__szFutian = modules.futian;
    window.__szXili = modules.xili;
    this.installDebug(runtime);
    this.installSnapshot(runtime);
    if (this.railEvidence) this.installRailEvidence(runtime);
    if (this.publishTalent && modules.waterfront) {
      const surface = document.createElement('script');
      surface.type = 'application/json';
      surface.id = 'qa-talent-telemetry';
      document.body.append(surface);
      this.talentSurface = surface;
    }
  }

  // QA 专用传送与碰撞查询：只在本机回环地址的 ?qa=1 下暴露，便于固定机位复测和诊断。
  installDebug({ controllerManager, traffic, colliders, teleport }) {
    window.__szTeleport = (x, z, heading = 0) => controllerManager.teleportActiveTo(x, z, heading, null, { exact: true });
    window.__szCamera = values => { this.camera = values === null ? null : parseCamera(values.join(',')); };
    // QA：列出某点附近的交通碰撞体，用于区分“被 NPC 车辆挡住”与“桥面/坡度问题”。
    window.__szNearTraffic = (x, z, radius = 12) => (traffic.nearColliders(x, z, radius) ?? []).map(item => ({
      x: Math.round(item.x ?? item.minX ?? 0), z: Math.round(item.z ?? item.minZ ?? 0), kind: item.kind ?? item.type ?? 'vehicle'
    }));
    // QA：同一次场景加载可以切换固定机位；null 恢复游戏相机。
    window.__szSetCamera = (camera) => { this.camera = parseCamera(camera); };
    // QA：查询某点的接触候选面（地形/地标/高架），用于诊断载具卡住。
    window.__szSurfaceAt = (x, z) => controllerManager.surfaceResolver.at(x, z);
    // QA：把车辆放到最近的源路网节点（道路中心），用于自动驾驶/连续驾驶验收。
    window.__szTeleportRoad = (x, z, heading = 0) => {
      let best = null, bestDistance = Infinity;
      for (let index = 0; index < GEO.roadGraph.nodes.length; index += 2) {
        const distance = (GEO.roadGraph.nodes[index] - x) ** 2 + (GEO.roadGraph.nodes[index + 1] - z) ** 2;
        if (distance < bestDistance) { bestDistance = distance; best = index; }
      }
      if (best === null) return false;
      return controllerManager.teleportActiveTo(GEO.roadGraph.nodes[best], GEO.roadGraph.nodes[best + 1], heading, null);
    };
    // QA：非精确传送（自动找最近可站立落点），用于把车辆/人物放到道路上做连续走通测试。
    window.__szTeleportNear = (x, z, heading = 0) => controllerManager.teleportActiveTo(x, z, heading, null);
    // QA 诊断：列出某点附近的碰撞体，用于定位“走不过去”的地面入口。
    window.__szNearColliders = (x, z, radius = 40) => colliders.filter(collider =>
      Number.isFinite(collider?.minX) && collider.maxX > x - radius && collider.minX < x + radius
      && collider.maxZ > z - radius && collider.minZ < z + radius)
      .sort((a, b) => Math.hypot((a.minX + a.maxX) / 2 - x, (a.minZ + a.maxZ) / 2 - z)
        - Math.hypot((b.minX + b.maxX) / 2 - x, (b.minZ + b.maxZ) / 2 - z))
      .slice(0, 12).map(collider => ({ type: collider.type, name: collider.name, sourceId: collider.sourceId,
        minY: collider.minY, maxY: collider.maxY,
        minX: Math.round(collider.minX), maxX: Math.round(collider.maxX),
        minZ: Math.round(collider.minZ), maxZ: Math.round(collider.maxZ) }));
    // 只返回快照，验收通过同一套玩家输入完成。
    window.__szDebug = {
      scene: this.runtime.scene, renderer: this.runtime.renderer, camera: this.runtime.cameraSystem.camera,
      signs: this.runtime.buildingSigns, details: this.runtime.buildingDetails,
      controllerManager, teleport, pedestrians: this.runtime.pedestrians, mapSystem: this.runtime.mapSystem
    };
  }

  installSnapshot(runtime) {
    if (this.cruiseEvidence) {
      this.cruiseRows = [];
      this.cruiseOutput = document.createElement('script');
      this.cruiseOutput.id = 'qa-cruise-evidence';
      this.cruiseOutput.type = 'application/json';
      document.body.append(this.cruiseOutput);
      const plans = document.createElement('script');
      plans.id = 'qa-cruise-plans';
      plans.type = 'application/json';
      plans.textContent = JSON.stringify(runtime.cruise.routes.map(route => ({
        id: route.id, unavailable: route.unavailable, duration: route.estimateSeconds, fullDuration: route.full?.estimateSeconds, distance: route.distance,
        length3d: route.length3d, ...route.audit
      })));
      document.body.append(plans);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      this.frames.length = 0;
      this.gpu.length = 0;
      this.queue.length = 0;
      this.previousFrameAt = null;
    });
    Object.defineProperty(window, '__szQA', { value: () => this.snapshot() });
  }

  profileSnapshot() {
    const durationMs = Math.min(10000, this.frames.reduce((sum, frame) => sum + frame.intervalMs, 0));
    const fields = ['intervalMs', 'simulationMs', 'sceneUiMs', 'renderCpuMs', 'drawCalls', 'triangles', 'gpuBytes'];
    return {
      chunkSize: this.chunkSize,
      startupMs: { ...this.startup },
      startupAtMs: { ...this.startupAt },
      compilation: structuredClone(this.compilation),
      surfaceUnpacks: performance.getEntriesByName('sz.surface.unpack', 'measure').map(entry => ({
        at: entry.startTime, ms: entry.duration, ...entry.detail
      })),
      frames: this.frames.length,
      durationMs,
      fps: durationMs ? this.frames.length * 1000 / durationMs : null,
      ...Object.fromEntries(fields.map(key => [key, summarizeSamples(this.frames.map(frame => frame[key]))])),
      gpuRenderMs: summarizeSamples(this.gpu.map(sample => sample.ms)),
      gpuSamples: this.gpu.length,
      gpuQueueWaitMs: summarizeSamples(this.queue.map(sample => sample.ms)),
      gpuQueueSamples: this.queue.length
    };
  }

  talentSnapshot() {
    const { modules, controllerManager } = this.runtime;
    const active = controllerManager.getActiveEntity();
    const program = modules?.talentProgram;
    return program && {
      ...program.statistics, active: program.active, paused: program.paused, time: program.time, cue: program.cue,
      available: program.available, delivery: modules.drones.statistics,
      waterfront: modules.waterfront.statistics, arrival: modules.waterfront.arrival,
      routeDistance: modules.waterfront.route.nearest(active.position.x, active.position.z),
      support: active._support,
      actors: modules.talentPeople.actors.map(({ id, x, y, z, heading, mode, s, v }) => ({ id, x, y, z, heading, mode, s, v }))
    };
  }

  sampleTalent(now, renderer) {
    if (!this.talentSurface || now < this.nextTalentSample) return;
    this.nextTalentSample = now + 160;
    const { controllerManager, cameraSystem, lightingSystem, modules } = this.runtime;
    const active = controllerManager.getActiveEntity();
    this.talentSurface.textContent = JSON.stringify({
      at: now, ...this.talentSnapshot(), lighting: lightingSystem.activePresetId,
      mode: active.type, camera: cameraSystem.activePresetId, cameraPosition: cameraSystem.camera.position.toArray(),
      position: { x: active.position.x, y: active.position.y, z: active.position.z, heading: active.heading, speed: active.speed },
      summit: modules.cbdProgram.active, frame: renderer.info.frame, memory: renderer.info.memory,
      perf: this.profileSnapshot()
    });
  }

  // window.__szQA()：把启动阶段、场景统计、交通/人群/地图状态汇总成纯数据快照。
  snapshot() {
    const { controllerManager, cameraSystem, lightingSystem, mapSystem, traffic, pedestrians, roadFrontage,
      autoDrive, laneAssist, sea, streetscape, streetscapeArrival, landmarks, bridge, publicWalk, cityBlocks, renderer, buildingSigns, buildingDetails,
      audioSystem, cruise, getElapsed, getRenderedFrames, getGraphicsLoss, modules } = this.runtime;
    const elapsed = getElapsed();
    const active = controllerManager.getActiveEntity();
    const program = modules?.cbdProgram;
    return {
      northStation: modules?.northStation?.snapshot(),
      talentShow: this.talentSnapshot(),
      themeParks: modules?.themeParks?.snapshot(),
      summitProgram: program && {
        active: program.active, paused: program.paused, time: program.time, cue: program.cue,
        ...program.statistics, participants: modules.programIds,
        omitted: [...modules.parkOmissions], support: active._support,
        summitSurfaces: modules.summit.surfaces.length
      },
      ready: audioSystem.ready,
      airCruise: cruise && {
        status: cruise.status, id: cruise.route?.id, distance: cruise.distance, altitude: cruise.altitude,
        position: cruise.entity?.position.toArray(), speed: cruise.entity?.speed,
        routes: cruise.routes.map(route => ({ id: route.id, unavailable: route.unavailable, distance: route.distance,
          duration: route.duration, length3d: route.length3d, ...route.audit }))
      },
      mode: controllerManager.activeMode,
      entities: Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading, speed: entity.speed,
        surfaceId: entity._support?.surfaceId ?? null
      }])),
      camera: { id: cameraSystem.activePresetId, position: cameraSystem.camera.position.toArray() },
      time: lightingSystem.activePresetId,
      map: { open: mapSystem.isFullMapOpen, search: mapSystem.searchHighlight,
        waypoint: mapSystem.waypoint && { ...mapSystem.waypoint }, metro: [...mapSystem.metroLines],
        view: { x: mapSystem.viewCenterX, z: mapSystem.viewCenterZ, zoom: mapSystem.viewZoom } },
      traffic: { ...traffic.statistics, actors: traffic.vehicles.filter(actor => actor.route).map(actor => {
        const stop = actor.stops[actor.stopIndex];
        return { id: actor.id, x: actor.pose.x, y: actor.pose.y, z: actor.pose.z, heading: actor.pose.heading,
          wayId: actor.pose.edge?.osmId, surfaceId: actor.pose.edge?.surfaceId ?? null, speed: actor.speed,
          s: actor.s, end: actor.end, stalled: actor.stalled,
          wait: actor.waitingForSignal, blocker: actor.blocker ?? null, reservation: actor.reservation?.id ?? null,
          stop: stop ? { s: stop.s, clearS: stop.clearS, osmNodeId: stop.approach.osmNodeId, group: stop.approach.group } : null };
      }) },
      pedestrians: { ...pedestrians.statistics },
      assists: laneAssist && { lane: laneAssist.status, changing: laneAssist.active, enabled: laneAssist.enabled,
        cruiseSpeed: controllerManager.cruiseSpeed },
      publicWalk: publicWalk && { ...publicWalk.statistics, actors: (pedestrians.peds ?? [])
        .filter(actor => actor.leg?.kind === 'public-walk')
        .map(({ id, x, y, z, s, dir, v }) => ({ id, x, y, z, s, dir, v })) },
      retail: cityBlocks && { buildings: cityBlocks.retailBuildingIds.size, doors: cityBlocks.retailDoors
        .filter(door => door.buildingId === publicWalk?.entrance?.buildingId
          && Math.hypot(door.x - publicWalk.entrance.x, door.z - publicWalk.entrance.z) < 15) },
      roadFrontage: { ...roadFrontage.statistics, intersections: roadFrontage.control.intersections.map(intersection => ({
        id: intersection.id, approaches: intersection.approaches.map(({ osmNodeId, group, stopX, stopZ }) => ({ osmNodeId, group, stopX, stopZ }))
      })), clock: elapsed, control: roadFrontage.control.snapshot?.(elapsed) ?? [],
        crossSections: GEO.roadGraph.metadata.flatMap(({ crossSection, osmId }, i) => crossSection
          ? [{ id: crossSection.id, osmId, widthM: GEO.roadGraph.links[i][3], lanes: GEO.roadGraph.links[i][4], stations: crossSection.points.length / 3 }] : []) },
      autoDrive: { status: autoDrive.status, ...autoDrive.statistics,
        route: mapSystem.driveRoute && { from: [mapSystem.driveRoute.from.x, mapSystem.driveRoute.from.z],
          to: [mapSystem.driveRoute.to.x, mapSystem.driveRoute.to.z], length: mapSystem.driveRoute.length,
          wayIds: [...new Set(mapSystem.driveRoute.edges.map(edge => edge.osmId))],
          stops: mapSystem.driveRoute.stops.map(stop => stop.approach.osmNodeId) } },
      sea: sea && { heightM: sea.heightM, triangles: sea.triangles, verticalDatum: sea.mesh.userData.source.verticalDatum },
      streetscape: streetscape.statistics && { ...streetscape.statistics, arrival: streetscapeArrival,
        activePaths: streetscape.pathAt(controllerManager.getActiveEntity().position.x, controllerManager.getActiveEntity().position.z) },
      landmarks: {
        models: landmarks.group.children.map(group => group.name),
        replaced: landmarks.skipIds.size,
        collisionParts: landmarks.colliders.length,
        roofSurfaces: landmarks.surfaces.map(surface => surface.id),
        distant: bridge.group ? [{ id: bridge.group.name, ...bridge.statistics, playable: false }] : []
      },
      profile: this.profileSnapshot(),
      details: {
        chunks: buildingDetails.statistics.chunks, meshes: buildingDetails.statistics.meshes,
        triangles: buildingDetails.statistics.triangles, buildings: buildingDetails.statistics.buildings,
        balconies: buildingDetails.statistics.balconies, acUnits: buildingDetails.statistics.acUnits,
        roofParts: buildingDetails.statistics.roofParts, pending: buildingDetails.statistics.pending,
        updateMs: buildingDetails.statistics.updateMs
      },
      signs: {
        signs: buildingSigns.statistics.signs, textures: buildingSigns.statistics.textures,
        chunks: buildingSigns.statistics.chunks, compounds: buildingSigns.statistics.compounds,
        compoundClusters: buildingSigns.statistics.compoundClusters,
        updateMs: buildingSigns.statistics.updateMs
      },
      renderer: { backend: renderer.backend.constructor.name, initialized: renderer.initialized,
        animationRegistered: Boolean(renderer.getAnimationLoop()), frame: renderer.info.frame, renderedFrames: getRenderedFrames(),
        deviceLost: getGraphicsLoss() && { ...getGraphicsLoss() }, render: { ...renderer.info.render }, memory: { ...renderer.info.memory } }
    };
  }
}
