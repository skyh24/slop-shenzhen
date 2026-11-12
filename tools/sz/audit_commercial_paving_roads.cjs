const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('../../tests/helpers/module.cjs');

// 只调用生产道路裁切函数。审计读取生成的三角面，无需创建浏览器或材质。
const { createRoadSurfaceLayout } = loadModule(readFileSync(join(__dirname, '../../js/sz-roads.js'), 'utf8'), {
  imports: { 'three/webgpu': {}, './sz-road-material.js': {} }
});
const { roadGraph, terrainSurface } = JSON.parse(readFileSync(0, 'utf8'));
const [minX, minZ, maxX, maxZ] = JSON.parse(process.argv[2]);
const toRenderPosition = process.argv[3] === '--batched' ? Math.fround : value => value;
const size = terrainSurface.chunkSize;
const triangles = [];
for (const { origin: [ox, oz], positions } of createRoadSurfaceLayout(roadGraph, terrainSurface).chunks) {
  if (ox + size < minX || ox > maxX || oz + size < minZ || oz > maxZ) continue;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = toRenderPosition(ox + positions[i]), az = toRenderPosition(oz + positions[i + 2]);
    const bx = toRenderPosition(ox + positions[i + 3]), bz = toRenderPosition(oz + positions[i + 5]);
    const cx = toRenderPosition(ox + positions[i + 6]), cz = toRenderPosition(oz + positions[i + 8]);
    if (Math.max(ax, bx, cx) < minX || Math.min(ax, bx, cx) > maxX
      || Math.max(az, bz, cz) < minZ || Math.min(az, bz, cz) > maxZ) continue;
    triangles.push([[ax, az], [bx, bz], [cx, cz]]);
  }
}
process.stdout.write(JSON.stringify(triangles));
