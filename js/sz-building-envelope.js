import { polygonContains, ringArea } from './sz-polygon.js';
import { triangulateFootprint } from './sz-geometry.js';

import { BUILDING_ENVELOPE_RELATIONS } from './sz-building-envelope-relations.js';

const EPSILON = 1e-7;
const PROBE_M = 1e-5;
const CELL_M = 64;
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

function touches(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function edgeTouches(a, b, p, q) {
  const side = (u, v, w) => cross(v.x - u.x, v.z - u.z, w.x - u.x, w.z - u.z);
  const on = (u, v, w, d) => Math.abs(d) <= EPSILON
    && w.x >= Math.min(u.x, v.x) && w.x <= Math.max(u.x, v.x)
    && w.z >= Math.min(u.z, v.z) && w.z <= Math.max(u.z, v.z);
  const c = side(a, b, p), d = side(a, b, q), e = side(p, q, a), f = side(p, q, b);
  return (c * d < 0 && e * f < 0) || on(a, b, p, c) || on(a, b, q, d)
    || on(p, q, a, e) || on(p, q, b, f);
}

function footprintsTouch(a, b) {
  const ringsA = [a.outer, ...(a.holes ?? [])], ringsB = [b.outer, ...(b.holes ?? [])];
  for (const ra of ringsA) for (const rb of ringsB) {
    for (let i = 0; i < ra.length; i++) for (let j = 0; j < rb.length; j++) {
      if (edgeTouches(ra[i], ra[(i + 1) % ra.length], rb[j], rb[(j + 1) % rb.length])) return true;
    }
  }
  return polygonContains(a, b.outer[0].x, b.outer[0].z) || polygonContains(b, a.outer[0].x, a.outer[0].z);
}

// 只对同格的实际相交足迹建邻接；分块边界不影响归属，也不把内院内的独立楼误作遮挡。
function connectNeighbours(members) {
  const cells = new Map();
  let pairs = 0;
  for (const member of members) {
    const b = member.bounds, seen = new Set();
    for (let x = Math.floor(b.minX / CELL_M); x <= Math.floor(b.maxX / CELL_M); x++) {
      for (let z = Math.floor(b.minZ / CELL_M); z <= Math.floor(b.maxZ / CELL_M); z++) {
        const key = `${x},${z}`;
        let cell = cells.get(key);
        if (!cell) cells.set(key, (cell = []));
        for (const other of cell) {
          if (seen.has(other)) continue;
          seen.add(other);
          if (!touches(b, other.bounds) || !footprintsTouch(member.polygon, other.polygon)) continue;
          member.neighbours.push(other);
          other.neighbours.push(member);
          pairs++;
        }
        cell.push(member);
      }
    }
  }
  return pairs;
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
  const active = neighbours.filter(row => row.minY < maxY && (row.maxY > minY || parapet && row.maxY === minY));
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
      // 同高屋面的共边只留归属方的女儿墙，不能在屋面裁完后又叠回两层压顶。
      const sameRoof = parapet && row.maxY === minY;
      const outer = polygonContains(row.polygon, x + nx * PROBE_M, z + nz * PROBE_M);
      const inner = (parapet && !sameRoof || row.order < order)
        && polygonContains(row.polygon, x - nx * PROBE_M, z - nz * PROBE_M);
      if (outer || inner) hidden.push([Math.max(minY, row.minY), sameRoof ? maxY : Math.min(maxY, row.maxY)]);
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

function sameRing(a, b) {
  if (a.length !== b.length) return false;
  const samePoint = (p, q) => p.x === q.x && p.z === q.z;
  const start = b.findIndex(point => samePoint(a[0], point));
  return start >= 0 && [1, -1].some(step => a.every((point, i) =>
    samePoint(point, b[(start + i * step + b.length) % b.length])));
}

function sameVolume(a, b) {
  return a.length === 1 && b.length === 1 && a[0].minY === b[0].minY && a[0].maxY === b[0].maxY
    && sameRing(a[0].polygon.outer, b[0].polygon.outer)
    && a[0].polygon.holes.length === b[0].polygon.holes.length
    && a[0].polygon.holes.every(hole => b[0].polygon.holes.some(other => sameRing(hole, other)));
}

export function createBuildingEnvelopePlan(buildings, placementOf, skipIds, groups) {
  const relations = groups?.map(sourceIds => ({ kind: 'overlap', sourceIds })) ?? BUILDING_ENVELOPE_RELATIONS;
  const priority = new Map(), byId = new Map();
  let nextPriority = 0;
  for (const { sourceIds } of relations) for (const id of sourceIds) {
    if (!priority.has(id)) priority.set(id, nextPriority++);
  }
  const members = [];
  for (const building of buildings) {
    if (skipIds.has(building.id) || building.landmark || building.foundation
      || building.role === 'bridge' || building.role === 'canopy') continue;
    const { minY, maxY } = placementOf(building);
    const parts = building.polygons.map(polygon => ({ building, polygon, minY, maxY,
      bounds: bounds(polygon), neighbours: [], triangles: null }));
    members.push(...parts);
    const rows = byId.get(building.id);
    if (rows) rows.push(...parts); else byId.set(building.id, parts);
  }
  const envelopes = new Map();
  const duplicateIds = new Map();
  for (const { kind, sourceIds } of relations) {
    if (kind === 'duplicate-volume') {
      // 新快照足迹、标高或接管状态变化时保留两条实体，等离线复核后再决定。
      const [owner, duplicate] = sourceIds.map(id => byId.get(id) ?? []);
      if (sameVolume(owner, duplicate)) duplicateIds.set(sourceIds[1], sourceIds[0]);
    }
  }
  // 审核优先级优先，其余有来源楼高优于估高，具名优于无名，再按稳定 ID 排序。
  // 这里只决定共享面的外观，不改源楼高、足迹或碰撞；自动发现不合并或删除源对象。
  const active = members.filter(row => !duplicateIds.has(row.building.id)).sort((a, b) => {
    const x = a.building, y = b.building;
    return (priority.get(x.id) ?? Infinity) - (priority.get(y.id) ?? Infinity)
      || Number(x.heightSource === 'estimate') - Number(y.heightSource === 'estimate')
      || Number(!x.name) - Number(!y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  });
  active.forEach((row, order) => { row.order = order; });
  const neighbourPairs = connectNeighbours(active);
  for (const member of active) {
    const { neighbours } = member;
    if (!neighbours.length) continue;
    const { polygon, order } = member;
    const cuttersAt = (y, facing) => neighbours.filter(row => overlaps(member.bounds, row.bounds)
      && (facing > 0
        ? row.minY <= y && (row.maxY > y || row.maxY === y && row.order < order)
        : row.maxY >= y && (row.minY < y || row.minY === y && row.order < order)));
    envelopes.set(polygon, {
      wall: (...args) => clipWall(neighbours, order, ...args),
      coversRoof: y => cuttersAt(y, 1).map(row => row.polygon),
      cap(y, facing) {
        const cutters = cuttersAt(y, facing);
        if (!cutters.length) return null;
        let pieces = triangulateFootprint(polygon);
        for (const cutter of cutters) {
          for (const triangle of (cutter.triangles ??= triangulateFootprint(cutter.polygon))) {
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
  return { envelopes, duplicateIds, statistics: { members: active.length, neighbourPairs, envelopes: envelopes.size } };
}
