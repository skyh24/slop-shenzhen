import { spatialIndex } from './sz-spatial.js';
import { isWater, nearRoadsForFrontage } from './sz-city-config.js';
import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { createSceneStyle } from './sz-scene-style.js';
import { createGroundSurfaceSampler, buildSzGround } from './sz-ground.js';
import { createBayPathLookup } from './sz-bay-waterfront.js';
import { createWaterfrontPaths, relocatedBayPathIds } from './sz-waterfront.js';
import { buildSzSea } from './sz-sea.js';
import { buildSzRoads, planStreetTreeSides } from './sz-roads.js';
import { buildSzRoadFrontage } from './sz-road-frontage.js';
import { buildSzRoadPaint } from './sz-road-paint.js';
import { createRoadBuildingClearance } from './sz-road-building-clearance.js';
import { createSurfaceResolver } from './sz-controller-surfaces.js';
import { createSurfaceAtlas } from './sz-surface-atlas.js';
import { createPlaceAssembly } from './sz-place-assembly.js';
import { buildSzStreetscape } from './sz-streetscape.js';
import { prepareTalentPark } from './sz-talent-park.js';
import { createUrbanPavingWalk } from './sz-urban-paving.js';
import { buildSzStreetLamps } from './sz-street-lamps.js';
import { createArterialTreeFilter } from './sz-arterial-trees.js';
import { buildVegetationPilots } from './sz-vegetation.js';
import { buildSzTrees } from './sz-trees.js';
import { planWoodlandTrees } from './sz-woodlands.js';
import { buildApecTheme } from './sz-apec.js';
import { buildApecCityElements } from './sz-apec-city.js';
import { buildSzLightShow, planLandmarkBands } from './sz-light-show.js';
import { createCbdProgram, isCbdProgramBuilding } from './sz-cbd-program.js';
import { buildLianhuashanSummit, reviewedParkOmissions, summitViewObstructed, SUMMIT_ARRIVAL } from './sz-lianhuashan.js';
import { buildIecGrounds } from './sz-landmarks/iec-grounds.js';
import { buildNorthStation } from './sz-rail/station.js';
import { northBridgeProfile } from './sz-rail/geometry.js';
import { buildFutianStation, buildXiliConstruction } from './sz-station-sites.js';
import { buildSzLandmarks } from './sz-landmarks/index.js';
import { buildSzDistricts } from './sz-districts/index.js';
import { buildThemeParks } from './sz-theme-parks/index.js';
import { buildShenzhenBayBridge, buildYanjiangExpressway } from './sz-landmarks/shenzhen-bay-bridge.js';
import { buildSzElevatedRoads } from './sz-elevated-roads.js';
import { buildSzTunnels } from './sz-tunnels.js';
import { buildRoadLandscape } from './sz-road-landscape.js';
import { buildCityBlocks } from './sz-buildings.js';
import { buildBuildingSigns } from './sz-building-signs.js';
import { buildBuildingDetails } from './sz-building-details.js';
import { createCarriagewayBarrier } from './sz-pedestrian-tracks.js';
import { buildZhongxinWalk, COCO_PARK_ENTRANCE } from './sz-zhongxin-walk.js';
import { sceneUniforms } from './sz-materials.js';

// 离线规划与正式场景共用地面、建筑、桥梁及树冠的生成顺序和接触面。
export async function prepareSceneSite(scene, { qa, showLoadingStage, markInit, startup, offline = false }) {
  const frontageLight = { ...COCO_PARK_ENTRANCE, night: sceneUniforms.night };
  const ground = qa.measureBuild('ground', () => buildSzGround(scene, GEO.terrainSurface, { frontageLight }));
  const sea = !offline && qa.measureBuild('sea', () => buildSzSea(scene, GEO.seaSurface));
  markInit('ground');
  await showLoadingStage(startup.roads, 'roads');
  const roadGraph = GEO.roadGraph;
  const roads = qa.measureBuild('roads', () => buildSzRoads(scene, roadGraph, GEO.terrainSurface, { frontageLight }));
  // 场地上下文：地形、路面、路网和各构建函数共用的接触面参数只构造一份，入口里不再重复传同一组闭包。
  const site = {
    buildings: REAL_BUILDINGS, terrain: GEO.terrain, terrainSurface: GEO.terrainSurface, sites: GEO.sites,
    roadGraph, groundHeight: ground.groundHeight, roadHeight: roads.roadHeight, isWater,
    colliders: [], golfCourse: GEO.golfCourse, style: createSceneStyle(GEO)
  };
  // 车公庙立交高架/匝道：sz-roads 只画地面道路，这里补高架桥面和可站立表面（层高估计）。
  const elevatedRoads = qa.stage('elevated', () =>
    buildSzElevatedRoads(scene, { graph: site.roadGraph, terrainSurface: site.terrainSurface,
      extraCrossing: northBridgeProfile(GEO.shenzhenNorthRail), waterfront: GEO.waterfront,
      parkFootbridges: GEO.talentPark?.footbridges, water: GEO.water, isWater }));
  const carriagewayOccupied = createCarriagewayBarrier(roadGraph).contains;
  const parkBayPaths = GEO.waterfront?.parkNetwork?.bayPaths ?? [];
  const relocated = relocatedBayPathIds(GEO.waterfront?.parkNetwork);
  const pilotBayPaths = (GEO.shenzhenBay?.paths ?? []).filter(path => !relocated.has(path.osmId));
  const bayPaths = createBayPathLookup([...pilotBayPaths, ...parkBayPaths]);
  // 隧道与桥面同一套通用剖面：洞身、洞口、路面都由源图与地形派生，审核结构只离线留存。
  const tunnels = qa.stage('tunnels', () => buildSzTunnels(scene, { graph: site.roadGraph,
    terrainSurface: site.terrainSurface, groundHeight: ground.groundHeight, wholeCity: true, water: GEO.water, isWater }));
  const roadLandscape = qa.measureBuild('roadLandscape', () =>
    buildRoadLandscape(scene, GEO.roadStructures?.landscape, GEO.terrainSurface, ground.groundHeight));
  const roadFrontage = qa.measureBuild('frontage', () =>
    buildSzRoadFrontage(scene, GEO.roadFrontage, roadGraph, GEO.terrainSurface, site));
  const roadPaint = !offline && qa.stage('paint', () =>
    buildSzRoadPaint(scene, roadGraph, { ...site, intersections: roadFrontage.control.intersections,
      frontage: GEO.roadFrontage,
      // contactSurface=false 的贴地结构边没有接触面，但仍保留 topPaintTriangles 供标线使用。
      decks: [...elevatedRoads.links, ...tunnels.links]
        .filter(link => (link.topPaintTriangles?.length ?? link.topTriangles?.length ?? 0) > 0) }));
  const publicWalk = buildZhongxinWalk(scene, site.roadGraph, site.terrainSurface, site.style);
  // 场所接入声明：公共步道只在这里登记一次，图集、树灯预留与行人排除都从同一份声明取。
  const places = createPlaceAssembly();
  places.register({
    id: 'public-walk',
    ground: { heightSource: 'rendered-terrain', sample: publicWalk.heightAt },
    walkReserve: publicWalk.reserves,
    walkerExclusion: publicWalk.reserves
  });
  // 活动表面图集：地面、步行面、路侧与场地按注册顺序叠加，后注册的覆盖先注册的。
  // 落位、接触与测试都读同一份装配，不再靠就地改写 site.heightAt 决定谁权威。
  const surfaceAtlas = createSurfaceAtlas({ groundHeight: ground.groundHeight });
  places.applyGrounds(surfaceAtlas);
  surfaceAtlas
    .add({ id: 'road-frontage', heightSource: 'rendered-terrain', sample: roadFrontage.contactHeight })
    .add({ id: 'road-landscape', heightSource: 'rendered-terrain', sample: roadLandscape.pathHeight });
  site.surfaceAtlas = surfaceAtlas;
  site.heightAt = (x, z) => surfaceAtlas.heightAt(x, z);
  const districts = qa.measureBuild('districts', () => buildSzDistricts(scene, site,
    { water: GEO.water, roads: roads.surfaces, carriagewayOccupied, decks: elevatedRoads.links }));
  surfaceAtlas.add({ id: 'districts', heightSource: 'rendered-terrain', sample: districts.heightAt });
  site.shennanMedianHeight = roadFrontage.shennanMedianHeight;
  const waterfrontPaths = createWaterfrontPaths(GEO.waterfront);
  const urbanPaving = createUrbanPavingWalk(GEO.urbanPaving, site.heightAt);
  site.reserveBayWalk = (x, z, radius) => bayPaths(x, z, radius).length > 0;
  markInit('roads');
  await showLoadingStage(startup.landmarks, 'landmarks');
  const lianhuashan = GEO.parks.find(park => park.id === 'lianhuashan');
  const summit = buildLianhuashanSummit(scene, site.groundHeight, lianhuashan, site.style);
  const parkOmissions = reviewedParkOmissions(lianhuashan, site.buildings);
  const cbdProgram = offline ? {} : createCbdProgram({ ...SUMMIT_ARRIVAL, y: SUMMIT_ARRIVAL.y + 1.68 }, sceneUniforms.night);
  const landmarks = qa.stage('landmarks', () => buildSzLandmarks(scene, { ...site, northRail: GEO.shenzhenNorthRail, programEmission: cbdProgram.emission }));
  const iec = landmarks.group.getObjectByName('ShenzhenLandmark:iec-xiangmihu')
    ? buildIecGrounds(scene, { ...site, roadSurfaces: roads.surfaces, water: GEO.water, paths: GEO.iecPaths }) : null;
  const northStation = landmarks.heights?.has('shenzhen-north')
    ? qa.measureBuild('northStation', () => buildNorthStation(scene, GEO.shenzhenNorthRail, site)) : null;
  // 北站场地：地面层、公开上跨面、树灯预留、行人排除、模式限制与公共步行线路在同一处登记。
  if (northStation) {
    places.register({
      id: 'north-station',
      ground: { heightSource: 'rendered-terrain', sample: northStation.heightAt },
      standable: northStation.surfaces,
      walkReserve: northStation.reserves,
      walkerExclusion: northStation.inRestricted,
      access: { restricted: northStation.inRestricted },
      publicRoutes: ({ colliders, carriageway }) => northStation.publicRoutes(colliders, carriageway)
    });
    places.applyGrounds(surfaceAtlas);
  }
  const bridge = !offline && buildShenzhenBayBridge(scene, GEO.bridges.find(item => item.id === 'shenzhen-bay-bridge'));
  const yanjiang = !offline && buildYanjiangExpressway(scene, GEO.yanjiangExpressway,
    new Set([...elevatedRoads.links, ...tunnels.links].map(link => Number(link.osmId.split('/')[1]))));
  const themeParks = qa.stage('themeParks', () => buildThemeParks(scene, { ...site, mapRegions: GEO.mapRegions }));
  markInit('landmarks');
  await showLoadingStage(startup.blocks, 'blocks');
  const sceneSkipIds = new Set([...landmarks.skipIds, ...districts.skipIds, ...themeParks.skipIds, ...parkOmissions]);
  // 门槛接入现有铺装三角面、专项人行道或路侧步行面。
  const pavedHeight = createGroundSurfaceSampler(site.terrainSurface, kind => kind === 3 || kind === 4 || kind === 7);
  // 店招与雨棚只认铺装面：同一套图集，换成铺装的三层即可，不再手写一遍 ??。
  const pavementAtlas = createSurfaceAtlas({ layers: [
    { id: 'paved-terrain', heightSource: 'terrain', sample: pavedHeight },
    { id: 'road-frontage', heightSource: 'rendered-terrain', sample: roadFrontage.contactHeight },
    // 铺装图集的优先级与主图集不同：公共步道在这里最后覆盖。层定义仍复用场所声明。
    places.groundLayer('public-walk')
  ] });
  const retail = {
    regions: GEO.mapRegions?.regions, nearRoads: nearRoadsForFrontage, carriageway: carriagewayOccupied,
    entrance: publicWalk.entrance,
    pavementAt: (x, z) => pavementAtlas.heightAt(x, z)
  };
  const cityBlocks = qa.stage('blocks', () =>
    buildCityBlocks(scene, { skipIds: sceneSkipIds, renderChunkSize: qa.chunkSize, retail,
      programEmission: cbdProgram.emission, programParticipant: isCbdProgramBuilding,
      roadClearance: createRoadBuildingClearance(site.roadGraph, site.roadHeight, elevatedRoads.links) }));
  // 基础体量交给后续夜景和近景的排除身份只从 detailPlan 取，入口不再重拼一份 detailSkipIds。
  // 福田中心区夜景灯光秀：只给已建成普通高层加灯带，颜色/节奏为展示估计；白天隐藏。
  // 地标源对象已由专模打光，排除它们；地标外露钢架（平安 8 根巨柱）单独沿柱轴生成灯带。
  const landmarkBands = !offline && planLandmarkBands(landmarks.colliders);
  const lightShow = !offline && qa.stage('lightshow', () =>
    buildSzLightShow(scene, { buildings: site.buildings, terrain: site.terrain,
      excludeIds: cityBlocks.detailPlan.skipIds, landmarkBands, isProgramActive: () => cbdProgram.active }));
  const buildingSigns = !offline && qa.stage('signs', () =>
    buildBuildingSigns(scene, { buildings: cityBlocks.allBlocks, roadGraph: site.roadGraph }));
  // 近景补足屋顶和立面细节，避开基础屋顶已绘制的构件；输入只读建筑规划产出的 detailPlan。
  const buildingDetails = !offline && qa.stage('details', () =>
    buildBuildingDetails(scene, { detailPlan: cityBlocks.detailPlan }));
  markInit('blocks');
  const buildings = [...landmarks.colliders, ...cityBlocks.colliders, ...summit.colliders, ...districts.colliders, ...themeParks.colliders, ...(northStation?.colliders ?? [])];
  site.colliders = buildings;
  const streetscape = qa.stage('streetscape', () => buildSzStreetscape(scene, GEO.streetscape, site.terrainSurface, site));
  // 离线的选址复用同一批实体，运行时只在确有局部用途时才查询。
  let buildingIndex;
  const nearBuildings = (x, z, radius) => {
    buildingIndex ??= spatialIndex(buildings, c => [{ x: c.minX, z: c.minZ }, { x: c.maxX, z: c.maxZ }]);
    return buildingIndex(x, z, radius);
  };
  const talentPark = prepareTalentPark(scene, GEO, site, { offline, elevatedSurfaces: elevatedRoads.surfaces,
    nearObstacles: (x, z, radius) => offline ? nearBuildings(x, z, radius) : site.nearObstacles(x, z, radius)
  });
  const { waterfront } = talentPark;
  site.pathAt = (x, z) => {
    const parkPaths = themeParks.pathAt(x, z);
    if (parkPaths.length) return parkPaths;
    const summitPaths = summit.pathAt(x, z);
    if (summitPaths.length) return summitPaths;
    const waterfrontPaths = waterfront?.pathAt(x, z);
    return waterfrontPaths?.length ? waterfrontPaths : streetscape.pathAt(x, z);
  };
  const minorRoadBounds = (GEO.roadFrontage?.corridors ?? []).filter(row => row.id.startsWith('shennan-'))
    .map(row => row.bounds);
  // 避让只看露天地面之上的桥面；隧道洞身顶面在地形以下，不参与树木与灯杆避让。
  const deck = createSurfaceResolver({ groundHeight: () => null, surfaces: elevatedRoads.surfaces });
  const deckOccupied = (x, z, bottom, top) => deck.at(x, z).some(surface => surface.height + 4.5 > bottom
    && surface.height - 0.35 < top);
  // 树灯按完整底座避让与沥青网格同源的车行范围，路口补面也参与。
  const treeSite = {
    ...site, carriagewayOccupied, deckOccupied, excludedSite: themeParks.reserved, woodlandTrees: planWoodlandTrees(), simulatedPathAt: iec?.sceneryAt, roadFrontage: GEO.roadFrontage,
    // 场所自己的步道预留先查登记表；其余场地/路侧预留仍按各自既有入口提供。
    reserveWalk: (x, z, r) => places.reservesWalk(x, z, r) || waterfront?.reserves(x, z, r)
      || districts.reserves(x, z, r) || landmarks.reservesApproach?.(x, z, r) || urbanPaving.reserves(x, z, r) || waterfrontPaths.reserves(x, z, r) || site.reserveBayWalk(x, z, r) || roadLandscape.walkAt(x, z, r).length > 0 || roadFrontage.reserveWalk(x, z, r),
    reserveView: summit.group ? summitViewObstructed : null,
    observedTrees: streetscape.observedTrees, pilotTrees: [...themeParks.trees, ...publicWalk.trees, ...(waterfront?.pilotTrees ?? []), ...roadLandscape.trees, ...districts.trees, ...urbanPaving.trees],
    streetTreeSideAllowed: planStreetTreeSides(site.roadGraph, minorRoadBounds),
    arterialTreeAllowed: createArterialTreeFilter(nearRoadsForFrontage, roadFrontage.arterialMedianAt)
  };
  const trees = qa.stage('trees', () => buildSzTrees(scene, GEO.trees, treeSite));
  // 灯位从实际道路断面派生，已核实的中央分隔带参与选位。
  const streetLamps = qa.stage('lamps', () => buildSzStreetLamps(scene, site.roadGraph, {
    ...site, roadStyle: site.style.road, carriagewayOccupied, medianHeight: roadFrontage.medianHeight, walkPlacement: publicWalk, relocateSite: candidate => {
      const placed = iec ? iec.relocateLamp(candidate) : candidate;
      return placed && !landmarks.reservesApproach?.(placed.x, placed.z, 0.34) ? placed : null;
    },
    // 路灯的避让范围与树不同：场所可选择登记 lampReserve，未登记的不改变既有落位。
    reserveWalk: (x, z, r) => places.reservesLampSites(x, z, r) || urbanPaving.reserves(x, z, r)
      || waterfrontPaths.reserves(x, z, r) || site.reserveBayWalk(x, z, r) || waterfront?.reserves(x, z, r),
    reserveCrossing: roadFrontage.reserveWalk,
    placementObstacles: [...buildings, ...trees.colliders],
    deckOccupied
  }));
  const anchors = iec?.anchors;
  // APEC 周城市元素：会期内默认打开，模块内所有几何都在主题开关下。
  const apecTheme = !offline && qa.stage('apec', () =>
    buildApecTheme(scene, { ...site, lampSites: streetLamps.sites, lampChunkVisible: streetLamps.chunkVisible,
      landmarks: GEO.landmarks, area: GEO.bounds, anchors }));
  const apecCity = !offline && qa.stage('apecCity', () =>
    buildApecCityElements(scene, { ...site, landmarks: GEO.landmarks, anchors }));
  // 福田站只建地面出入口/采光天窗；西丽站只做在建工地围挡/塔吊/基坑，不造站房。
  const stations = qa.stage('stations', () => ({
    futian: GEO.sites?.['futian-station']?.station
      ? buildFutianStation(scene, GEO.sites['futian-station'].station, site) : null,
    xili: GEO.sites?.['xili-station']?.site
      ? buildXiliConstruction(scene, GEO.sites['xili-station'].site, site) : null
  }));
  const futianStation = stations?.futian ?? null;
  const xiliConstruction = stations?.xili ?? null;
  const colliders = [...buildings, ...roadFrontage.colliders, ...(streetLamps.colliders ?? []), ...trees.colliders,
    ...(futianStation?.colliders ?? []), ...(xiliConstruction?.colliders ?? []),
    ...elevatedRoads.colliders, ...tunnels.colliders, ...(talentPark.plan?.colliders ?? [])];
  const planter = publicWalk.placePlanter(colliders, site.heightAt);
  if (planter) colliders.push(planter);
  const vegetation = qa.measureBuild('vegetation', () => buildVegetationPilots(scene, GEO, {
    ...treeSite, colliders, pavedAt: retail.pavementAt, nearRoads: nearRoadsForFrontage,
    reserveWalk: (x, z, r) => treeSite.reserveWalk(x, z, r) || site.reserveBayWalk(x, z, r)
  }, trees.colliders));
  colliders.push(...vegetation.colliders);
  return { site, places, sea, ground, roads, roadGraph, elevatedRoads, tunnels, roadLandscape, roadFrontage, roadPaint,
    publicWalk, districts, carriagewayOccupied, deckOccupied, bayPaths, pilotBayPaths, parkBayPaths, waterfrontPaths, urbanPaving, summit, parkOmissions, cbdProgram,
    landmarks, iec, northStation, bridge, yanjiang, themeParks, cityBlocks, lightShow, buildingSigns, buildingDetails,
    streetscape, talentPark, waterfront, trees, vegetation, streetLamps, apecTheme, apecCity, futianStation, xiliConstruction, colliders };
}
