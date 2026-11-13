import { polygonContains, ringArea } from './sz-polygon.js';
import { triangulateFootprint } from './sz-geometry.js';

// 已核对共面关系的源对象。顺序决定外法线相同的共享墙由哪个对象出面。
const REVIEWED_GROUPS = [
  ['way/533679865', 'way/533679860', 'way/533679861', 'way/533679862', 'way/533679863', 'way/533679864'],
  ['way/238825588', 'way/539435437']
];
const EPSILON = 1e-7;
const PROBE_M = 1e-5;
const cross = (ax, az, bx, bz) => ax * bz - az * bx;

function bounds(polygon) {
  return polygon.outer.reduce((b, p) => ({
    minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
    minZ: Math.min(b.minZ, p.z), maxZ: Math.max(b.maxZ, p.z)
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function overlaps(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function uniqueCuts(cuts) {
  return cuts.sort((a, b) => a - b).filter((value, i) => i === 0 || value - cuts[i - 1] > EPSILON);
}

function addEdgeCuts(cuts, polygon, ax, az, ux, uz, length) {
  for (const ring of [polygon.outer, ...(polygon.holes ?? [])]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const px = p.x - ax, pz = p.z - az, qx = q.x - ax, qz = q.z - az;
      const d = cross(ux, uz, px, pz), e = cross(ux, uz, qx, qz);
      const u = ux * px + uz * pz, v = ux * qx + uz * qz;
      if (Math.abs(d) < EPSILON && u > EPSILON && u < length - EPSILON) cuts.push(u);
      if (d * e < 0) {
        const t = u + (v - u) * d / (d - e);
        if (t > EPSILON && t < length - EPSILON) cuts.push(t);
      }
    }
  }
}

function clipWall(neighbours, order, ax, az, bx, bz, nx, nz, length, minY, maxY, parapet = false) {
  const active = neighbours.filter(row => row.minY < maxY && row.maxY > minY);
  if (!active.length) return null;
  const ux = (bx - ax) / length, uz = (bz - az) / length;
  const cuts = [0, length];
  for (const { polygon } of active) addEdgeCuts(cuts, polygon, ax, az, ux, uz, length);
  const xs = uniqueCuts(cuts);
  const slices = [];
  let changed = false;
  for (let i = 1; i < xs.length; i++) {
    const u0 = xs[i - 1], u1 = xs[i], middle = (u0 + u1) / 2;
    const x = ax + ux * middle, z = az + uz * middle;
    const hidden = [];
    for (const row of active) {
      // 外侧已有实体时是内部界面。同向共边由来源优先级决定，女儿墙还要避开内侧塔楼。
      const outer = polygonContains(row.polygon, x + nx * PROBE_M, z + nz * PROBE_M);
      const inner = (parapet || row.order < order)
        && polygonContains(row.polygon, x - nx * PROBE_M, z - nz * PROBE_M);
      if (outer || inner) hidden.push([Math.max(minY, row.minY), Math.min(maxY, row.maxY)]);
    }
    let bottom = minY;
    for (const [lower, upper] of hidden.sort((a, b) => a[0] - b[0])) {
      changed = true;
      if (lower - bottom > EPSILON) slices.push({ u0, u1, y0: bottom, y1: lower });
      bottom = Math.max(bottom, upper);
    }
    if (maxY - bottom > EPSILON) slices.push({ u0, u1, y0: bottom, y1: maxY });
  }
  return changed ? slices : null;
}

// 用足迹三角形做凸裁切，凹边和内院由同一套屋面三角化保留。
function subtractTriangle(polygon, triangle, output) {
  let inside = polygon;
  const pieces = [];
  for (let i = 0; i < 3; i++) {
    const p = triangle[i], q = triangle[(i + 1) % 3];
    const dx = q.x - p.x, dz = q.z - p.z;
    const outside = [], next = [];
    let a = inside.at(-1);
    const distance = v => {
      const d = cross(dx, dz, v.x - p.x, v.z - p.z);
      return Math.abs(d) < EPSILON ? 0 : d;
    };
    let da = distance(a);
    for (const b of inside) {
      const db = distance(b);
      if (da * db < 0) {
        const t = da / (da - db);
        const point = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        next.push(point);
        outside.push(point);
      }
      if (db >= 0) next.push(b);
      if (db <= 0) outside.push(b);
      a = b;
      da = db;
    }
    if (next.length < 3 || ringArea(next) <= EPSILON) {
      output.push(polygon);
      return;
    }
    if (outside.length >= 3 && ringArea(outside) > EPSILON) pieces.push(outside);
    inside = next;
  }
  output.push(...pieces);
}

export function createBuildingEnvelopes(buildings, placementOf, groups = REVIEWED_GROUPS) {
  const byId = new Map(groups.flat().map(id => [id, []]));
  for (const building of buildings) byId.get(building.id)?.push(building);
  const plans = new Map();
  for (const ids of groups) {
    const members = ids.flatMap((id, order) => byId.get(id).flatMap(building => {
      if (building.landmark || building.foundation || building.role === 'bridge' || building.role === 'canopy') return [];
      const { minY, maxY } = placementOf(building);
      return building.polygons.map(polygon => ({ building, polygon, minY, maxY, order, bounds: bounds(polygon) }));
    }));
    for (const member of members) {
      const neighbours = members.filter(row => row.building !== member.building);
      if (!neighbours.length) continue;
      const { polygon, order } = member;
      const cuttersAt = (y, facing) => neighbours.filter(row => overlaps(member.bounds, row.bounds)
        && (facing > 0
          ? row.minY <= y && (row.maxY > y || row.maxY === y && row.order < order)
          : row.maxY >= y && (row.minY < y || row.minY === y && row.order < order)));
      plans.set(polygon, {
        wall: (...args) => clipWall(neighbours, order, ...args),
        coversRoof: y => cuttersAt(y, 1).map(row => row.polygon),
        cap(y, facing) {
          const cutters = cuttersAt(y, facing);
          if (!cutters.length) return null;
          let pieces = triangulateFootprint(polygon);
          for (const cutter of cutters) {
            for (const triangle of triangulateFootprint(cutter.polygon)) {
              const remaining = [];
              const triangleBounds = bounds({ outer: triangle });
              for (const piece of pieces) {
                if (overlaps(bounds({ outer: piece }), triangleBounds)) subtractTriangle(piece, triangle, remaining);
                else remaining.push(piece);
              }
              pieces = remaining;
            }
          }
          return pieces;
        }
      });
    }
  }
  return plans;
}
