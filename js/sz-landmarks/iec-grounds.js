// 香蜜湖一期外部空间。公共模拟只覆盖红荔西路市政路侧；会场前场及规划园路不接入行人网络。
import * as THREE from 'three/webgpu';
import { polygonContains } from '../building-collision.js';
import { pavingMesh } from '../sz-paving.js';
import { GeoBuilder } from '../sz-geometry.js';
import { createRoadHeightSampler, createRoadPolygonLayout } from '../sz-roads.js';
import { buildSzSea } from '../sz-sea.js';
import { terrainHeight } from '../sz-terrain.js';
import { createIecMaterial, entry, entryPoint, siteId } from './iec-xiangmihu.js';

const prefix = siteId + ':';
const coordinates = pairs => pairs.map(([x, z]) => ({ x, z }));

function stripRing(points, halfWidth) {
  const offset = side => points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: p.x - side * halfWidth * (b.z - a.z) / length,
      z: p.z + side * halfWidth * (b.x - a.x) / length };
  });
  return [...offset(1), ...offset(-1).reverse()];
}

function ellipse(x, z, rx, rz) {
  return Array.from({ length: 32 }, (_, i) => {
    const angle = 2 * Math.PI * i / 32;
    return { x: x + rx * Math.cos(angle), z: z + rz * Math.sin(angle) };
  });
}

function drawGround(group, terrain, id, sourceIds, ring, material, exclusionChunks) {
  const projected = ring.map(({ x, z }) => new THREE.Vector2(x, z));
  const trianglesXZ = THREE.ShapeUtils.triangulateShape(projected, [])
    .flatMap(indices => indices.flatMap(i => [ring[i].x, ring[i].z]));
  const layout = createRoadPolygonLayout({ id, sourceIds, trianglesXZ }, terrain, null, exclusionChunks);
  for (const chunk of layout.chunks) group.add(pavingMesh(chunk.positions, chunk.origin, material, chunk.id));
  return createRoadHeightSampler(layout.chunks, terrain.grid);
}

function drawShore(group, polygon, terrain, waterY, material, name) {
  const batch = new GeoBuilder();
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.01) continue;
      const nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length;
      // 细分到小于地形网格，岸壁略伸入土体并没入水面，覆盖源地形裁边。
      const steps = Math.ceil(length / 3);
      const start = batch.count;
      for (let j = 0; j <= steps; j++) {
        const x = a.x + (b.x - a.x) * j / steps, z = a.z + (b.z - a.z) * j / steps;
        const top = terrainHeight(terrain, x, z);
        batch.vertex(x, Math.max(top ?? waterY, waterY) + 0.02, z, nx, 0, nz, j, 1);
        batch.vertex(x, waterY - 0.15, z, nx, 0, nz, j, 0);
        if (j === 0) continue;
        const k = start + j * 2;
        batch.tri(k - 2, k - 1, k);
        batch.tri(k, k - 1, k + 1);
      }
    }
  }
  const mesh = new THREE.Mesh(batch.build(), material);
  mesh.name = name;
  mesh.receiveShadow = true;
  group.add(mesh);
}

export function buildIecGrounds(scene, { terrain, terrainSurface, groundHeight, roadHeight, roadSurfaces, sites, water, paths = [] }) {
  const { site, lake, lakePark, reflectingPool } = sites?.[siteId] ?? {};
  if (!site?.polygons?.length || !lake?.polygons?.length || !lakePark?.polygons?.length) return null;
  const group = new THREE.Group();
  group.name = 'ShenzhenLandmarkGrounds:' + siteId;
  const paved = createIecMaterial('iecPlaza');
  paved.polygonOffset = true;
  paved.polygonOffsetFactor = -2;
  paved.polygonOffsetUnits = -2;
  const green = createIecMaterial('iecGreen');
  green.polygonOffset = true;
  green.polygonOffsetFactor = -1;
  green.polygonOffsetUnits = -1;
  const bank = new THREE.MeshStandardNodeMaterial({ color: 0x67674f, roughness: 0.96, side: THREE.DoubleSide });
  const walkPath = paths.find(path => path.access === 'public-roadside');
  const parkPath = paths.find(path => path.access === 'unverified');
  const sidewalk = walkPath && coordinates(walkPath.points);
  const buildPath = (path, name) => path
    ? drawGround(group, terrainSurface, prefix + name, [path.osmId],
      stripRing(coordinates(path.points), path.widthM / 2), paved, roadSurfaces)
    : () => null;
  const walkHeight = buildPath(walkPath, 'hongli-sidewalk');
  const forecourt = drawGround(group, terrainSurface, prefix + 'entry-forecourt', [site.osmId],
    [entryPoint(-26, -1), entryPoint(26, -1), entryPoint(20, 21), entryPoint(-19, 22)], paved, roadSurfaces);
  // 总图为指引性布局。临湖园路和草坪随源地形，开放状态待确认。
  const parkHeight = buildPath(parkPath, 'park-path');
  drawGround(group, terrainSurface, prefix + 'lake-forecourt-lawn', [lakePark.osmId],
    ellipse(-2950, -153, 18, 30), green, roadSurfaces);
  drawGround(group, terrainSurface, prefix + 'south-lawn', [site.osmId],
    ellipse(-3018, 53, 16, 8), green, roadSurfaces);

  // 用裁地时的同一水体环。两处缺竣工水位，各自按岸线最低地面派生。
  const waters = [];
  for (const [name, feature, insetM] of [['lake', lake, 0.3], ['reflecting-pool', reflectingPool, 0.16]]) {
    if (!feature?.polygons?.length) continue;
    const first = feature.polygons[0].outer[0];
    const shore = water?.find(polygon => polygon.outer.some(p => p.x === first.x && p.z === first.z))
      ?? feature.polygons[0];
    const levels = shore.outer.map(p => terrainHeight(terrain, p.x, p.z)).filter(Number.isFinite);
    if (!levels.length) continue;
    const heightM = Math.min(...levels) - insetM;
    waters.push(buildSzSea(group, { polygons: [shore], heightM, source: { osmId: feature.osmId, heightSource: 'estimate' } },
      { name: prefix + name, coastal: false }));
    drawShore(group, shore, terrain, heightM, bank, prefix + name + ':shore');
  }
  scene.add(group);

  const publicHeight = (x, z) => {
    const y = walkHeight(x, z);
    return y === null || Number.isFinite(roadHeight(x, z)) ? null : y;
  };
  function relocateLamp(lamp) {
    if (lamp.median || !Number.isFinite(walkHeight(lamp.x, lamp.z))) return lamp;
    // 合成路灯移到路侧净通行带外，保持灯臂朝向车行道。
    const dx = -Math.cos(lamp.yaw), dz = Math.sin(lamp.yaw);
    for (const distance of [1.8, 2.4, 3, 3.6]) {
      const x = lamp.x + dx * distance, z = lamp.z + dz * distance;
      if (!Number.isFinite(groundHeight(x, z))) continue;
      if (Number.isFinite(walkHeight(x - dx * 0.4, z - dz * 0.4))) continue;
      return { ...lamp, x, z };
    }
    return null;
  }
  const sceneryAt = (x, z) => Number.isFinite(publicHeight(x, z) ?? forecourt(x, z) ?? parkHeight(x, z));
  const flower = { x: -3119, z: 76 };
  const sign = entryPoint(-19, 13);
  const groundAnchor = point => ({ ...point, baseY: groundHeight(point.x, point.z) });
  const anchors = {
    iecGate: { ...groundAnchor(sign), yaw: entry.yaw, widthM: 4.8, mountM: 1.1 },
    iecFlowerSea: { ...groundAnchor(flower), radiusXM: 4, radiusZM: 2.5, conform: true },
    iecFlags: [-10, -6, 6, 10].map(u => groundAnchor(entryPoint(u, 13))),
    iecRobotSites: {
      iecGate: { ...groundAnchor(entryPoint(18, 16)), radiusXM: 1.8, radiusZM: 1.0 },
      iecFlowerSea: { ...groundAnchor({ x: flower.x - 6, z: flower.z }), radiusXM: 1.7, radiusZM: 1.0 }
    }
  };

  return {
    group, anchors, sceneryAt, relocateLamp, walk: sidewalk && { id: walkPath.osmId, points: sidewalk, heightAt: publicHeight },
    blockGenericWalk: (x, z) => x >= -3400 && x <= -2760 && z >= -337 && z <= 145
      && (site.polygons.some(polygon => polygonContains(polygon, x, z))
      || Number.isFinite(publicHeight(x, z)) || Number.isFinite(parkHeight(x, z))),
    dispose() {
      for (const surface of waters) surface.dispose();
      group.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
      for (const material of [paved, green, bank]) material.dispose();
      group.removeFromParent();
    }
  };
}
