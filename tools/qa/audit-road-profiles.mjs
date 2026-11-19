// 读取正式图和结构计划，输出最终断面坡度、接缝及现行车行资格。
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeCityPayload, readCityPayload } from '../../js/sz-data-format.js';

const three = process.env.SZ_THREE_PACKAGE_DIR
  ? pathToFileURL(resolve(process.env.SZ_THREE_PACKAGE_DIR) + '/')
  : new URL('../../.agents/three-0.187.0/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', three)));
if (pkg.version !== '0.187.0') throw new Error('Road audit requires Three.js 0.187.0');
const aliases = { three: 'build/three.webgpu.js', 'three/webgpu': 'build/three.webgpu.js',
  'three/tsl': 'build/three.tsl.js' };
const hook = registerHooks({ resolve(specifier, context, next) {
  const file = aliases[specifier] ?? (specifier.startsWith('three/addons/') ? `examples/jsm/${specifier.slice(13)}` : null);
  return next(file ? new URL(file, three).href : specifier, context);
} });
try {
  const { ELEVATED_DRIVE_MAX_GRADE, planElevatedRoads } = await import('../../js/sz-elevated-roads.js');
  const { TUNNEL_DRIVE_MAX_GRADE, planSzTunnels } = await import('../../js/sz-tunnels.js');
  const { createGroundSurfaceSampler } = await import('../../js/sz-ground-surface.js');
  const { createCitySpatial } = await import('../../js/sz-spatial.js');
  const { northBridgeProfile } = await import('../../js/sz-rail/geometry.js');
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const [packagePath = new URL('../../js/sz-city.szc.gz', import.meta.url), ...ids] = args.filter(arg => arg !== '--all');
  const raw = await readCityPayload(packagePath, path => new Response(readFileSync(path)));
  const { geo } = decodeCityPayload(raw);
  // 与运行时同源：源图不再并入审核结构，桥面由通用剖面派生，隧道由全城洞身派生。
  const { applyCorridorRoadProfiles } = await import('../../js/sz-interchange-levels.js');
  const graph = applyCorridorRoadProfiles(geo.roadGraph, geo.terrainSurface, geo.roadStructures);
  const isWater = createCitySpatial(geo).isWater;
  const elevated = planElevatedRoads(graph, geo.terrainSurface, { waterfront: geo.waterfront,
    extraCrossing: northBridgeProfile(geo.shenzhenNorthRail), parkFootbridges: geo.talentPark?.footbridges,
    water: geo.water, isWater });
  const tunnels = planSzTunnels(graph, geo.terrainSurface, { wholeCity: true, water: geo.water, isWater });
  const drive = [...elevated.driveLinks, ...tunnels.drive.links];
  const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);

  if (!ids.length) ids.push('40933268', '25543388');
  const wanted = new Set(ids.map(id => id.includes('/') ? id : 'way/' + id));
  const driveIndices = new Set(drive.map(link => link.index));
  const summarize = (link, kind, gradeLimit) => ({
    kind, index: link.index, osmId: link.osmId, name: link.name, layer: link.layer,
    heightSource: 'estimate',
    lengthM: link.lengthM, start: graph.nodeIds?.[link.startNode], end: graph.nodeIds?.[link.endNode],
    coordinates: [link.frames?.[0], link.frames?.at(-1)].map(f => [f?.x, f?.z]),
    shared: [link.sharedStart, link.sharedEnd], elevation: [link.startDeckY, link.endDeckY],
    ground: [link.startGroundHeight, link.endGroundHeight],
    drivable: driveIndices.has(link.index), routingGrade: link.maxGrade, gradeLimit,
    clearanceM: link.clearanceM, boreLengthM: link.boreLengthM,
    portalSpans: link.portalSpans, blockedReason: link.blockedReason,
    profile: link.gradeProfile,
    stations: process.env.SZ_PROFILE_STATIONS ? link.frames?.filter((_, i) => i < 30 || i > link.frames.length - 30)
      .map(f => [f.d, f.y ?? f.floorY, f.groundY ?? groundHeight(f.x, f.z), f.sink]) : undefined
  });
  const include = link => all || wanted.has(link.osmId);
  const matches = [
    ...elevated.links.filter(include).map(link => summarize(link, 'bridge', ELEVATED_DRIVE_MAX_GRADE)),
    ...tunnels.links.filter(include).map(link => summarize(link, 'tunnel', TUNNEL_DRIVE_MAX_GRADE))
  ];
  const finalGradeConflicts = {
    bridge: elevated.statistics.finalProfileGradeConflicts.length,
    tunnel: tunnels.statistics.finalProfileGradeConflicts.length
  };
  console.log(JSON.stringify({
    drive: [elevated.driveLinks.length, tunnels.drive.links.length], finalGradeConflicts, matches
  }, (_, value) => value === Infinity ? 'Infinity' : value, 2));
} finally {
  hook.deregister();
}
