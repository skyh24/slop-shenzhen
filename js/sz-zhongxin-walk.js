import * as THREE from 'three/webgpu';
import { polygonBoxOverlaps } from './building-collision.js';
import { buildPublicWalk, createWalkSweep, routeAroundObstacles } from './sz-public-walk.js';
import { createCarriagewayBarrier } from './sz-pedestrian-tracks.js';

const NETWORK = 'zhongxin-2-west';
const BOUNDS = { minX: -540, maxX: -450, minZ: 995, maxZ: 1200 };
const SIDEWALK_SOURCES = ['way/923157990', 'way/853286944', 'way/923157991'];
const FRONTAGE_SOURCES = ['way/1489119789', 'node/5219780653'];
const PERSON_RADIUS_M = 0.48;
const KEEP_RIGHT_M = 0.38;

// 路缘外的样段设计线。道路宽度来自现有断面，外边线和铺装材质为模拟。
const SIDEWALK = [
  [-522, 1006], [-516, 1014], [-512.6, 1023], [-512.6, 1041],
  [-511.7, 1052], [-508.2, 1063], [-502.5, 1075], [-470.4, 1134],
  [-467.2, 1142], [-465.3, 1152], [-463.4, 1171], [-464.1, 1177.4]
];
// OSM 步道端点接入 COCO Park 主入口，福田区活动名录记录东南门。
// 铺装只覆盖门外接驳，源用地内部、门槛及营业时间保持待核。
const FRONTAGE = [[-464.1, 1177.4], [-488.6, 1164.2]];
const ENTRANCE = { id: 'node/5219780653', buildingId: 'way/238825588',
  x: -490.62, z: 1163.08, access: 'public-retail-entrance',
  evidence: 'https://www.szft.gov.cn/bmxx/qwtj/tzgg/content/post_12556615.html' };
// 这两株是样段补植，落在空闲设施带。树池为齐平土面。
const TREES = [
  { id: 'zhongxin-2:tree-1', x: -515.1, z: 1055.4, height: 6.5, crown: 4.1, speciesName: 'camphor' },
  { id: 'zhongxin-2:tree-2', x: -490.9, z: 1101.9, height: 6.9, crown: 4.5, speciesName: 'camphor' }
];
const PLANTER = { x: -477.8, z: 1173.7, width: 1.4, depth: 0.9, height: 0.48 };

function normal(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  return [dz / length, -dx / length];
}

function strip(points) {
  return points.map(([x, z], i) => {
    const before = normal(points[Math.max(0, i - 1)], points[Math.max(1, i)]);
    const after = normal(points[Math.min(i, points.length - 2)], points[Math.min(i + 1, points.length - 1)]);
    const scale = (i === SIDEWALK.length ? 1.45 : 1.55) / (1 + before[0] * after[0] + before[1] * after[1]);
    const dx = (before[0] + after[0]) * scale, dz = (before[1] + after[1]) * scale;
    return [{ x: x + dx, z: z + dz }, { x: x - dx, z: z - dz }];
  });
}

function area(kind, rows, sourceIds) {
  return { id: `${NETWORK}:${kind}`, network: NETWORK, kind, sourceIds, access: 'public',
    heightSource: 'rendered-terrain', boundarySource: 'derived-pilot-strip',
    polygon: { outer: [...rows.map(row => row[0]), ...rows.map(row => row[1]).reverse()], holes: [] } };
}

export function buildZhongxinWalk(scene, graph, terrain, style) {
  // 入口外缘保留约一米缓冲，用于身体扫掠；路线锚点止于源墙面外。
  const points = [SIDEWALK[0], ...SIDEWALK, ...FRONTAGE.slice(1), [-489.65, 1163.65]];
  points[0] = [-522.8, 1004.95];
  const rows = strip(points);
  const seam = SIDEWALK.length;
  const walk = buildPublicWalk(scene, terrain, [
    area('sidewalk', rows.slice(0, seam + 1), SIDEWALK_SOURCES),
    area('frontage', rows.slice(seam), FRONTAGE_SOURCES),
    ...TREES.map(tree => ({
      id: `${tree.id}:pit`, kind: 'tree-pit', access: 'planting', sourceIds: [tree.id],
      heightSource: 'rendered-terrain', boundarySource: 'simulated-placement',
      polygon: { outer: [[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]]
        .map(([dx, dz]) => ({ x: tree.x + dx, z: tree.z + dz })), holes: [] }
    }))
  ], style);
  const anchors = points.slice(1, -1).map(([x, z]) => ({ x, z }));
  const barrier = createCarriagewayBarrier(graph, { bounds: BOUNDS });
  // 布置预约半径只用于模拟设施，源树的位置和身份继续走既有核对流程。
  const tails = anchors.slice(1);
  const reserves = (x, z, radius) => inPilot(x, z) && tails.some((b, i) => {
    const a = anchors[i], dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) < 1.15 + radius;
  });
  const inPilot = (x, z) => x >= BOUNDS.minX && x <= BOUNDS.maxX && z >= BOUNDS.minZ && z <= BOUNDS.maxZ;
  const statistics = { entrance: ENTRANCE.id, connected: false, lengthM: 0, minimumWidthM: 0, planters: 0 };
  return {
    ...walk, pedestrianSurface: { heightAt: walk.heightAt, allows: (x, z, radius) => walk.allows(x, z, radius, NETWORK) },
    entrance: ENTRANCE, bounds: BOUNDS, reserves, inPilot, statistics, trees: TREES,
    placePlanter(colliders, heightAt) {
      const { x, z, width, depth, height } = PLANTER;
      const hx = width / 2, hz = depth / 2, y = heightAt(x, z);
      const reservation = Math.hypot(hx, hz) + 0.25;
      if (!Number.isFinite(y) || reserves(x, z, reservation) || barrier.contains(x, z, reservation)
        || colliders.some(item => item.polygon && item.maxY > y && item.minY < y + height
          && item.minX <= x + hx && item.maxX >= x - hx && item.minZ <= z + hz && item.maxZ >= z - hz
          && polygonBoxOverlaps(item.polygon, x, z, hx, hz))) return null;
      // 示意花箱位于门外通行带外。箱体和栽植顶面同一几何，净空预约另算。
      const stone = new THREE.MeshStandardNodeMaterial({ color: 0x8d8576, roughness: 0.96 });
      const planted = new THREE.MeshStandardNodeMaterial({ color: 0x546947, roughness: 0.96 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), [stone, stone, planted, stone, stone, stone]);
      box.name = `${NETWORK}:planter`;
      box.position.set(x, y + height / 2, z);
      box.castShadow = true;
      box.receiveShadow = true;
      walk.group.add(box);
      statistics.planters++;
      const outer = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([dx, dz]) => ({ x: x + dx, z: z + dz }));
      return { type: 'planter', sourceId: box.name, minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz,
        minY: y, maxY: y + height, polygon: { outer, holes: [] } };
    },
    route(colliders) {
      const clear = createWalkSweep(walk, NETWORK, colliders, barrier, BOUNDS);
      const radius = PERSON_RADIUS_M + KEEP_RIGHT_M;
      const points = routeAroundObstacles(anchors, clear, radius);
      if (!points) return null;
      let minimum = 2.5, length = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        length += Math.hypot(a.x - b.x, a.z - b.z);
        let lo = radius, hi = minimum;
        for (let j = 0; j < 8 && hi - lo > 0.01; j++) {
          const mid = (lo + hi) / 2;
          if (clear(a, b, mid)) lo = mid;
          else hi = mid;
        }
        minimum = Math.min(minimum, lo);
      }
      Object.assign(statistics, { connected: true, lengthM: length, minimumWidthM: minimum * 2 });
      return points.map(({ x, z }) => ({ x, z, y: walk.heightAt(x, z) }));
    }
  };
}
