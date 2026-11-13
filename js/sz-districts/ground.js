import * as THREE from 'three/webgpu';
import { createRoadHeightSampler, createRoadPolygonLayout } from '../sz-roads.js';
import { createPavingMaterial, pavingMesh } from '../sz-paving.js';
import { polygonBoxOverlaps } from '../building-collision.js';
import { distanceToRing, polygonContainsInclusive } from '../sz-polygon.js';
import { createWalkSweep, routeAroundObstacles } from '../sz-public-walk.js';
import { frame, polygon, railing } from './kit.js';

const seaRing = [[-14743.1, 6596.42], [-14726.67, 6582.05], [-14651.07, 6537.01],
  [-14622.55, 6553.12], [-14591, 6560], [-14590, 6590], [-14600, 6620], [-14591, 6642],
  [-14604, 6673], [-14635, 6704], [-14638, 6735], [-14636, 6764], [-14629, 6782],
  [-14625, 6800], [-14649, 6811], [-14666, 6794], [-14683, 6768], [-14710, 6745],
  [-14737, 6714], [-14737, 6707], [-14704.28, 6663.47], [-14688.3, 6634.2],
  [-14715, 6617.11], [-14743.1, 6596.42]];
const octWalk = [[-6816, 397], [-6814, 428], [-6816, 445], [-6829, 432.8], [-6855, 431.3],
  [-6877, 430], [-6894, 430]];
const nantouWalk = [[-14273.06, 289.2], [-14272.9, 248.56], [-14273.16, 203.17],
  [-14274.74, 180.98], [-14277.93, 164.8], [-14280.17, 155.75], [-14283.89, 133.65],
  [-14285.2, 113], [-14286.8, 90], [-14288, 72], [-14290, 41.6]];

const routes = {
  sea: [
    { id: 'sea-world-quay', width: 4.8, points: seaRing,
      sourceIds: ['way/101316008', 'way/248985629', 'way/232497939', 'way/105428777', 'way/386292330', 'way/543176166'] },
    { id: 'sea-world-plaza', width: 5, points: [[-14803, 6570], [-14786, 6581], [-14770, 6587], [-14753, 6595], seaRing[0]],
      sourceIds: ['way/248985586', 'way/105428777'] }
  ],
  oct: [
    { id: 'oct-loft-court', width: 4.2, points: octWalk, sourceIds: ['way/435827458', 'way/435827462'] },
    { id: 'oct-loft-south-lane', width: 3.0, points: [[-6805, 525], [-6807, 506], [-6809, 484]],
      sourceIds: ['way/435827458'] }
  ],
  nantou: [
    { id: 'nantou-south-axis', width: 4.4, points: nantouWalk,
      sourceIds: ['way/1436861799', 'way/1436861800', 'way/317200055'] },
    { id: 'nantou-east-alley', width: 2.8, points: [nantouWalk[7], [-14271, 111.3], [-14256, 109.15]],
      sourceIds: ['way/1050467258'] }
  ]
};

export const DISTRICT_FOCUS = {
  sea: { x: -14665.05, z: 6639.55 }, oct: { x: -6809, z: 436 }, nantou: { x: -14279.05, z: 160.3 }
};

const PAVING = {
  sea: { color: 0xc6baa3, variation: 0xd6ccb8, jointColor: 0xa6a093, tileSizeM: 1.2 },
  oct: { color: 0xa99c89, variation: 0xbcac98, jointColor: 0x8f867b, tileSizeM: 0.83 },
  nantou: { color: 0xa89c85, variation: 0xb9ad98, jointColor: 0x8c8276, tileSizeM: 0.56 }
};

// 这几块是来源路径旁的场地设计边界；通过现有地形三角面及车行掩模裁切。
const plazas = {
  sea: [
    [[-14812, 6565], [-14797, 6555], [-14766, 6572], [-14743, 6596], [-14757, 6604],
      [-14781, 6595], [-14813, 6573]],
    [[-14632, 6551], [-14617, 6548], [-14589, 6557], [-14590, 6588], [-14603, 6591], [-14619, 6563]],
    [[-14607, 6660], [-14587, 6662], [-14588, 6689], [-14612, 6709], [-14638, 6724],
      [-14648, 6703], [-14627, 6683]]
  ],
  oct: [
    [[-6819, 418], [-6808, 418], [-6805, 447], [-6815, 449], [-6834, 436], [-6892, 436],
      [-6895, 425], [-6848, 421], [-6834, 422]]
  ],
  nantou: [
    [[-14299, 295], [-14264, 294], [-14264, 250], [-14291, 251], [-14301, 267]],
    [[-14298, 216], [-14252, 214], [-14252, 193], [-14261, 180], [-14291, 180], [-14300, 195]]
  ]
};

const toPoint = ([x, z]) => ({ x, z });
const distance = (points, x, z) => {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, distanceToRing([points[i - 1], points[i]], x, z));
  return best;
};

function trianglesOf(poly) {
  const rings = [poly.outer, ...poly.holes].map(ring => ring.map(p => new THREE.Vector2(p.x, p.z)));
  const points = rings.flat();
  return THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1))
    .flatMap(face => face.flatMap(index => [points[index].x, points[index].y]));
}

function ribbon(points, half) {
  const sides = points.map(([x, z], i) => {
    const a = points[i - 1] ?? points[i], b = points[i + 1] ?? points[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = (b[1] - a[1]) * half / d, nz = (a[0] - b[0]) * half / d;
    return [[x + nx, z + nz], [x - nx, z - nz]];
  });
  return sides.slice(1).flatMap(([a, b], i) => {
    const [c, d] = sides[i];
    return [c, d, a, a, d, b].flat();
  });
}

export function buildDistrictGround(root, site, activeKinds, roadSurfaces, wet) {
  const rows = [], owned = [];
  for (const kind of activeKinds) {
    const material = createPavingMaterial('concrete', { ...PAVING[kind], depthBias: -2, groutStrength: 0.16 });
    owned.push(material);
    const features = [
      ...routes[kind].map(route => ({ ...route, trianglesXZ: ribbon(route.points, route.width / 2) })),
      ...plazas[kind].map((points, i) => ({ id: `${kind}:court:${i}`, trianglesXZ: trianglesOf(polygon(points)),
        sourceIds: routes[kind][0].sourceIds }))
    ];
    const chunks = features.flatMap(feature => createRoadPolygonLayout(feature, site.terrainSurface, null, roadSurfaces).chunks);
    for (const chunk of chunks) {
      const mesh = pavingMesh(chunk.positions, chunk.origin, material, chunk.id);
      root.add(mesh);
      owned.push(mesh.geometry);
    }
    // 路径条带可能与广场重叠，按地块分别取显示三角面的高度，不用近似地高替代。
    const heightSamplers = features.map(feature => createRoadHeightSampler(
      chunks.filter(chunk => chunk.id.startsWith(`${feature.id}:`)), site.terrainSurface.grid));
    rows.push({ kind, features, heightSamplers, points: routes[kind].map(route => route.points.map(toPoint)) });
  }
  function heightAt(x, z) {
    for (const { kind, heightSamplers } of rows) {
      const focus = DISTRICT_FOCUS[kind];
      if (Math.abs(focus.x - x) > 240 || Math.abs(focus.z - z) > 240) continue;
      for (const sampler of heightSamplers) {
        const y = sampler(x, z);
        if (Number.isFinite(y)) return y;
      }
    }
    return null;
  }
  function reserves(x, z, radius = 0) {
    return rows.some(({ kind, points }) => {
      const f = DISTRICT_FOCUS[kind];
      if (Math.abs(f.x - x) > 250 || Math.abs(f.z - z) > 250) return false;
      if (kind === 'sea' && wet && (polygonContainsInclusive(wet, x, z) || distanceToRing(wet.outer, x, z) < 0.25 + radius)) return true;
      return points.some(line => distance(line, x, z) <= 1.24 + radius);
    });
  }
  function publicRoutes(colliders, road, activeHeightAt) {
    const output = [];
    for (const { kind, points } of rows) {
      const center = DISTRICT_FOCUS[kind];
      const bounds = { minX: center.x - 250, minZ: center.z - 250, maxX: center.x + 250, maxZ: center.z + 250 };
      const local = colliders.filter(b => b.polygon && b.maxX >= bounds.minX && b.minX <= bounds.maxX
        && b.maxZ >= bounds.minZ && b.minZ <= bounds.maxZ);
      const floor = { heightAt: activeHeightAt, allows(x, z, radius) {
        return Number.isFinite(heightAt(x, z)) && (!wet || kind !== 'sea' || !polygonBoxOverlaps(wet, x, z, radius, radius));
      } };
      const sweep = createWalkSweep(floor, kind, local, road, bounds);
      for (const [i, anchors] of points.entries()) {
        const spec = routes[kind][i];
        const validRuns = [];
        let run = [anchors[0]];
        // 车行横断处保留原路；人群轨道在两边各自成段。其余相邻点尝试小幅绕开设施。
        for (let j = 1; j < anchors.length; j++) {
          const leg = routeAroundObstacles([anchors[j - 1], anchors[j]], sweep, 0.89);
          if (leg) run.push(...leg.slice(1));
          else {
            if (run.length > 1) validRuns.push(run);
            run = [anchors[j]];
          }
        }
        if (run.length > 1) validRuns.push(run);
        for (const [j, line] of validRuns.entries()) output.push({
          id: `${spec.id}:${j}`, points: line.map(p => ({ ...p, y: activeHeightAt(p.x, p.z) })),
          walkAt: (x, z) => sweep({ x, z }, { x, z }, 0.48),
          publicHeight: (x, z) => Number.isFinite(heightAt(x, z)) ? activeHeightAt(x, z) : null
        });
      }
    }
    return output;
  }
  return { heightAt, reserves, publicRoutes, routes: Object.fromEntries(rows.map(r => [r.kind, r.points])),
    dispose() { for (const item of owned) item.dispose(); } };
}

export function addBasin(kit, basin, source, y, groundHeight) {
  kit.part({ id: 'sea-world:basin', polygon: basin, minY: y - 0.07, maxY: y, style: 'aqua' }, false);
  for (let i = 0; i < basin.outer.length; i++) {
    const a = basin.outer[i], b = basin.outer[(i + 1) % basin.outer.length];
    const f = frame(a.x, a.z, b.x - a.x, b.z - a.z);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 0.2) continue;
    const mid = f.at(length / 2, 0);
    const h = groundHeight(mid.x, mid.z) ?? 7.88;
    // 连续石质收边位于水陆裁切线上，顶部只露出一条窄边。
    kit.box(mid, y - 0.16, h + 0.085, length + 0.06, 0.27, f, 'stone', source, `sea-world:coping:${i}`);
    if (i % 3 === 0) {
      kit.piece(mid, h + 0.103, Math.min(length * 0.58, 3.1), 0.035, 0.11, f, 'lamp');
    }
  }
  // 参考水景中的喷泉设备环；水面与水位仍是派生场景参数。
  const f = frame(-14664, 6725, 0.57, -0.82);
  for (const [u, v, r] of [[0, 0, 8.8], [24, -8, 6.5], [-26, 5, 6.8]]) {
    for (let i = 0; i < 24; i++) {
      const a = Math.PI * 2 * i / 24;
      const p = f.at(u + Math.cos(a) * r, v + Math.sin(a) * r);
      if (polygonContainsInclusive(basin, p.x, p.z)) kit.piece(p, y + 0.04, 0.35, 0.15, 0.35, f,
        i % 3 ? 'silver' : 'lamp', { shape: 'cylinder' });
    }
  }
}

export function addFixtures(kit, source, style, sites, groundHeight, allowed) {
  for (const [x, z, type, yaw = 0] of sites) {
    const y = groundHeight(x, z);
    const radius = type === 'lamp' ? 0.35 : type === 'table' ? 1.25 : 1.1;
    if (!Number.isFinite(y) || !allowed({ x, z }, y, type === 'lamp' ? 3.5 : 1.2, null, radius)) continue;
    const f = frame(x, z, Math.cos(yaw), Math.sin(yaw));
    if (type === 'lamp') {
      kit.box(f.at(0, 0), y - 0.04, y + 2.98, 0.18, 0.18, f, style, source);
      kit.piece(f.at(0, 0), y + 3.06, 0.42, 0.25, 0.42, f, 'lamp', { detail: false });
      kit.piece(f.at(0, 0), y + 3.24, 0.57, 0.12, 0.57, f, style);
      kit.lamp(f.at(0, 0), y + 2.88, 27, 9);
    } else if (type === 'flowers') {
      kit.box(f.at(0, 0), y - 0.04, y + 0.37, 2.1, 1.24, f, 'granite', source);
      kit.piece(f.at(0, 0), y + 0.38, 1.91, 0.04, 1.04, f, 'soil', { detail: false });
      for (let i = 0; i < 19; i++) {
        const p = f.at((i % 7 - 3) * 0.265 + (i % 2 ? 0.08 : 0), (Math.floor(i / 7) - 1) * 0.28);
        const h = 0.20 + (i * 7 % 11) * 0.013;
        kit.piece(p, y + 0.37 + h / 2, 0.17, h, 0.19, f, 'leaf', { shape: 'cylinder' });
        kit.piece(p, y + 0.38 + h, 0.14, 0.085, 0.14, f, i % 3 === 0 ? 'goldFlower' : 'blossom',
          { shape: 'cylinder' });
      }
    } else if (type === 'table') {
      kit.box(f.at(0, 0), y, y + 0.73, 0.14, 0.14, f, 'steel', source);
      kit.box(f.at(0, 0), y + 0.72, y + 0.80, 0.83, 0.74, f, 'wood', source);
      for (const side of [-1, 1]) {
        kit.box(f.at(0.73 * side, 0), y, y + 0.44, 0.30, 0.28, f, 'steel', source);
        kit.box(f.at(0.73 * side, 0), y + 0.42, y + 0.49, 0.42, 0.38, f, style, source);
      }
    } else if (type === 'art') {
      kit.box(f.at(0, 0), y - 0.04, y + 0.32, 2.10, 1.92, f, 'concrete', source);
      for (const [i, angle] of [[0, 0], [1, 0.52], [2, 1.04]]) {
        const off = f.at(i * 0.21 - 0.21, 0);
        kit.piece(off, y + 1.2 + i * 0.24, 1.66 - i * 0.31, 1.51 + i * 0.25, 0.11,
          frame(off.x, off.z, Math.cos(angle), Math.sin(angle)), i === 1 ? 'orange' : 'terra', { shape: 'disc' });
      }
      kit.box(f.at(0, 0), y + 0.32, y + 2.58, 1.78, 0.24, f, 'terra', source);
    } else {
      for (const sign of [-1, 1]) kit.box(f.at(sign * 0.70, 0), y - 0.02, y + 0.44, 0.22, 0.46, f, style, source);
      kit.box(f.at(0, 0), y + 0.41, y + 0.52, 1.91, 0.53, f, 'wood', source);
      kit.piece(f.at(0, -0.24), y + 0.71, 1.9, 0.30, 0.08, f, 'wood');
      railing(kit, f, y + 0.45, -0.87, 0.87, -0.26, style, { height: 0.30 });
    }
  }
}

export function addWalkLamps(kit, source, style, lines, groundHeight, allowed) {
  const selected = [];
  for (const line of lines) {
    let next = 12;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      for (; next < length; next += 21) {
        const f = frame(a.x, a.z, dx, dz);
        for (const side of [-1, 1]) {
          for (const offset of [3.1, 4.0, 4.8]) {
            const p = f.at(next, side * offset);
            const y = groundHeight(p.x, p.z);
            if (!Number.isFinite(y) || !allowed(p, y, 3.5, null, 0.43)
              || selected.some(q => Math.hypot(p.x - q[0], p.z - q[1]) < 4.2)) continue;
            selected.push([p.x, p.z, 'lamp']);
            break;
          }
        }
      }
      next -= length;
    }
  }
  addFixtures(kit, source, style, selected, groundHeight, allowed);
}

export function addLowFence(kit, source, lines, heightAt, allowed) {
  for (const [a, b] of lines) {
    const f = frame(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.3);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) / n;
    for (let i = 0; i < n; i++) {
      const p = f.at((i + 0.5) * length, 0);
      const y = heightAt(p.x, p.z);
      if (!Number.isFinite(y) || ![i * length, (i + 0.5) * length, (i + 1) * length].every(u =>
        allowed(f.at(u, 0), y, 0.66, source.id, 0.23))) continue;
      kit.box(p, y + 0.49, y + 0.58, length + 0.025, 0.075, f, 'green', source);
      kit.box(f.at(i * length, 0), y - 0.035, y + 0.61, 0.09, 0.10, f, 'green', source);
      kit.piece(p, y + 0.30, length + 0.025, 0.041, 0.047, f, 'green');
      if (i === n - 1) kit.box(f.at((i + 1) * length, 0), y - 0.035, y + 0.61, 0.09, 0.10, f, 'green', source);
    }
  }
}
