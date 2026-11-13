import { spatialIndex } from './sz-spatial.js';
import { isWater, nearRoadsForFrontage } from './sz-city-config.js';
import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { createSceneStyle } from './sz-scene-style.js';
import { createGroundSurfaceSampler, buildSzGround } from './sz-ground.js';
import { createBayPathLookup } from './sz-bay-waterfront.js';
import { createWaterfrontPaths } from './sz-waterfront.js';
import { buildSzSea } from './sz-sea.js';
import { buildSzRoads, planStreetTreeSides } from './sz-roads.js';
import { buildSzRoadFrontage } from './sz-road-frontage.js';
import { buildSzRoadPaint } from './sz-road-paint.js';
import { createRoadBuildingClearance } from './sz-road-building-clearance.js';
import { createSurfaceResolver } from './sz-controller-surfaces.js';
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
import { buildLianhuashanSummit, reviewedParkOmissions, SUMMIT_ARRIVAL } from './sz-lianhuashan.js';
import { buildIecGrounds } from './sz-landmarks/iec-grounds.js';
import { buildNorthStation } from './sz-rail/station.js';
import { northBridgeProfile } from './sz-rail/geometry.js';
import { buildFutianStation, buildXiliConstruction } from './sz-station-sites.js';
import { buildSzLandmarks } from './sz-landmarks/index.js';
import { buildSzDistricts } from './sz-districts/index.js';
import { buildThemeParks } from './sz-theme-parks/index.js';
import { buildShenzhenBayBridge, buildYanjiangExpressway } from './sz-landmarks/shenzhen-bay-bridge.js';
import { buildSzElevatedRoads } from './sz-elevated-roads.js';
import { buildSzRoadStructures, graphWithRoadStructures } from './sz-road-structures.js';
import { buildRoadLandscape } from './sz-road-landscape.js';
import { terrainHeight } from './sz-terrain.js';
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
  const roadGraph = graphWithRoadStructures(GEO.roadGraph, GEO.roadStructures);
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
      parkFootbridges: GEO.talentPark?.footbridges, water: GEO.water, exclude: new Set(GEO.roadStructures?.records.map(row => row.index)) }));
  const carriagewayOccupied = createCarriagewayBarrier(roadGraph).contains;
  const bayPaths = createBayPathLookup(GEO.shenzhenBay?.paths);
  const roadStructures = qa.measureBuild('roadStructures', () => buildSzRoadStructures(scene, roadGraph, GEO.roadStructures, {
    groundHeight: (x, z) => terrainHeight(GEO.terrain, x, z),
    pierAllowed: (x, z, radius) => !carriagewayOccupied(x, z, radius + 4)
      && !bayPaths(x, z, radius + 4).length && isWater(x, z) === false
  }));
  const roadLandscape = qa.measureBuild('roadLandscape', () =>
    buildRoadLandscape(scene, GEO.roadStructures?.landscape, GEO.terrainSurface, ground.groundHeight));
  const roadFrontage = qa.measureBuild('frontage', () =>
    buildSzRoadFrontage(scene, GEO.roadFrontage, roadGraph, GEO.terrainSurface, site));
  const roadPaint = !offline && qa.stage('paint', () =>
    buildSzRoadPaint(scene, roadGraph, { ...site, intersections: roadFrontage.control.intersections,
      frontage: GEO.roadFrontage, decks: [...elevatedRoads.links, ...roadStructures.links] }));
  const publicWalk = buildZhongxinWalk(scene, site.roadGraph, site.terrainSurface, site.style);
  site.heightAt = (x, z) => roadLandscape.pathHeight(x, z) ?? roadFrontage.contactHeight(x, z) ?? publicWalk.heightAt(x, z) ?? ground.groundHeight(x, z);
  const districts = qa.measureBuild('districts', () => buildSzDistricts(scene, site,
    { water: GEO.water, roads: roads.surfaces, carriagewayOccupied }));
  const baseHeight = site.heightAt;
  site.heightAt = (x, z) => districts.heightAt(x, z) ?? baseHeight(x, z);
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
  const districtHeightAt = site.heightAt;
  if (northStation) site.heightAt = (x, z) => northStation.heightAt(x, z) ?? districtHeightAt(x, z);
  const bridge = !offline && buildShenzhenBayBridge(scene, GEO.bridges.find(item => item.id === 'shenzhen-bay-bridge'));
  const yanjiang = !offline && buildYanjiangExpressway(scene, GEO.yanjiangExpressway,
    new Set(roadStructures.links.map(link => Number(link.osmId.split('/')[1]))));
  const themeParks = qa.stage('themeParks', () => buildThemeParks(scene, { ...site, mapRegions: GEO.mapRegions }));
  markInit('landmarks');
  await showLoadingStage(startup.blocks, 'blocks');
  const sceneSkipIds = new Set([...landmarks.skipIds, ...districts.skipIds, ...themeParks.skipIds, ...parkOmissions]);
  // 门槛接入现有铺装三角面、专项人行道或路侧步行面。
  const pavedHeight = createGroundSurfaceSampler(site.terrainSurface, kind => kind === 3 || kind === 4 || kind === 7);
  const retail = {
    regions: GEO.mapRegions?.regions, nearRoads: nearRoadsForFrontage, carriageway: carriagewayOccupied,
    entrance: publicWalk.entrance,
    pavementAt: (x, z) => publicWalk.heightAt(x, z) ?? roadFrontage.contactHeight(x, z) ?? pavedHeight(x, z)
  };
  const cityBlocks = qa.stage('blocks', () =>
    buildCityBlocks(scene, { skipIds: sceneSkipIds, renderChunkSize: qa.chunkSize, retail,
      programEmission: cbdProgram.emission, programParticipant: isCbdProgramBuilding,
      roadClearance: createRoadBuildingClearance(site.roadGraph, site.roadHeight, elevatedRoads.links) }));
  const detailSkipIds = new Set([...sceneSkipIds, ...(cityBlocks.duplicateIds?.keys() ?? []),
    ...(cityBlocks.roadConflicts ?? []).map(row => row.buildingId)]);
  // 福田中心区夜景灯光秀：只给已建成普通高层加灯带，颜色/节奏为展示估计；白天隐藏。
  // 地标源对象已由专模打光，排除它们；地标外露钢架（平安 8 根巨柱）单独沿柱轴生成灯带。
  const landmarkBands = !offline && planLandmarkBands(landmarks.colliders);
  const lightShow = !offline && qa.stage('lightshow', () =>
    buildSzLightShow(scene, { buildings: site.buildings, terrain: site.terrain,
      excludeIds: detailSkipIds, landmarkBands, isProgramActive: () => cbdProgram.active }));
  const buildingSigns = !offline && qa.stage('signs', () =>
    buildBuildingSigns(scene, { buildings: cityBlocks.allBlocks, roadGraph: site.roadGraph }));
  // 近景补足屋顶和立面细节，避开基础屋顶已绘制的构件。
  const buildingDetails = !offline && qa.stage('details', () =>
    buildBuildingDetails(scene, { ...site, skipIds: detailSkipIds, roofPlans: cityBlocks.roofPlans,
      retailBuildingIds: cityBlocks.retailBuildingIds, envelopePlans: cityBlocks.envelopePlans }));
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
  const exposedStructures = new Set(roadStructures.links.filter(link => !link.tunnel).map(link => link.surfaceId));
  const openTunnels = roadStructures.links.filter(link => link.exposedTriangles.length)
    .map(link => ({ id: link.surfaceId, heightSource: 'estimate', triangles: link.exposedTriangles }));
  const deck = createSurfaceResolver({ groundHeight: () => null, surfaces: [...elevatedRoads.surfaces,
    ...roadStructures.surfaces.filter(surface => exposedStructures.has(surface.id)), ...openTunnels] });
  for (const surface of openTunnels) exposedStructures.add(surface.id);
  const deckOccupied = (x, z, bottom, top) => deck.at(x, z).some(surface => surface.height + 4.5 > bottom
    && surface.height - (exposedStructures.has(surface.surfaceId) ? GEO.roadStructures.bridgeSlabM : 0.35) < top);
  // 树灯按完整底座避让与沥青网格同源的车行范围，路口补面也参与。
  const treeSite = {
    ...site, carriagewayOccupied, deckOccupied, excludedSite: themeParks.reserved, woodlandTrees: planWoodlandTrees(), simulatedPathAt: iec?.sceneryAt, roadFrontage: GEO.roadFrontage,
    reserveWalk: (x, z, r) => publicWalk.reserves(x, z, r) || waterfront?.reserves(x, z, r)
      || northStation?.reserves(x, z, r) || districts.reserves(x, z, r) || landmarks.reservesApproach?.(x, z, r) || urbanPaving.reserves(x, z, r) || waterfrontPaths.reserves(x, z, r) || roadLandscape.walkAt(x, z, r).length > 0 || roadFrontage.reserveWalk(x, z, r),
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
    reserveWalk: (x, z, r) => urbanPaving.reserves(x, z, r) || waterfrontPaths.reserves(x, z, r)
      || site.reserveBayWalk(x, z, r) || waterfront?.reserves(x, z, r),
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
    ...elevatedRoads.colliders, ...roadStructures.colliders, ...(talentPark.plan?.colliders ?? [])];
  const planter = publicWalk.placePlanter(colliders, site.heightAt);
  if (planter) colliders.push(planter);
  const vegetation = qa.measureBuild('vegetation', () => buildVegetationPilots(scene, GEO, {
    ...treeSite, colliders, pavedAt: retail.pavementAt, nearRoads: nearRoadsForFrontage,
    reserveWalk: (x, z, r) => treeSite.reserveWalk(x, z, r) || site.reserveBayWalk(x, z, r)
  }, trees.colliders));
  colliders.push(...vegetation.colliders);
  return { site, sea, ground, roads, roadGraph, elevatedRoads, roadStructures, roadLandscape, roadFrontage, roadPaint,
    publicWalk, districts, carriagewayOccupied, bayPaths, waterfrontPaths, urbanPaving, summit, parkOmissions, cbdProgram,
    landmarks, iec, northStation, bridge, yanjiang, themeParks, cityBlocks, lightShow, buildingSigns, buildingDetails,
    streetscape, talentPark, waterfront, trees, vegetation, streetLamps, apecTheme, apecCity, futianStation, xiliConstruction, colliders };
}
