import { STR } from './sz-strings.js';
import { populateTeleportMenu, wireMetroMenu } from './sz-ui.js';
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { getLocationLabel, getLocationInfo, inBounds, isWater, isTypingInField, findGroundArrival, LANDMARK_SITES, TELEPORT_LOCATIONS } from './sz-city-config.js';
import { buildSzGround } from './sz-ground.js';
import { buildSzSea } from './sz-sea.js';
import { buildSzRoads } from './sz-roads.js';
import { buildSzRoadFrontage } from './sz-road-frontage.js';
import { buildSzStreetscape } from './sz-streetscape.js';
import { buildSzStreetLamps } from './sz-street-lamps.js';
import { buildSzTrees } from './sz-trees.js';
import { buildApecTheme } from './sz-apec.js';
import { buildApecCityElements } from './sz-apec-city.js';
import { buildSzDroneRoutes } from './sz-drone-routes.js';
import { buildSzLightShow } from './sz-light-show.js';
import { gatePoint, gateYaw, gateDeckY, flowerSeaAnchor, flowerSeaDeckY } from './sz-landmarks/iec-xiangmihu.js';
import { buildSzMetroEntrances } from './sz-metro-entrances.js';
import { buildFutianStation, buildXiliConstruction } from './sz-station-sites.js';
import { buildSzLandmarks } from './sz-landmarks/index.js';
import { polygonContains } from './building-collision.js';
import { buildShenzhenBayBridge } from './sz-landmarks/shenzhen-bay-bridge.js';
import { buildSzElevatedRoads } from './sz-elevated-roads.js';
import { BUILDING_RENDER_CHUNK_SIZE, buildCityBlocks } from './sz-buildings.js';
import { createSzTraffic, trafficModelBounds } from './sz-traffic.js';
import { createDrivePlanner, createTurnFilter } from './sz-drive-route.js';
import { createAutoDrive } from './sz-auto-drive.js';
import { VEHICLE_SPECS } from './sz-vehicles.js';
import { sceneUniforms } from './sz-materials.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { SZMapSystem } from './sz-map.js';
import { parkAt } from './sz-park-arrivals.js';
import { setupSceneCulling, updateSceneCulling } from './scene-culling.js';
import { CityAudioSystem } from './audio-system.js';

const PLAYER_STATE_KEY = 'sz-player-state';

function summarizeSamples(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
}

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingFill = document.getElementById('loading-progress');
  let graphicsLoss = null;
  let renderedFrames = 0;
  let elapsed = 0;
  const query = new URLSearchParams(location.search);
  const qa = ['127.0.0.1', 'localhost'].includes(location.hostname) && query.get('qa') === '1' ? {
    chunkSize: query.get('chunks') === '500' ? 500 : BUILDING_RENDER_CHUNK_SIZE,
    startup: {}, frames: [], gpu: [], queue: [], previousFrameAt: null, queryPending: false, queuePending: false
  } : null;

  // One progress bar for the whole start-up. Each stage fills a share of it sized after its typical duration (the
  // "[init]" timings logged below, on an M1 MacBook Air; `data` is fetching the code and data before this runs, which
  // the stylesheet animates). The fill glides through a stage as a compositor transition, so it keeps moving while the
  // stage's synchronous work blocks the main thread, at the pace the earlier stages ran at on this machine.
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
    trackTimestamp: Boolean(qa)
  });
  const onDeviceLost = renderer.onDeviceLost.bind(renderer);
  renderer.onDeviceLost = ({ api, reason, message, ...details }) => {
    onDeviceLost({ api, reason, message, ...details });
    graphicsLoss = { api, reason, message };
    loadingOverlay?.classList.remove('hidden');
    if (loadingStatus) loadingStatus.textContent = STR.startup.deviceLost;
  };
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    const ms = Math.round(now - initMark);
    initTimings.push(`${label} ${ms}ms`);
    if (qa) qa.startup[label] = ms;
    initMark = now;
  };

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
  // 车公庙立交高架/匝道：sz-roads 只画地面道路，这里补高架桥面和可站立表面（层高估计）。
  const elevatedRoads = buildSzElevatedRoads(scene, { graph: GEO.roadGraph, terrainSurface: GEO.terrainSurface });
  const roadFrontage = buildSzRoadFrontage(scene, GEO.roadFrontage, GEO.roadGraph, GEO.terrainSurface, {
    groundHeight: ground.groundHeight, roadHeight: roads.roadHeight
  });
  markInit('roads');
  await showLoadingStage(STR.startup.landmarks, 'landmarks');
  const landmarks = buildSzLandmarks(scene, { buildings: REAL_BUILDINGS, terrain: GEO.terrain, sites: GEO.sites });
  const bridge = buildShenzhenBayBridge(scene, GEO.bridges.find(item => item.id === 'shenzhen-bay-bridge'));
  markInit('landmarks');
  await showLoadingStage(STR.startup.blocks, 'blocks');
  // 超级总部/西丽场地按「建好形态/在建工地」接管：场地内旧通用楼不再单独渲染，避免与地标和工地重叠。
  const skipIds = new Set(landmarks.skipIds);
  for (const landmarkId of ['super-hq', 'xili-station']) {
    for (const role of Object.values(GEO.sites?.[landmarkId] ?? {})) {
      for (const building of REAL_BUILDINGS) {
        if (skipIds.has(building.id)) continue;
        for (const polygon of role.polygons) {
          if (polygonContains(polygon, building.cx, building.cz)) { skipIds.add(building.id); break; }
        }
      }
    }
  }
  const cityBlocks = buildCityBlocks(scene, { skipIds, renderChunkSize: qa?.chunkSize });
  // 福田中心区夜景灯光秀：只给已建成普通高层加灯带，颜色/节奏为展示估计；白天隐藏。
  const lightShow = buildSzLightShow(scene, { buildings: REAL_BUILDINGS, terrain: GEO.terrain });
  markInit('blocks');
  const buildings = [...landmarks.colliders, ...cityBlocks.colliders];
  const streetscape = buildSzStreetscape(scene, GEO.streetscape, GEO.terrainSurface, {
    groundHeight: ground.groundHeight, roadHeight: roads.roadHeight, colliders: buildings
  });
  // 主干道路灯：点位由源路网中心线派生，夜间发光与地面光池在 update 里随时段切换。
  const streetLamps = buildSzStreetLamps(scene, GEO.roadGraph, {
    groundHeight: ground.groundHeight, roadHeight: roads.roadHeight
  });
  // 树木：OSM 来源点加带标注的模拟行道树/公园树，接触面与铺装/建筑冲突在运行时复核。
  const trees = buildSzTrees(scene, GEO.trees, {
    groundHeight: ground.groundHeight, roadHeight: roads.roadHeight,
    pathAt: streetscape.pathAt, colliders: buildings
  });
  // APEC 周城市元素：会期内默认打开，模块内所有几何都在主题开关下。
  const apecTheme = buildApecTheme(scene, {
    roadGraph: GEO.roadGraph, terrain: GEO.terrain, landmarks: GEO.landmarks, buildings: REAL_BUILDINGS, area: GEO.bounds,
    // 国际交流中心模型给出的真实门廊/花海台面锚点，避免 APEC 标识埋进新建筑或花坛落到台下。
    anchors: {
      iecGate: { x: gatePoint.x, z: gatePoint.z, yaw: gateYaw, baseY: gateDeckY },
      iecFlowerSea: { x: flowerSeaAnchor.x, z: flowerSeaAnchor.z, baseY: flowerSeaDeckY }
    }
  });
  // APEC 城市元素：路侧 LED 大屏、会场巡逻机器人、西丽站围挡公益广告，随主题开关显隐。
  const apecCity = buildApecCityElements(scene, {
    terrain: GEO.terrain, landmarks: GEO.landmarks, sites: GEO.sites,
    anchors: {
      iecGate: { x: gatePoint.x, z: gatePoint.z, yaw: gateYaw, baseY: gateDeckY },
      iecFlowerSea: { x: flowerSeaAnchor.x, z: flowerSeaAnchor.z, baseY: flowerSeaDeckY }
    }
  });
  // 地铁出入口：点位来自 OSM 已核实节点；雨棚/站名牌是外观参数，吸附到实际渲染地面。
  const metroEntrances = buildSzMetroEntrances(scene, GEO.metro, {
    groundHeight: ground.groundHeight, roadHeight: roads.roadHeight, pathAt: streetscape.pathAt,
    colliders: buildings, isWater
  });
  // 福田站只建地面出入口/采光天窗；西丽站只做在建工地围挡/塔吊/基坑，不造站房。
  const futianStation = GEO.sites?.['futian-station']?.station
    ? buildFutianStation(scene, GEO.sites['futian-station'].station, {
      groundHeight: ground.groundHeight, colliders: buildings
    }) : null;
  const xiliConstruction = GEO.sites?.['xili-station']?.site
    ? buildXiliConstruction(scene, GEO.sites['xili-station'].site, {
      groundHeight: ground.groundHeight, isWater
    }) : null;
  // 无人机航线：端点来自 air 段公开来源；航迹示意，会期低空管控时停在站点。
  const drones = buildSzDroneRoutes(scene, { air: GEO.air, terrain: GEO.terrain });
  if (qa) {
    window.__szLamps = streetLamps; window.__szTrees = trees; window.__szApec = apecTheme;
    window.__szApecCity = apecCity; window.__szDrones = drones; window.__szLightShow = lightShow;
    window.__szElevatedRoads = elevatedRoads;
    window.__szMetroEntrances = metroEntrances; window.__szFutian = futianStation; window.__szXili = xiliConstruction;
  }
  const colliders = [...buildings, ...streetscape.colliders, ...roadFrontage.colliders, ...trees.colliders,
    ...metroEntrances.colliders, ...(futianStation?.colliders ?? []), ...(xiliConstruction?.colliders ?? [])];
  await showLoadingStage(STR.startup.traffic, 'traffic');
  const traffic = createSzTraffic(scene, GEO.roadGraph, {
    roadHeight: roads.roadHeight,
    colliders, signals: roadFrontage.control, detailedRoadIds: roadFrontage.detailedRoadIds,
    canTurn: createTurnFilter(GEO.roadGraph)
  });
  markInit('traffic');

  // 路缘接触和绘制共用同一份三角面，未覆盖的位置沿用源地形。
  await showLoadingStage(STR.startup.controllers, 'controllers');
  const controllerManager = new ThirdPersonControllerManager(scene, colliders, {
    groundHeight: (x, z) => roadFrontage.contactHeight(x, z) ?? ground.groundHeight(x, z),
    surfaces: [...landmarks.surfaces, ...elevatedRoads.surfaces],
    nearTraffic: traffic.nearColliders
  });
  const initialMode = controllerManager.activeMode;
  let initialTime = 'golden';
  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_STATE_KEY));
    if (saved?.version === 1) {
      if (Object.hasOwn(STR.timeNames, saved.time)) initialTime = saved.time;
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        const park = mode === 'person' ? parkAt(GEO.parks, p.x, p.z) : null;
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y, { park, requireArrival: Boolean(park) });
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : initialMode);
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }
  const players = Object.values(controllerManager.entities);
  roadFrontage.update(0);
  traffic.update(0, controllerManager.getActiveEntity().position, players, 0);
  const driveCar = controllerManager.entities.car;
  const driveModel = trafficModelBounds(driveCar.collisionBounds, VEHICLE_SPECS.taxi);
  const driveOptions = { model: driveModel, roadHeight: roads.roadHeight, control: roadFrontage.control };
  const autoDrive = createAutoDrive({ ...driveOptions, nearTraffic: traffic.nearColliders });
  let planner = null;
  const drivePlanner = () => planner ??= createDrivePlanner(traffic.network, GEO.roadGraph, { ...driveOptions,
    isClear: pose => controllerManager.isClearCarPose(pose), detailedRoadIds: roadFrontage.detailedRoadIds });

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
        version: 1, activeMode: controllerManager.activeMode, time: lightingSystem.activePresetId, entities
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
  const cullingRoots = [ground.group, roads.group, elevatedRoads.group, cityBlocks.group];
  for (const root of cullingRoots) {
    const [first, ...chunks] = root.children;
    // 每类静态分块共用材质和顶点布局，预编译其中一块即可。
    for (const chunk of chunks) chunk.userData.sharesPipelineWith = first;
  }
  setupSceneCulling(scene, [...cullingRoots, landmarks.group, bridge.group, streetscape.group, roadFrontage.group, streetLamps.group, trees.group, apecTheme.group, metroEntrances.group,
    futianStation?.group, xiliConstruction?.group].filter(Boolean), lightingSystem.sunLight.shadow);

  const dynamicRoots = [
    traffic.group,
    ...players.map(entity => entity.mesh),
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
  const cameraPresets = CAMERA_PRESETS.filter(preset => preset.id !== 'bayBridge' || bridge.group);
  document.getElementById('cam-bayBridge')?.toggleAttribute('hidden', !bridge.group);
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

  // 速度表满格按各移动方式的最高速度（米/秒）。
  const topSpeed = { person: 8.2, car: 36, cyclist: 19, helicopter: 36 };

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

  function selectMode(mode) {
    if (mode !== controllerManager.activeMode) autoDrive.stop('manual');
    controllerManager.setMode(mode);
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
    sceneUniforms.night.value = lightingSystem.uNightFactor.value;
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

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
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
      // The camera control moves to the top on touch screens; open toward the available space.
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

  let locationText = '';
  function renderLocation(x, z) {
    if (!elLocation) return;
    const label = getLocationLabel(x, z);
    if (label === locationText) return;
    locationText = label;
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
    elLocation.replaceChildren(place);
  }

  function teleportTo(x, z, heading, options = {}) {
    if (!inBounds(x, z)) return null;
    const park = options.park ?? (controllerManager.activeMode === 'person' ? parkAt(GEO.parks, x, z) : null);
    const destination = controllerManager.teleportActiveTo(x, z, heading, null, { requireArrival: true, park });
    if (!destination) return null;
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
    if (!controllerManager.findTeleportPosition(x, z, heading, 0, true, null, { exact: true, mode: 'car' })) return false;
    selectMode('car');
    const destination = controllerManager.teleportActiveTo(x, z, heading, null, { exact: true });
    if (!destination) return false;
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

  // 地铁菜单：列出 GEO 里官方线路色的线路，默认全部关闭；点击后只画选中线路。
  const metroLinesEl = document.getElementById('metro-lines');
  if (metroLinesEl && Array.isArray(GEO.metro?.lines)) {
    const metroSelection = new Set();
    const lineButtons = new Map();
    const applyMetroSelection = () => {
      mapSystem.setMetroLines([...metroSelection]);
      for (const [ref, button] of lineButtons) {
        const on = metroSelection.has(ref);
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('active', on);
      }
    };
    const lines = [...GEO.metro.lines].sort((a, b) => {
      const na = Number.parseFloat(a.ref), nb = Number.parseFloat(b.ref);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a.ref).localeCompare(String(b.ref), 'en');
    });
    for (const line of lines) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pop-item metro-line';
      button.setAttribute('aria-pressed', 'false');
      button.dataset.lineRef = line.ref;
      button.dataset.label = STR.metro.line(line.ref);
      const swatch = document.createElement('span');
      swatch.className = 'metro-swatch';
      swatch.style.background = line.colour;
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = STR.metro.line(line.ref);
      button.append(swatch, label);
      button.addEventListener('click', () => {
        if (metroSelection.has(line.ref)) metroSelection.delete(line.ref);
        else metroSelection.add(line.ref);
        applyMetroSelection();
      });
      metroLinesEl.appendChild(button);
      lineButtons.set(line.ref, button);
    }
    document.getElementById('metro-show-all')?.addEventListener('click', () => {
      for (const line of lines) metroSelection.add(line.ref);
      applyMetroSelection();
    });
    document.getElementById('metro-hide-all')?.addEventListener('click', () => {
      metroSelection.clear();
      applyMetroSelection();
    });
  }

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  // QA 专用传送：只在本机回环地址的 ?qa=1 下暴露，便于固定机位复测。
  if (qa) window.__szTeleport = (x, z, heading = 0) => controllerManager.teleportActiveTo(x, z, heading, null, { exact: true });
  // QA：非精确传送（自动找最近可站立落点），用于把车辆/人物放到道路上做连续走通测试。
  if (qa) window.__szTeleportNear = (x, z, heading = 0) => controllerManager.teleportActiveTo(x, z, heading, null);
  // QA 诊断：列出某点附近的碰撞体，用于定位“走不过去”的地面入口。
  if (qa) window.__szNearColliders = (x, z, radius = 40) => colliders.filter(collider =>
    Number.isFinite(collider?.minX) && collider.maxX > x - radius && collider.minX < x + radius
    && collider.maxZ > z - radius && collider.minZ < z + radius)
    .sort((a, b) => Math.hypot((a.minX + a.maxX) / 2 - x, (a.minZ + a.maxZ) / 2 - z)
      - Math.hypot((b.minX + b.maxX) / 2 - x, (b.minZ + b.maxZ) / 2 - z))
    .slice(0, 12).map(collider => ({ type: collider.type, name: collider.name, sourceId: collider.sourceId,
      minY: collider.minY, maxY: collider.maxY,
      minX: Math.round(collider.minX), maxX: Math.round(collider.maxX),
      minZ: Math.round(collider.minZ), maxZ: Math.round(collider.maxZ) }));

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

  // Global keyboard shortcuts for modes (1-4), cameras (V / 5-0), and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    switch (e.code) {
      case 'Digit1':
        selectMode('person');
        break;
      case 'Digit2':
        selectMode('car');
        break;
      case 'Digit3':
        selectMode('cyclist');
        break;
      case 'Digit4':
        selectMode('helicopter');
        break;
      case 'Digit5':
        selectCamera('chase', true);
        break;
      case 'Digit6':
        selectCamera('action', true);
        break;
      case 'Digit7':
        selectCamera('pov', true);
        break;
      case 'Digit8':
        selectCamera('fifthAve', true);
        break;
      case 'Digit9':
        selectCamera('timesSquare', true);
        break;
      case 'Digit0':
        selectCamera('chryslerGCT', true);
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
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
  if (qa) {
    // 只返回快照，验收通过同一套玩家输入完成。
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      qa.frames.length = 0;
      qa.gpu.length = 0;
      qa.queue.length = 0;
      qa.previousFrameAt = null;
    });
    function profileSnapshot() {
      const durationMs = Math.min(10000, qa.frames.reduce((sum, frame) => sum + frame.intervalMs, 0));
      const fields = ['intervalMs', 'simulationMs', 'sceneUiMs', 'renderCpuMs', 'drawCalls', 'triangles', 'gpuBytes'];
      return {
        chunkSize: qa.chunkSize,
        startupMs: { ...qa.startup },
        frames: qa.frames.length,
        durationMs,
        fps: durationMs ? qa.frames.length * 1000 / durationMs : null,
        ...Object.fromEntries(fields.map(key => [key, summarizeSamples(qa.frames.map(frame => frame[key]))])),
        gpuRenderMs: summarizeSamples(qa.gpu.map(sample => sample.ms)),
        gpuSamples: qa.gpu.length,
        gpuQueueWaitMs: summarizeSamples(qa.queue.map(sample => sample.ms)),
        gpuQueueSamples: qa.queue.length
      };
    }
    Object.defineProperty(window, '__szQA', { value: () => ({
      ready: audioSystem.ready,
      mode: controllerManager.activeMode,
      entities: Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading, speed: entity.speed
      }])),
      camera: { id: cameraSystem.activePresetId, position: cameraSystem.camera.position.toArray() },
      time: lightingSystem.activePresetId,
      map: { open: mapSystem.isFullMapOpen, search: mapSystem.searchHighlight,
        waypoint: mapSystem.waypoint && { ...mapSystem.waypoint }, metro: [...mapSystem.metroLines],
        view: { x: mapSystem.viewCenterX, z: mapSystem.viewCenterZ, zoom: mapSystem.viewZoom } },
      traffic: { ...traffic.statistics, actors: traffic.vehicles.filter(actor => actor.route).map(actor => {
        const stop = actor.stops[actor.stopIndex];
        return { id: actor.id, x: actor.pose.x, y: actor.pose.y, z: actor.pose.z, heading: actor.pose.heading,
          wayId: actor.pose.edge?.osmId, speed: actor.speed, s: actor.s, end: actor.end, stalled: actor.stalled,
          wait: actor.waitingForSignal, blocker: actor.blocker ?? null, reservation: actor.reservation?.id ?? null,
          stop: stop ? { s: stop.s, clearS: stop.clearS, osmNodeId: stop.approach.osmNodeId, group: stop.approach.group } : null };
      }) },
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
      streetscape: streetscape.statistics && { ...streetscape.statistics, arrival: streetscape.arrival,
        activePaths: streetscape.pathAt(controllerManager.getActiveEntity().position.x, controllerManager.getActiveEntity().position.z) },
      landmarks: {
        models: landmarks.group.children.map(group => group.name),
        replaced: landmarks.skipIds.size,
        collisionParts: landmarks.colliders.length,
        roofSurfaces: landmarks.surfaces.map(surface => surface.id),
        distant: bridge.group ? [{ id: bridge.group.name, ...bridge.statistics, playable: false }] : []
      },
      profile: profileSnapshot(),
      renderer: { backend: renderer.backend.constructor.name, initialized: renderer.initialized,
        animationRegistered: Boolean(renderer.getAnimationLoop()), frame: renderer.info.frame, renderedFrames,
        deviceLost: graphicsLoss && { ...graphicsLoss }, render: { ...renderer.info.render }, memory: { ...renderer.info.memory } }
    }) });
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
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let warmedUp = false; // see the first frame below

  if (elFps) elFps.textContent = '60';

  function renderFrame(now) {
    if (graphicsLoss) return;
    const measureFrame = qa && audioSystem.ready && !document.hidden;
    const profileStart = measureFrame ? performance.now() : 0;
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
    traffic.update(dt, controllerManager.getActiveEntity().position, players, elapsed, isTrafficVisible);
    const { forward, backward, left, right } = controllerManager.keys;
    const driveInput = autoDrive.update(driveCar, { dt, elapsed, mode: controllerManager.activeMode,
      manual: !mapSystem.isFullMapOpen && Boolean(forward || backward || left || right) });
    controllerManager.update(dt, elapsed, cameraSystem.initialized ? cameraSystem.currentPos : null, driveInput);
    cameraSystem.update(dt, elapsed);
    streetscape.update(cameraSystem.camera.position);
    streetLamps.update(cameraSystem.camera.position, lightingSystem.uNightFactor.value);
    trees.update(cameraSystem.camera.position);
    apecTheme.update(dt, lightingSystem.uNightFactor.value);
    apecCity.update(dt, lightingSystem.uNightFactor.value);
    drones.update(dt);
    lightShow.group.visible = lightingSystem.uNightFactor.value > 0.25;
    metroEntrances.update(cameraSystem.currentPos);
    futianStation?.update(cameraSystem.currentPos);
    xiliConstruction?.update();
    const simulationEnd = measureFrame ? performance.now() : 0;
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    if (warmedUp) updateSceneCulling(cameraSystem.camera.position); // the warm-up frame draws every chunk
    for (const root of dynamicRoots) root.updateMatrixWorld();
    const renderStart = measureFrame ? performance.now() : 0;

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
    if (measureFrame) {
      const cutoff = now - 10000;
      if (qa.previousFrameAt !== null) qa.frames.push({
        at: now, intervalMs: now - qa.previousFrameAt, simulationMs: simulationEnd - profileStart,
        sceneUiMs: renderStart - simulationEnd, renderCpuMs: performance.now() - renderStart,
        drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
        gpuBytes: renderer.info.memory.total
      });
      qa.previousFrameAt = now;
      while (qa.frames[0]?.at < cutoff) qa.frames.shift();
      while (qa.gpu[0]?.at < cutoff) qa.gpu.shift();
      while (qa.queue[0]?.at < cutoff) qa.queue.shift();
      if (renderedFrames % 30 === 0) {
        const device = renderer.backend.device;
        if (device && !qa.queuePending) {
          const started = performance.now();
          qa.queuePending = true;
          device.queue.onSubmittedWorkDone().then(() => {
            if (!document.hidden) qa.queue.push({ at: now, ms: performance.now() - started });
          }).catch(error => console.warn('[profile queue]', error)).finally(() => { qa.queuePending = false; });
        }
        if (renderer.backend.trackTimestamp && !qa.queryPending) {
          qa.queryPending = true;
          renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(ms => {
            if (Number.isFinite(ms) && !document.hidden) qa.gpu.push({ at: now, ms });
          }).catch(error => console.warn('[profile timestamp]', error)).finally(() => { qa.queryPending = false; });
        }
      }
    }
    if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
      // The loading screen stays up until the GPU has got through the first frame (and the pipelines its warm-up
      // compiled), i.e. until the city is actually on screen
      const device = renderer.backend.device;
      beginLoadingStage(STR.startup.gpu, 'gpu');
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).then(() => {
        if (graphicsLoss) return;
        markInit('gpu');
        console.log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        setLoadingProgress(1);
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        audioSystem.ready = true;
      }, error => {
        console.error('[first-frame]', error);
        if (loadingStatus && !graphicsLoss) loadingStatus.textContent = STR.loadingFailed;
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const speed = Math.abs(activeEnt.speed);
      const kmh = Math.round(speed * 3.6);
      const altitude = Math.round(activeEnt.position.y);

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(kmh);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, speed / topSpeed[mode])})`;
      if (elAltitude) elAltitude.textContent = altitude.toLocaleString('zh-CN');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(where.x, where.z);
    }
  }

  // 在启动流程里完成首帧，首帧异常可由 initApp 的调用方显示。
  renderFrame(performance.now());
  await renderer.setAnimationLoop(renderFrame);
}

initApp().catch(error => {
  console.error('[init]', error);
  const status = document.getElementById('loading-status');
  if (status) status.textContent = navigator.gpu ? STR.loadingFailed : STR.webgpuMissing;
});
