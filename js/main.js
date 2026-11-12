import { STR } from './sz-strings.js';
import { waitForFirstFrame } from './sz-startup.js';
import { populateTeleportMenu, wireMetroMenu, wirePopovers, wireShortcuts, wireDrivingAssists, createLocationReadout, createHudTelemetry } from './sz-ui.js';
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { GEO, REAL_BUILDINGS, DATA_TIMINGS } from './sz-geodata.js';
import { getLocationLabel, inBounds, isWater, findGroundArrival, LANDMARK_SITES, TELEPORT_LOCATIONS } from './sz-city-config.js';
import { buildSzGround } from './sz-ground.js';
import { buildSzSea } from './sz-sea.js';
import { buildSzRoads, planStreetTreeSides } from './sz-roads.js';
import { buildSzRoadFrontage } from './sz-road-frontage.js';
import { buildSzRoadPaint } from './sz-road-paint.js';
import { createRoadBuildingClearance } from './sz-road-building-clearance.js';
import { createSurfaceResolver } from './sz-controller-surfaces.js';
import { buildSzStreetscape } from './sz-streetscape.js';
import { buildSzStreetLamps } from './sz-street-lamps.js';
import { buildSzTrees } from './sz-trees.js';
import { buildApecTheme } from './sz-apec.js';
import { buildApecCityElements } from './sz-apec-city.js';
import { buildSzDroneRoutes } from './sz-drone-routes.js';
import { buildSzLightShow, planLandmarkBands } from './sz-light-show.js';
import { gatePoint, gateYaw, gateDeckY, flowerSeaAnchor, flowerSeaDeckY } from './sz-landmarks/iec-xiangmihu.js';
import { buildSzMetroEntrances } from './sz-metro-entrances.js';
import { buildFutianStation, buildXiliConstruction } from './sz-station-sites.js';
import { buildSzLandmarks } from './sz-landmarks/index.js';
import { buildShenzhenBayBridge, buildYanjiangExpressway } from './sz-landmarks/shenzhen-bay-bridge.js';
import { buildSzElevatedRoads } from './sz-elevated-roads.js';
import { planSzTunnels } from './sz-tunnels.js';
import { BUILDING_RENDER_CHUNK_SIZE, buildCityBlocks } from './sz-buildings.js';
import { buildBuildingSigns } from './sz-building-signs.js';
import { buildBuildingDetails } from './sz-building-details.js';
import { createSzTraffic, trafficModelBounds } from './sz-traffic.js';
import { createSzPedestrians } from './sz-pedestrians.js';
import { createDrivePlanner, createTurnFilter } from './sz-drive-route.js';
import { createAutoDrive } from './sz-auto-drive.js';
import { createLaneAssist } from './sz-lane-assist.js';
import { VEHICLE_SPECS } from './sz-vehicles.js';
import { sceneUniforms } from './sz-materials.js';
import { ThirdPersonControllerManager, FLIGHT_START_ALTITUDE, PLAYER_SPEED_LIMITS } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { SZMapSystem } from './sz-map.js';
import { parkAt } from './sz-park-arrivals.js';
import { setupSceneCulling, updateSceneCulling } from './scene-culling.js';
import { CityAudioSystem } from './audio-system.js';
import { createQaSession } from './sz-qa.js';

const PLAYER_STATE_KEY = 'sz-player-state';

// 城市包各阶段耗时来自 js/sz-geodata.js 的 DATA_TIMINGS；缺失或非有限值按 0 处理，不把未知写成实测。
function dataStageMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingFill = document.getElementById('loading-progress');
  let graphicsLoss = null;
  let renderedFrames = 0;
  let elapsed = 0;
  // QA 调试入口只在回环地址的 ?qa=1 下安装；固定机位、?skip= 阶段开关和帧采样都在 js/sz-qa.js。
  const qa = createQaSession({ search: location.search, hostname: location.hostname, defaultChunkSize: BUILDING_RENDER_CHUNK_SIZE });

  // One progress bar for the whole start-up. Each stage fills a share of it sized after its typical duration (the
  // "[init]" timings logged below, on an M1 MacBook Air. The fill glides through a stage as a compositor transition,
  // so it keeps moving while the stage's synchronous work blocks the main thread.
  const STAGE_MS = {
    data: 1800, renderer: 50, lighting: 60, ground: 900, roads: 1500, landmarks: 300, blocks: 2100,
    traffic: 300, controllers: 50, culling: 730, ui: 50, postFX: 60,
    compile: 3900, warmup: 1950, gpu: 300
  };
  const stageNames = Object.keys(STAGE_MS);
  const totalStageMs = stageNames.reduce((sum, name) => sum + STAGE_MS[name], 0);
  const loadingStartedAt = performance.now();
  let loadingStage = { from: 0, to: STAGE_MS.data / totalStageMs };

  const setLoadingProgress = (p, seconds = 0.3) => {
    if (!loadingFill) return;
    loadingFill.style.animation = 'none';
    loadingFill.style.transition = `transform ${seconds}s ${seconds > 0.3 ? 'linear' : 'ease'}`;
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };
  // Progress through the current stage, for stages that can measure it
  const setStageProgress = (f) => setLoadingProgress(loadingStage.from + (loadingStage.to - loadingStage.from) * f);

  function beginLoadingStage(message, name, glide = true) {
    if (loadingStatus) loadingStatus.textContent = message;
    const index = stageNames.indexOf(name);
    const before = stageNames.slice(0, index).reduce((sum, n) => sum + STAGE_MS[n], 0);
    loadingStage = { from: before / totalStageMs, to: (before + STAGE_MS[name]) / totalStageMs };
    if (!glide) return setLoadingProgress(loadingStage.from);
    const ranMs = before - STAGE_MS.data;
    const pace = ranMs >= 1000 ? Math.min(4, Math.max(0.5, (performance.now() - loadingStartedAt) / ranMs)) : 1;
    setLoadingProgress(loadingStage.to, (STAGE_MS[name] * pace) / 1000);
  }

  async function showLoadingStage(message, name, glide) {
    beginLoadingStage(message, name, glide);
    if (document.hidden) return;
    // Let the label paint before synchronous work. The timeout also lets hidden tabs keep loading.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        setTimeout(resolve, 0);
      });
    });
  }

  await showLoadingStage(STR.startup.renderer, 'renderer');

  // 1. Initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer.
  // Firefox WebGL2 incurs a heavy renderbufferStorageMultisample + blitFramebuffer stall
  // on multisampled floating-point MRT post-processing render targets, so disable MSAA on Firefox.
  const isFirefox = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
  const renderer = new THREE.WebGPURenderer({
    antialias: !isFirefox,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true,
    trackTimestamp: qa.enabled
  });
  const onDeviceLost = renderer.onDeviceLost.bind(renderer);
  renderer.onDeviceLost = ({ api, reason, message, ...details }) => {
    onDeviceLost({ api, reason, message, ...details });
    graphicsLoss = { api, reason, message };
    const boot = globalThis.__szBoot;
    if (boot?.fail) {
      boot.fail('deviceLost', new Error(message || reason || 'Graphics device lost'));
    } else {
      loadingOverlay?.classList.remove('hidden');
      if (loadingStatus) loadingStatus.textContent = STR.startup.deviceLost;
    }
  };
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable.
  // 城市包在主模块求值之前就加载完了，这里把它的下载/解压/解析/校验/解码补到行首，各阶段才能分开看。
  const DATA_STAGE_LABELS = {
    downloadMs: 'data.download', decompressMs: 'data.decompress', parseMs: 'data.parse',
    validateMs: 'data.validate', decodeMs: 'data.decode'
  };
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    const ms = Math.round(now - initMark);
    initTimings.push(`${label} ${ms}ms`);
    qa.markStartup(label, ms);
    initMark = now;
  };
  for (const [field, label] of Object.entries(DATA_STAGE_LABELS)) {
    const ms = dataStageMs(DATA_TIMINGS[field]);
    initTimings.push(`${label} ${ms}ms`);
    qa.markStartup(label, ms);
  }

  await renderer.init();
  markInit('renderer');

  // 2. Scene, atmosphere and lighting
  await showLoadingStage(STR.startup.lighting, 'lighting');
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  markInit('lighting');

  await showLoadingStage(STR.startup.ground, 'ground');
  const ground = buildSzGround(scene, GEO.terrainSurface);
  const sea = buildSzSea(scene, GEO.seaSurface);
  markInit('ground');
  await showLoadingStage(STR.startup.roads, 'roads');
  const roads = buildSzRoads(scene, GEO.roadGraph, GEO.terrainSurface);
  // 场地上下文：地形、路面、路网和各构建函数共用的接触面参数只构造一份，入口里不再重复传同一组闭包。
  const site = {
    buildings: REAL_BUILDINGS, terrain: GEO.terrain, terrainSurface: GEO.terrainSurface, sites: GEO.sites,
    roadGraph: GEO.roadGraph, groundHeight: ground.groundHeight, roadHeight: roads.roadHeight, isWater,
    colliders: []
  };
  // 车公庙立交高架/匝道：sz-roads 只画地面道路，这里补高架桥面和可站立表面（层高估计）。
  const elevatedRoads = qa.stage('elevated', () =>
    buildSzElevatedRoads(scene, { graph: site.roadGraph, terrainSurface: site.terrainSurface }));
  // 隧道只做来源审计和待核清单：洞底在地面三角面之下且没有洞口来源，挂进场景会“看得见开不进去”。
  site.tunnelReview = planSzTunnels(site.roadGraph, site.terrainSurface, { interchanges: elevatedRoads.interchanges, buildings: site.buildings }).reviewList;
  const roadFrontage = buildSzRoadFrontage(scene, GEO.roadFrontage, GEO.roadGraph, GEO.terrainSurface, site);
  const roadPaint = qa.stage('paint', () =>
    buildSzRoadPaint(scene, GEO.roadGraph, { ...site, intersections: roadFrontage.control.intersections,
      frontage: GEO.roadFrontage, decks: elevatedRoads.links }));
  // 路缘接触和绘制共用同一份三角面，未覆盖的位置沿用源地形。
  site.heightAt = (x, z) => roadFrontage.contactHeight(x, z) ?? ground.groundHeight(x, z);
  site.shennanMedianHeight = roadFrontage.shennanMedianHeight;
  markInit('roads');
  await showLoadingStage(STR.startup.landmarks, 'landmarks');
  const landmarks = qa.stage('landmarks', () => buildSzLandmarks(scene, site));
  const bridge = buildShenzhenBayBridge(scene, GEO.bridges.find(item => item.id === 'shenzhen-bay-bridge'));
  const yanjiang = buildYanjiangExpressway(scene, GEO.yanjiangExpressway);
  markInit('landmarks');
  await showLoadingStage(STR.startup.blocks, 'blocks');
  const cityBlocks = qa.stage('blocks', () =>
    buildCityBlocks(scene, { skipIds: landmarks.skipIds, renderChunkSize: qa.chunkSize,
      roadClearance: createRoadBuildingClearance(site.roadGraph, site.roadHeight, elevatedRoads.links) }));
  const detailSkipIds = new Set([...landmarks.skipIds, ...(cityBlocks.roadConflicts ?? []).map(row => row.buildingId)]);
  // 福田中心区夜景灯光秀：只给已建成普通高层加灯带，颜色/节奏为展示估计；白天隐藏。
  // 地标源对象已由专模打光，排除它们；地标外露钢架（平安 8 根巨柱）单独沿柱轴生成灯带。
  const landmarkBands = planLandmarkBands(landmarks.colliders);
  const lightShow = qa.stage('lightshow', () =>
    buildSzLightShow(scene, { buildings: site.buildings, terrain: site.terrain,
      excludeIds: detailSkipIds, landmarkBands }));
  const buildingSigns = qa.stage('signs', () =>
    buildBuildingSigns(scene, { buildings: cityBlocks.allBlocks, roadGraph: site.roadGraph }));
  // 近景补足屋顶和立面细节，避开基础屋顶已绘制的构件。
  const buildingDetails = qa.stage('details', () =>
    buildBuildingDetails(scene, { ...site, skipIds: detailSkipIds, roofPlans: cityBlocks.roofPlans }));
  markInit('blocks');
  const buildings = [...landmarks.colliders, ...cityBlocks.colliders];
  site.colliders = buildings;
  const streetscape = qa.stage('streetscape', () => buildSzStreetscape(scene, GEO.streetscape, site.terrainSurface, site));
  site.pathAt = streetscape.pathAt;
  const minorRoadBounds = (GEO.roadFrontage?.corridors ?? []).filter(row => row.id.startsWith('shennan-'))
    .map(row => row.bounds);
  // 灯位从实际道路断面派生，已核实的中央分隔带参与选位。
  const streetLamps = qa.stage('lamps', () => {
    const deck = createSurfaceResolver({ groundHeight: () => null, surfaces: elevatedRoads.surfaces });
    return buildSzStreetLamps(scene, site.roadGraph, {
      ...site, medianHeight: roadFrontage.medianHeight,
      deckOccupied: (x, z, bottom, top) =>
        deck.at(x, z).some(surface => surface.height + 4.5 > bottom && surface.height - 0.35 < top)
    });
  });
  // 树木：OSM 来源点加带标注的模拟行道树/公园树，接触面与铺装/建筑冲突在运行时复核。
  const trees = qa.stage('trees', () => buildSzTrees(scene, GEO.trees, {
    ...site, roadFrontage: GEO.roadFrontage, streetTreeSideAllowed: planStreetTreeSides(site.roadGraph, minorRoadBounds)
  }));
  // 国际交流中心模型给出的真实门廊/花海台面锚点只构造一次，APEC 主题和城市元素共用。
  const anchors = {
    iecGate: { x: gatePoint.x, z: gatePoint.z, yaw: gateYaw, baseY: gateDeckY },
    iecFlowerSea: { x: flowerSeaAnchor.x, z: flowerSeaAnchor.z, baseY: flowerSeaDeckY }
  };
  // APEC 周城市元素：会期内默认打开，模块内所有几何都在主题开关下。
  const apecTheme = qa.stage('apec', () =>
    buildApecTheme(scene, { ...site, lampSites: streetLamps.sites, lampChunkVisible: streetLamps.chunkVisible,
      landmarks: GEO.landmarks, area: GEO.bounds, anchors }));
  // APEC 城市元素：路侧 LED 大屏、会场巡逻机器人、西丽站围挡公益广告，随主题开关显隐。
  const apecCity = qa.stage('apecCity', () =>
    buildApecCityElements(scene, { ...site, landmarks: GEO.landmarks, anchors }));
  // 地铁出入口：点位来自 OSM 已核实节点；雨棚/站名牌是外观参数，吸附到实际渲染地面。
  // 1000 m 分块：286 个出入口的分块数约减半，draw call 明显下降，剔除粒度仍够用。
  const metroEntrances = qa.stage('metro', () =>
    buildSzMetroEntrances(scene, GEO.metro, { ...site, chunkSizeM: 1000 }));
  // 福田站只建地面出入口/采光天窗；西丽站只做在建工地围挡/塔吊/基坑，不造站房。
  const stations = qa.stage('stations', () => ({
    futian: GEO.sites?.['futian-station']?.station
      ? buildFutianStation(scene, GEO.sites['futian-station'].station, site) : null,
    xili: GEO.sites?.['xili-station']?.site
      ? buildXiliConstruction(scene, GEO.sites['xili-station'].site, site) : null
  }));
  const futianStation = stations?.futian ?? null;
  const xiliConstruction = stations?.xili ?? null;
  // 无人机航线：端点来自 air 段公开来源；航迹示意，会期低空管控时停在站点。
  const drones = qa.stage('drones', () => buildSzDroneRoutes(scene, { air: GEO.air, terrain: site.terrain }));
  const colliders = [...buildings, ...streetscape.colliders, ...roadFrontage.colliders, ...(streetLamps.colliders ?? []), ...trees.colliders,
    ...metroEntrances.colliders, ...(futianStation?.colliders ?? []), ...(xiliConstruction?.colliders ?? []),
    ...elevatedRoads.colliders];
  site.colliders = colliders;
  await showLoadingStage(STR.startup.traffic, 'traffic');
  const traffic = qa.stage('traffic', () => createSzTraffic(scene, GEO.roadGraph, {
    ...site,
    // 车公庙高架车行链路：桥面顶面三角面来自 elevatedRoads，车流、自动规划和轮胎接触共用同一表面身份。
    elevated: elevatedRoads.drive,
    signals: roadFrontage.control, detailedRoadIds: roadFrontage.detailedRoadIds,
    canTurn: createTurnFilter(GEO.roadGraph)
  }));
  markInit('traffic');

  // 路缘接触和绘制共用同一份三角面，未覆盖的位置沿用源地形。
  await showLoadingStage(STR.startup.controllers, 'controllers');
  const controllerManager = new ThirdPersonControllerManager(scene, colliders, {
    groundHeight: site.heightAt,
    roadHeight: roads.roadHeight,
    surfaces: [...landmarks.surfaces, ...elevatedRoads.surfaces],
    nearTraffic: traffic.nearColliders
  });
  let initialTime = 'golden';
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_STATE_KEY));
    if ((saved?.version === 1 || saved?.version === 2) && Object.hasOwn(controllerManager.entities, saved.activeMode)) {
      if (Object.hasOwn(STR.timeNames, saved.time)) initialTime = saved.time;
      const mode = saved.activeMode;
      const p = saved.version === 2 ? saved.position : saved.entities?.[mode];
      if (p && [p.x, p.y, p.z, p.heading].every(Number.isFinite)) {
        const reference = saved.version === 1 && mode === 'helicopter' ? { ...p, y: Math.max(FLIGHT_START_ALTITUDE, p.y) } : p;
        const position = controllerManager.findModePosition(mode, { type: mode, position: reference, heading: p.heading });
        if (position) controllerManager.setMode(mode, position);
      }
    }
  } catch { /* 无存档或浏览器存储不可用时使用默认出生点。 */ }
  // 首帧预热已恢复位置附近的道路索引、名牌和细节。
  const loadingFocus = controllerManager.getActiveEntity().position;
  buildingSigns.update(loadingFocus);
  for (let i = 0; i < 24; i++) buildingSigns.update(loadingFocus);
  buildingDetails.update(loadingFocus);
  for (let i = 0; i < 40 && buildingDetails.statistics.pending > 0; i++) buildingDetails.update(loadingFocus);
  // 环境人群复用纽约 PersonRig；行走位置是沿路侧模拟步行带，非全城实测人行道。
  const pedestrians = qa.stage('pedestrians', () => createSzPedestrians(scene, GEO.roadGraph, {
    ...site,
    // 公园/绿地内的目标人数明显调稀；密度是建筑覆盖率 + 道路等级 + 绿地的模拟代理。
    greenAreas: [...GEO.green, ...GEO.parks.flatMap(park => park.areas.map(area => area.polygon))],
    // 出生环下探到 8 m、上收 160 m，让玩家身边和眼前街区都有人；视锥保护仍会挡掉镜头内突然出现的人。
    spawnMinM: 8,
    spawnMaxM: 160
  }));
  roadFrontage.update(0);
  traffic.update(0, loadingFocus, [controllerManager.getActiveEntity()], 0);
  pedestrians.update(0, controllerManager.getActiveEntity().position, 0, null, [controllerManager.getActiveEntity()]);
  const driveCar = controllerManager.entities.car;
  const driveModel = trafficModelBounds(driveCar.collisionBounds, VEHICLE_SPECS.taxi);
  // 自动驾驶与地图规划使用交通模块的组合高度：地面沥青 + 高架桥面（按边表面身份取样）。
  const driveOptions = { model: driveModel, roadHeight: traffic.roadHeight, control: roadFrontage.control };
  const nearPedestrians = (x, z, radius) => pedestrians.nearColliders?.(x, z, radius) ?? [];
  const nearRoadUsers = (x, z, radius) => [...traffic.nearColliders(x, z, radius), ...nearPedestrians(x, z, radius)];
  controllerManager.nearPedestrians = nearPedestrians;
  const autoDrive = createAutoDrive({ ...driveOptions, nearTraffic: nearRoadUsers });
  const laneAssist = createLaneAssist({ ...driveOptions, graph: GEO.roadGraph, network: traffic.network,
    isClear: pose => controllerManager.isClearCarPose(pose), nearTraffic: nearRoadUsers });
  let planner = null;
  const drivePlanner = () => planner ??= createDrivePlanner(traffic.network, GEO.roadGraph, { ...driveOptions,
    isClear: pose => controllerManager.isClearCarPose(pose), detailedRoadIds: roadFrontage.detailedRoadIds });

  function savePlayerState() {
    try {
      const { position, heading } = controllerManager.getActiveEntity();
      localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
        version: 2, activeMode: controllerManager.activeMode, time: lightingSystem.activePresetId,
        position: { x: position.x, y: position.y, z: position.z, heading }
      }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  const trafficFrustum = new THREE.Frustum();
  const trafficViewProjection = new THREE.Matrix4();
  const trafficBounds = new THREE.Box3();
  function isTrafficVisible(body) {
    if (!cameraSystem.initialized) return true;
    trafficBounds.min.set(body.minX, body.minY, body.minZ);
    trafficBounds.max.set(body.maxX, body.maxY, body.maxZ);
    return trafficFrustum.intersectsBox(trafficBounds);
  }
  // 人群只需要在地面附近判断可见性；给一个约 4 m 高的包围盒，避免把正后方的人也算进骨骼解算。
  function isPedVisible(x, z, radius, y) {
    if (!cameraSystem.initialized) return true;
    trafficBounds.min.set(x - radius, y - 2.5, z - radius);
    trafficBounds.max.set(x + radius, y + 4, z + radius);
    return trafficFrustum.intersectsBox(trafficBounds);
  }
  const touchControls = new TouchControls(controllerManager, STR.touchActions);
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager }, {
    onStateChange: updateSoundButton,
    storageKey: 'sz-sound'
  });
  function updateSoundButton() {
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', audioSystem.enabled ? STR.ui.muteSound : STR.ui.enableSound);
    soundButton.title = audioSystem.supported
      ? STR.shortcut(audioSystem.enabled ? STR.ui.muteSound : STR.ui.enableSound, 'N')
      : STR.ui.soundUnavailable;
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
  markInit('controllers');

  await showLoadingStage(STR.startup.culling, 'culling');
  const cullingRoots = [ground.group, roads.group, elevatedRoads.group, roadPaint.group, cityBlocks.group];
  for (const root of cullingRoots) {
    const [first, ...chunks] = root.children;
    // 每类静态分块共用材质和顶点布局，预编译其中一块即可。
    for (const chunk of chunks) chunk.userData.sharesPipelineWith = first;
  }
  setupSceneCulling(scene, [...cullingRoots, landmarks.group, bridge.group, yanjiang, streetscape.group, roadFrontage.group, roadPaint.group, streetLamps.group, trees.group, apecTheme.group, metroEntrances.group,
    futianStation?.group, xiliConstruction?.group].filter(Boolean), lightingSystem.sunLight.shadow);

  const dynamicRoots = [
    traffic.group,
    pedestrians.group,
    ...Object.values(controllerManager.entities).map(entity => entity.mesh),
    controllerManager.entities.cyclist.helmet
  ].filter(Boolean);
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;
  markInit('culling');

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  await showLoadingStage(STR.startup.ui, 'ui');
  const scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassNormal = scenePass.getTextureNode('normal');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');

  const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera: cameraSystem.camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.50;
  ssrPass.screenEdgeFadeBlack = true;

  // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const reflections = ssrPass.mul(reflectionMask);
  const colorGrade = createPostProcessing(renderer, scenePassColor, reflections);
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const scenicAvailability = { bayBridge: Boolean(bridge.group), yanjiang: Boolean(yanjiang) };
  const cameraPresets = CAMERA_PRESETS.filter(preset => scenicAvailability[preset.id] !== false);
  for (const [id, available] of Object.entries(scenicAvailability)) {
    document.getElementById(`cam-${id}`)?.toggleAttribute('hidden', !available);
  }
  const timeButtons = document.querySelectorAll('[data-time]');
  const bayPark = LANDMARK_SITES['shenzhen-bay-park'];
  const bayParkSource = GEO.parks.find(park => park.id === bayPark?.id);
  const bayParkRoad = bayPark && findGroundArrival(bayPark, 'car', { radius: 800 });
  const parkArrivals = {
    person: bayParkSource?.areas.some(area => area.arrivals.length) && { ...bayPark, ...streetscape.arrival, park: bayParkSource,
      detail: streetscape.arrival ? STR.teleport.parkPath : STR.teleport.parkWalk },
    car: bayParkRoad && { ...bayParkRoad, detail: STR.teleport.nearParkRoad(getLocationLabel(bayParkRoad.x, bayParkRoad.z), bayParkRoad.distance) },
    helicopter: bayPark && { ...bayPark, detail: STR.teleport.parkFlight }
  };
  const teleportEntries = bayPark ? { ...TELEPORT_LOCATIONS, [bayPark.id]: bayPark } : TELEPORT_LOCATIONS;
  const teleportButtons = populateTeleportMenu(teleportEntries, getLocationLabel);
  const parkButton = teleportButtons.find(button => button.dataset.teleport === bayPark?.id);
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter'];
      selectMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
    onCloseMap: () => mapSystem.toggleFullMap(false)
  });

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const items = (STR.controlHints[mode] || []).map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  // The taxi-yellow pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  const modeFeedback = document.getElementById('mode-feedback');
  let modeFeedbackTimer;
  function selectMode(mode, destination = null) {
    const changed = mode !== controllerManager.activeMode;
    clearTimeout(modeFeedbackTimer);
    if (!controllerManager.setMode(mode, destination)) {
      modeFeedback.textContent = STR.modeUnavailable;
      modeFeedback.hidden = false;
      modeFeedbackTimer = setTimeout(() => { modeFeedback.hidden = true; }, 2600);
      return false;
    }
    modeFeedback.hidden = true;
    if (changed) {
      autoDrive.stop('manual');
      laneAssist.cancel();
      cameraSystem.resetForTeleport();
      selectCamera('chase');
    }
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);
    if (parkButton) {
      const entry = parkArrivals[mode];
      const detail = entry?.detail ?? STR.teleport.parkUnavailable[mode];
      parkButton.disabled = !entry;
      parkButton.querySelector('.pop-sub').textContent = detail;
      parkButton.setAttribute('aria-label', STR.teleport.entryLabel(bayPark.name, detail));
    }

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
    return true;
  }

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = cameraPresets.length;
    const idx = cameraPresets.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(cameraPresets[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
  }

  // APEC 主题开关：会期内默认打开；玩家手动切换后在本机记住选择。
  const apecButton = document.getElementById('btn-apec');
  const APEC_STATE_KEY = 'sz-apec-enabled';
  function setApecTheme(enabled, { persist = true } = {}) {
    const active = apecTheme.setEnabled(enabled);
    apecCity.group.visible = active;
    sceneUniforms.apec.value = active ? 1 : 0;
    if (apecButton) {
      apecButton.classList.toggle('active', active);
      apecButton.setAttribute('aria-pressed', String(active));
    }
    if (persist) {
      try { localStorage.setItem(APEC_STATE_KEY, active ? '1' : '0'); } catch { /* 存储不可用不影响主题 */ }
    }
    return active;
  }
  apecButton?.addEventListener('click', () => setApecTheme(!apecTheme.enabled));
  let savedApec = null;
  try { savedApec = localStorage.getItem(APEC_STATE_KEY); } catch { /* ignore */ }
  setApecTheme(savedApec === null ? apecTheme.enabled : savedApec === '1', { persist: false });

  const closePopovers = wirePopovers();
  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectMode(btn.getAttribute('data-mode'));
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  const renderLocation = createLocationReadout({
    el: elLocation, nearestBuildingName: (x, z) => buildingSigns.nearestName(x, z)
  });
  const hud = createHudTelemetry({
    els: { fps: elFps, speed: elSpeed, speedMeter: elSpeedMeter, altitude: elAltitude },
    controllerManager, cameraSystem, topSpeed: PLAYER_SPEED_LIMITS, renderLocation
  });
  function teleportTo(x, z, heading, options = {}) {
    if (!inBounds(x, z)) return null;
    const park = options.park ?? (controllerManager.activeMode === 'person' ? parkAt(GEO.parks, x, z) : null);
    const destination = controllerManager.teleportActiveTo(x, z, heading, null, { requireArrival: true, park });
    if (!destination) return null;
    laneAssist.cancel();
    autoDrive.stop('manual');
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    const name = getLocationLabel(destination.x, destination.z);
    const area = park?.areas.find(item => item.osmId === destination.parkAreaId);
    mapSystem.waypoint = {
      x: destination.x,
      z: destination.z,
      name: area?.name ?? name
    };
    return destination;
  }

  function goToDriveStart(route) {
    if (!route || autoDrive.active) return false;
    const { x, z, dx, dz } = route.from;
    const heading = Math.atan2(dx, dz);
    const destination = controllerManager.findTeleportPosition(x, z, heading, 0, true, null, { exact: true, mode: 'car' });
    if (!destination || !selectMode('car', destination)) return false;
    controllerManager.resetInput();
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    return true;
  }

  const mapSystem = new SZMapSystem({
    controllerManager,
    cameraSystem,
    touchHints: touchControls.available,
    onToggle: (open) => {
      closePopovers();
      laneAssist.cancel();
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
    },
    onTeleport: teleportTo,
    drive: {
      snap: (x, z) => drivePlanner().snap(x, z),
      route: (start, end) => drivePlanner().route(start, end),
      goToStart: goToDriveStart,
      canStart: route => autoDrive.canStart(route, driveCar, controllerManager.activeMode),
      start: route => autoDrive.start(route, driveCar, controllerManager.activeMode),
      stop: autoDrive.stop,
      get active() { return autoDrive.active; },
      get status() { return autoDrive.status; }
    }
  });
  wireMetroMenu(mapSystem, GEO.metro?.lines ?? []);

  const teleportFeedback = document.getElementById('teleport-feedback');
  teleportButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.teleport;
      const loc = key === bayPark?.id ? parkArrivals[controllerManager.activeMode] : TELEPORT_LOCATIONS[key];
      const arrived = loc && teleportTo(loc.x, loc.z, loc.heading, loc);
      if (teleportFeedback) {
        teleportFeedback.textContent = arrived ? '' : STR.map.noArrival;
        teleportFeedback.hidden = Boolean(arrived);
      }
      if (arrived) closePopovers();
    });
  });

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? STR.ui.showHud : STR.ui.hideHud);
      hudToggleBtn.title = STR.shortcut(isMin ? STR.ui.showHud : STR.ui.hideHud, 'H');
      if (isMin) closePopovers();
    });
  }

  const manualCarAvailable = () => controllerManager.activeMode === 'car' && !mapSystem.isFullMapOpen && !autoDrive.active;
  function requestLane(direction) {
    if (!manualCarAvailable()) return;
    const { forward, backward, left, right, brake, boost } = controllerManager.keys;
    laneAssist.request(driveCar, direction, Boolean(forward || backward || left || right || brake || boost));
    drivingAssists.render(true, true);
  }

  const drivingAssists = wireDrivingAssists(controllerManager, laneAssist);
  // 模式 1–4、相机 V 与 5–0、HUD H、声音 N、喇叭 B 的全局快捷键由 js/sz-ui.js 统一接线。
  wireShortcuts({
    onMode: selectMode,
    onCamera: (id) => selectCamera(id, true),
    onCycleCamera: cycleCamera,
    onToggleHud: () => hudToggleBtn?.click(),
    onToggleSound: () => audioSystem.setEnabled(!audioSystem.enabled),
    onHonk: () => { if (!mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity()); },
    onLane: requestLane,
    onLaneCancel: () => laneAssist.cancel(),
    onToggleLane: () => { if (manualCarAvailable()) drivingAssists.toggleLane(); },
    onToggleEmergencyBrake: () => { if (manualCarAvailable()) drivingAssists.toggleEmergencyBrake(); }
  });
  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  });

  // 恢复玩家位置和时段后再初始化追尾相机。
  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime(initialTime);
  // QA 入口：只在回环地址的 ?qa=1 下调用，普通游玩地址不向 window 暴露任何调试对象。
  if (qa.enabled) {
    qa.install({
      renderer, scene, cameraSystem, controllerManager, mapSystem, autoDrive, laneAssist, lightingSystem, audioSystem,
      buildingSigns, buildingDetails, traffic, pedestrians, roadFrontage, landmarks, streetscape, sea, bridge,
      modules: {
        lamps: streetLamps, trees, apec: apecTheme, apecCity, drones, lightShow,
        elevatedRoads, metroEntrances, futian: futianStation, xili: xiliConstruction
      },
      teleport: teleportTo,
      getElapsed: () => elapsed,
      getRenderedFrames: () => renderedFrames,
      getGraphicsLoss: () => graphicsLoss
    });
  }
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // Compile shaders behind the loading screen. Overlapping compileAsync() jobs keep compilation moving
  // while individual jobs yield to the browser.
  const COMPILE_POOL = 16;
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  async function precompileShaders() {
    await showLoadingStage(STR.startup.postFX, 'postFX');
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');

    // Every visible object with frustum culling off (like the warm-up frame, see the loop). Plain meshes that share
    // a material share its shader, so one job compiles them in turn (the first build serves the rest); every
    // instanced mesh gets a build of its own unless its chunks share a pipeline
    const culled = [];
    const jobs = [];
    const jobByMaterial = new Map();
    const pipelines = new Set();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      // Use the first visible chunk: the original representative may be in an inactive tree cell. Shadow stand-ins
      // only draw in the shadow maps (the warm-up frame compiles those).
      if (o.userData.shadowProxy) return;
      const pipeline = o.userData.sharesPipelineWith || o;
      if (pipelines.has(pipeline)) return;
      pipelines.add(pipeline);
      if (o.isInstancedMesh || Array.isArray(o.material)) {
        jobs.push([o]);
        return;
      }
      let job = jobByMaterial.get(o.material);
      if (!job) {
        job = [];
        jobByMaterial.set(o.material, job);
        jobs.push(job);
      }
      job.push(o);
    });

    await showLoadingStage(STR.startup.compiling(0, jobs.length), 'compile', false);
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    const compile = async (object) => {
      // Each compile starts in a task of its own: compileAsync() keeps one precompilation state on the renderer,
      // which must not be mid-step for two of them in the same microtask checkpoint
      await nextTask();
      try {
        await renderer.compileAsync(object, cameraSystem.camera, scene);
      } catch (e) {
        console.warn('[compile]', e); // the warm-up frame compiles it instead
      }
    };
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        for (const object of job) await compile(object);
        done++;
        if (loadingStatus) loadingStatus.textContent = STR.startup.compiling(done, jobs.length);
        setStageProgress(done / jobs.length);
      }
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }

  await precompileShaders();
  markInit('compile');
  await showLoadingStage(STR.startup.warmup, 'warmup');

  // 6. Animation Loop
  let lastTime = performance.now();
  let nextPlayerSave = 0;
  let warmedUp = false; // see the first frame below

  if (elFps) elFps.textContent = '60';

  function renderFrame(now) {
    if (graphicsLoss) return;
    // QA 采样令牌：非 qa 或未就绪时返回 null，下面几个调用都按空操作处理。
    const profile = qa.beginFrame(audioSystem.ready);
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    gamepadControls.update(dt);
    roadFrontage.update(elapsed);
    if (cameraSystem.initialized) {
      // 用上一帧实际相机视锥保护正在显示的车，包含整个碰撞包络。
      const camera = cameraSystem.camera;
      camera.updateMatrixWorld();
      trafficFrustum.setFromProjectionMatrix(trafficViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        camera.coordinateSystem, camera.reversedDepth);
    }
    const active = controllerManager.getActiveEntity();
    // 车流读取帧首行人；行人读取推进后的车身并验证脚步。玩家最后扫掠两类当前包络。
    traffic.update(dt, active.position, [active], elapsed, isTrafficVisible, nearPedestrians(active.position.x, active.position.z, 140));
    pedestrians.update(dt, active.position, elapsed, isPedVisible, [active],
      traffic.nearColliders(active.position.x, active.position.z, 175));
    const { forward, backward, left, right, brake, boost } = controllerManager.keys;
    const manual = !mapSystem.isFullMapOpen && Boolean(forward || backward || left || right || brake || boost);
    const autoInput = autoDrive.update(driveCar, { dt, elapsed, mode: controllerManager.activeMode, manual });
    const driveInput = autoInput ?? laneAssist.update(driveCar, { manual });
    controllerManager.update(dt, elapsed, driveInput);
    drivingAssists.render(manualCarAvailable());
    cameraSystem.update(dt, elapsed);
    qa.applyCamera(cameraSystem.camera);
    streetscape.update(cameraSystem.camera.position);
    streetLamps.update(cameraSystem.camera.position);
    trees.update(cameraSystem.camera.position);
    apecTheme.update(dt);
    apecCity.update(dt);
    drones.update(dt);
    lightShow.update();
    metroEntrances.update(cameraSystem.currentPos);
    futianStation?.update(cameraSystem.currentPos);
    xiliConstruction?.update();
    buildingSigns.update(cameraSystem.camera.position);
    buildingSigns.group.updateMatrixWorld(true);
    buildingDetails.update(cameraSystem.camera.position);
    buildingDetails.group.updateMatrixWorld(true);
    qa.markSimulation(profile);
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    if (warmedUp) updateSceneCulling(cameraSystem.camera.position); // the warm-up frame draws every chunk
    for (const root of dynamicRoots) root.updateMatrixWorld();
    qa.markRender(profile);

    // Render frame via TSL RenderPipeline (SSR + Bloom)
    if (!warmedUp) {
      // First frame = pipeline warm-up behind the loading screen, for what precompileShaders() can't reach (the shadow
      // map passes): with frustum culling off, every visible material's pipelines compile now instead of stalling the
      // first time the camera turns towards it (one chunk / shadow stand-in per shared pipeline is enough)
      const culled = [];
      const pipelines = new Set();
      scene.traverseVisible((o) => {
        const pipeline = o.userData.sharesPipelineWith || o;
        if (pipelines.has(pipeline)) return;
        pipelines.add(pipeline);
        if (o.frustumCulled) {
          culled.push(o);
          o.frustumCulled = false;
        }
      });
      renderPipeline.render();
      for (const o of culled) o.frustumCulled = true;
      markInit('warmup');
    }
    renderPipeline.render();
    renderedFrames++;
    qa.endFrame(profile, now, renderer);
    if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
    }

    // HUD 读数按墙钟时间更新，慢帧和高刷屏都显示实际帧率。
    hud.update(rawDt);
  }

  // 启动只提交首帧。确认图形队列完成后再启动循环，避免等待期间持续提交。
  renderFrame(performance.now());
  beginLoadingStage(STR.startup.gpu, 'gpu');
  await waitForFirstFrame(renderer.backend.device);
  const boot = globalThis.__szBoot;
  if (graphicsLoss || boot?.state === 'failed') return;
  markInit('gpu');
  lastTime = performance.now();
  await renderer.setAnimationLoop(renderFrame);
  if (graphicsLoss || boot?.state === 'failed') return;
  console.log(`[init] ${initTimings.join(', ')}`);
  setLoadingProgress(1);
  loadingOverlay?.classList.add('hidden');
  audioSystem.ready = true;
  boot?.ready?.();
}

initApp().catch(error => {
  console.error('[init]', error);
  // 启动失败统一交给 index.html 的兜底入口（模块求值之前就已建立）；提示和重试都由它负责。
  const boot = globalThis.__szBoot;
  if (boot?.fail) {
    if (boot.state !== 'failed') boot.fail(navigator.gpu ? 'init' : 'webgpu', error);
    return;
  }
  const status = document.getElementById('loading-status');
  if (status) status.textContent = navigator.gpu ? STR.loadingFailed : STR.webgpuMissing;
});
