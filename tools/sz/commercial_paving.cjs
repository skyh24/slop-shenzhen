const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('../../tests/helpers/module.cjs');

// 与运行时沥青复用断面、弯道、路口补面和上下层过滤。
const { visitGroundRoadFootprints } = loadModule(readFileSync(join(__dirname, '../../js/sz-roads.js'), 'utf8'), {
  imports: { 'three/webgpu': {}, './sz-road-material.js': {} }
});
const graph = JSON.parse(readFileSync(0, 'utf8'));
const [minX, minZ, maxX, maxZ] = JSON.parse(process.argv[2]);
const footprints = [];
visitGroundRoadFootprints(graph, (points, linkIndices) => {
  const xs = points.map(point => point.x);
  const zs = points.map(point => point.z);
  if (Math.max(...xs) <= minX || Math.min(...xs) >= maxX
    || Math.max(...zs) <= minZ || Math.min(...zs) >= maxZ) return;
  footprints.push({
    ring: points.map(({ x, z }) => [x, z]),
    osmIds: [...new Set(linkIndices.map(index => graph.metadata[index].osmId))].sort()
  });
});
process.stdout.write(JSON.stringify(footprints));
