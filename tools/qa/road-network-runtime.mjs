// 用正式图和结构计划导出环境车与自动驾驶共用的有向边。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeCityPayload } from '../../js/sz-data-format.js';

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
  const { Group } = await import('three/webgpu');
  const { planElevatedRoads } = await import('../../js/sz-elevated-roads.js');
  const { createTrafficGraph } = await import('../../js/sz-traffic.js');
  const { createTurnFilter } = await import('../../js/sz-drive-route.js');
  const { buildSzRoadStructures, graphWithRoadStructures } = await import('../../js/sz-road-structures.js');
  const { createGroundSurfaceSampler } = await import('../../js/sz-ground-surface.js');
  const { createCitySpatial } = await import('../../js/sz-spatial.js');
  const { northBridgeProfile } = await import('../../js/sz-rail/geometry.js');
  const packed = readFileSync(process.argv[2] ?? new URL('../../js/sz-city.json.gz', import.meta.url));
  const { geo } = decodeCityPayload(JSON.parse(gunzipSync(packed)));
  const graph = graphWithRoadStructures(geo.roadGraph, geo.roadStructures);
  const exclude = new Set(geo.roadStructures?.records.map(row => row.index));
  const elevated = planElevatedRoads(graph, geo.terrainSurface, { exclude, waterfront: geo.waterfront,
    extraCrossing: northBridgeProfile(geo.shenzhenNorthRail), water: geo.water, isWater: createCitySpatial(geo).isWater });
  const structures = buildSzRoadStructures(new Group(), graph, geo.roadStructures);
  const drive = [...elevated.driveLinks, ...structures.links];
  const network = createTrafficGraph(graph, { elevated: { links: drive }, canTurn: createTurnFilter(graph) });
  const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);
  const orangeNodes = new Set(graph.links.flatMap(([start, end], i) => {
    const { bridge, tunnel, layer } = graph.metadata[i];
    return !tunnel && (bridge || layer > 0) ? [start, end] : [];
  }));
  const groundPortals = [...orangeNodes].map(node => [node, groundHeight(graph.nodes[node * 2], graph.nodes[node * 2 + 1])]);
  console.log(JSON.stringify({ packageSha256: createHash('sha256').update(packed).digest('hex'),
    groundPortals,
    deckSurfaces: [...elevated.links, ...structures.links].map(({ index, surfaceId }) => [index, surfaceId]),
    edges: network.edges.map(edge => [edge.sourceIndex, edge.sign]),
    movements: network.edges.map(edge => [edge.sourceIndex, edge.sign, edge.next.map(next => [next.sourceIndex, next.sign])]),
    legacyGradeConflicts: elevated.links.filter(link => elevated.statistics.gradeConflicts.includes(link.index))
      .map(link => ({ index: link.index, osmId: link.osmId, maxGrade: link.maxGrade })),
    structures: structures.links.map(({ index, osmId, surfaceId, maxGrade }) => ({ index, osmId, surfaceId, maxGrade })) }));
} finally {
  hook.deregister();
}
