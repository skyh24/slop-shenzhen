import { baseAt, footprintParts, loftPart, spanPart } from './parts.js';
import { polygonContains } from '../building-collision.js';
import { createBuildingEnvelopePlan } from '../sz-building-envelope.js';

export const sourceIds = ['way/238825588', 'way/539435437'];

// 购物公园沿弧形一侧的柱廊与塔楼尺寸。全部为米，y 为世界坐标。
const COLONNADE = {
  columnWidth: 0.7,
  columnOffset: 2.0,
  height: 5.4,
  minSpacing: 7.5,
  maxSpacing: 9,
  targetSpacing: 8.2,
  maxColumns: 20,
  beamHeight: 0.45,
  beamWidth: 0.75,
  glassOffset: 0.1,
  glassThickness: 0.12,
  glassBottom: 0.15,
  glassTop: 5.2,
  canopyDepth: 4.0,
  canopyThickness: 0.28,
  canopyOffset: 2.0
};

// 塔楼：48 边内切椭圆，三段收分，顶点落在源足迹之内；冠部外挑一圈压顶。
const TOWER = {
  sides: 48,
  taper: [1, 0.965, 0.92, 0.9],
  fitMargin: 0.995,
  crownScale: 0.925,
  crownHeight: 0.7
};

const SOUTHEAST = { x: Math.SQRT1_2, z: Math.SQRT1_2 };

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

// 外法线随环向走：顺时针足迹取 (-dz, dx)，逆时针取 (dz, -dx)。
function edgesOf(ring) {
  const sign = ringArea(ring) < 0 ? 1 : -1;
  return ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    return { a, b, dx, dz, length, outX: -dz * sign / length, outZ: dx * sign / length };
  });
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function ringDistance(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    best = Math.min(best, segmentDistance(x, z, a.x, a.z, b.x, b.z));
  }
  return best;
}

function ellipseRing(cx, cz, rx, rz, scale) {
  return Array.from({ length: TOWER.sides }, (_, i) => {
    const angle = i * Math.PI * 2 / TOWER.sides;
    return { x: cx + Math.cos(angle) * rx * scale, z: cz + Math.sin(angle) * rz * scale };
  });
}

function ringInside(ring, polygon) {
  return ring.every(p => polygonContains(polygon, p.x, p.z));
}

// 二分求最大内切系数，再留 0.5% 余量，保证任何方向都不越过源足迹。
function fitScale(cx, cz, rx, rz, polygon) {
  let low = 0.5, high = 1.0001;
  if (!ringInside(ellipseRing(cx, cz, rx, rz, low), polygon)) return 0;
  for (let i = 0; i < 36; i++) {
    const mid = (low + high) / 2;
    if (ringInside(ellipseRing(cx, cz, rx, rz, mid), polygon)) low = mid;
    else high = mid;
  }
  return low * TOWER.fitMargin;
}

// 沿方向射线求源足迹的外边界距离，用于补裙房顶洞边缘的窄环。
function rayRingHit(cx, cz, ux, uz, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const den = -ux * dz + dx * uz;
    if (Math.abs(den) < 1e-9) continue;
    const ox = a.x - cx, oz = a.z - cz;
    const t = (-ox * dz + dx * oz) / den;
    const s = (ux * oz - uz * ox) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}

// 选出裙房外轮廓中朝向东南、且与塔楼共边的连续边段。
function southeastRuns(podiumRing, upperRing) {
  const edges = edgesOf(podiumRing);
  const selected = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (edge.outX * SOUTHEAST.x + edge.outZ * SOUTHEAST.z <= 0.25) continue;
    const mx = (edge.a.x + edge.b.x) / 2, mz = (edge.a.z + edge.b.z) / 2;
    if (ringDistance(upperRing, mx, mz) > 0.05) continue;
    selected.push(i);
  }
  if (!selected.length) return [];
  const chosen = new Set(selected);
  // 从一段未选中的边之后起读，跨 0 的连续段不会被拆开。
  let start = 0;
  while (start < edges.length && chosen.has(start)) start++;
  const runs = [];
  let current = null;
  for (let k = 0; k < edges.length; k++) {
    const i = (start + k) % edges.length;
    if (!chosen.has(i)) { current = null; continue; }
    if (!current) { current = []; runs.push(current); }
    current.push(i);
  }
  return runs.map(indices => ({ indices, edges, length: indices.reduce((sum, i) => sum + edges[i].length, 0) }));
}

function columnLayout(length) {
  const inset = Math.min(0.5, length * 0.02);
  const usable = length - inset * 2;
  let best = null;
  for (let count = 2; count <= COLONNADE.maxColumns; count++) {
    const spacing = usable / (count - 1);
    if (spacing < COLONNADE.minSpacing || spacing > COLONNADE.maxSpacing) continue;
    if (!best || Math.abs(spacing - COLONNADE.targetSpacing) < Math.abs(best.spacing - COLONNADE.targetSpacing)) {
      best = { count, spacing, inset };
    }
  }
  if (best) return best;
  const count = Math.max(2, Math.min(COLONNADE.maxColumns, Math.round(length / COLONNADE.targetSpacing) + 1));
  return { count, spacing: length / (count - 1), inset: 0 };
}

function pointOnRun(run, distance) {
  let rest = distance;
  for (const [index, edgeIndex] of run.indices.entries()) {
    const edge = run.edges[edgeIndex];
    const last = index === run.indices.length - 1;
    if (rest <= edge.length || last) {
      const t = Math.max(0, Math.min(edge.length, rest));
      return {
        edge,
        x: edge.a.x + edge.dx / edge.length * t,
        z: edge.a.z + edge.dz / edge.length * t
      };
    }
    rest -= edge.length;
  }
  return null;
}

function shiftedSegment(edge, offset) {
  return {
    a: { x: edge.a.x + edge.outX * offset, z: edge.a.z + edge.outZ * offset },
    b: { x: edge.b.x + edge.outX * offset, z: edge.b.z + edge.outZ * offset }
  };
}

function squareRing(cx, cz, dirX, dirZ, outX, outZ, half) {
  const at = (u, v) => ({ x: cx + dirX * u + outX * v, z: cz + dirZ * u + outZ * v });
  return [at(-half, -half), at(half, -half), at(half, half), at(-half, half)];
}

// 柱廊：每段沿弧长均布方柱，柱间配通长梁、首层玻璃带；雨棚与补缝走 trim，不生成碰撞。
function colonnadeParts(podium, podiumRing, upperRing, base, trim) {
  const parts = [];
  const runs = southeastRuns(podiumRing, upperRing);
  const top = base + COLONNADE.height;
  const half = COLONNADE.columnWidth / 2;
  let index = 0;

  for (const run of runs) {
    const layout = columnLayout(run.length);
    let placed = 0;
    for (let k = 0; k < layout.count; k++) {
      const point = pointOnRun(run, layout.inset + k * layout.spacing);
      if (!point) continue;
      const { edge } = point;
      const dirX = edge.dx / edge.length, dirZ = edge.dz / edge.length;
      // 端部柱角可能蹭到转角处的裙房轮廓，沿法线逐级外移直到整根柱都在墙外。
      let offset = COLONNADE.columnOffset;
      let ring = squareRing(point.x + edge.outX * offset, point.z + edge.outZ * offset,
        dirX, dirZ, edge.outX, edge.outZ, half);
      while (offset < COLONNADE.columnOffset + 0.6 && ring.some(p => polygonContains(podium.polygons[0], p.x, p.z))) {
        offset += 0.1;
        ring = squareRing(point.x + edge.outX * offset, point.z + edge.outZ * offset,
          dirX, dirZ, edge.outX, edge.outZ, half);
      }
      if (ring.some(p => polygonContains(podium.polygons[0], p.x, p.z))) continue;
      const id = podium.id + ':colonnade:column:' + index;
      const column = footprintParts({ ...podium, polygons: [{ outer: ring, holes: [] }] }, 0, 'shoppingParkBase', {
        id, min: base, max: top, derived: true, heightSource: 'estimate'
      })[0];
      parts.push({ ...column, id });
      index++;
      placed++;
    }
    if (!placed) continue;

    for (const edgeIndex of run.indices) {
      const edge = run.edges[edgeIndex];
      const beam = shiftedSegment(edge, COLONNADE.columnOffset);
      parts.push(spanPart(podium.id + ':colonnade:beam:' + edgeIndex, podium,
        { ...beam.a, y: top + COLONNADE.beamHeight }, { ...beam.b, y: top + COLONNADE.beamHeight },
        COLONNADE.beamWidth, COLONNADE.beamWidth, COLONNADE.beamHeight, 'landmarkEdge',
        { heightSource: 'estimate', baseSourceId: podium.id }));

      const glass = shiftedSegment(edge, COLONNADE.glassOffset);
      parts.push(spanPart(podium.id + ':colonnade:glass:' + edgeIndex, podium,
        { ...glass.a, y: base + COLONNADE.glassTop }, { ...glass.b, y: base + COLONNADE.glassTop },
        COLONNADE.glassThickness, COLONNADE.glassThickness,
        COLONNADE.glassTop - COLONNADE.glassBottom, 'shoppingParkGlass',
        { heightSource: 'estimate', baseSourceId: podium.id }));

      // 雨棚悬挑 4 米，顶面略低于梁底；分段接缝交替 4 毫米，避免共面顶面打架。
      const mx = (edge.a.x + edge.b.x) / 2, mz = (edge.a.z + edge.b.z) / 2;
      trim.push({
        x: mx + edge.outX * COLONNADE.canopyOffset,
        y: top - COLONNADE.canopyThickness / 2 - 0.02 + (edgeIndex % 2) * 0.004,
        z: mz + edge.outZ * COLONNADE.canopyOffset,
        yaw: Math.atan2(edge.outX, edge.outZ),
        size: [edge.length + 0.36, COLONNADE.canopyThickness, COLONNADE.canopyDepth],
        style: 'landmarkEdge'
      });
    }
  }
  return parts;
}

// 圆筒内切后比源足迹小 0.2–0.6 米；把裙房顶洞边缘与筒壁之间的窄环用暗色板补平。
function soffitTrim(podium, upperRing, cx, cz, rx, rz, fit, roofY, trim) {
  const slices = 48;
  for (let i = 0; i < slices; i++) {
    const angle = (i + 0.5) * Math.PI * 2 / slices;
    const ux = Math.cos(angle), uz = Math.sin(angle);
    const inner = fit / Math.hypot(ux / rx, uz / rz);
    const outer = rayRingHit(cx, cz, ux, uz, upperRing);
    if (!Number.isFinite(outer) || outer <= inner + 0.02) continue;
    const mid = (inner + outer) / 2;
    const mx = cx + ux * mid, mz = cz + uz * mid;
    if (!polygonContains(podium.polygons[0], mx, mz)) continue;
    trim.push({
      x: mx, y: roofY - 0.06, z: mz, yaw: Math.atan2(ux, uz),
      size: [Math.PI * 2 * mid / slices * 1.02, 0.08, outer - inner + 0.06],
      style: 'landmarkEdge'
    });
  }
}

// 裙房顶面裁剪与同源接触三角沿用原逻辑：只挖掉塔楼实际占用的顶面。
export function build(sources, terrain) {
  const [podium, upper] = sourceIds.map(id => sources.get(id));
  if (!podium || !upper || upper.height <= podium.height) return [];
  const base = baseAt(podium, terrain);
  const podiumRing = podium.polygons[0].outer;
  const upperRing = upper.polygons[0].outer;
  const lowerParts = footprintParts(podium, base, 'shoppingParkBase');
  const { envelopes } = createBuildingEnvelopePlan([podium, upper], building => building === podium
    ? { minY: base + podium.minHeight, maxY: Math.fround(base + podium.height) }
    : { minY: Math.fround(base + podium.height), maxY: Math.fround(base + upper.height) }, new Set(), [sourceIds]);
  const trim = [];
  const parts = lowerParts.map(part => ({ ...part, roofPieces: envelopes.get(part.polygon)?.cap(part.maxY, 1) }));
  parts.push(...colonnadeParts(podium, podiumRing, upperRing, base, trim));

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of upperRing) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const rx = (maxX - minX) / 2, rz = (maxZ - minZ) / 2;
  const fit = fitScale(cx, cz, rx, rz, upper.polygons[0]);
  const podiumTop = base + podium.height;
  const upperTop = base + upper.height;
  const sections = TOWER.taper.map((scale, i) => ({
    y: podiumTop + (upperTop - podiumTop) * i / (TOWER.taper.length - 1),
    ring: ellipseRing(cx, cz, rx, rz, fit * scale)
  }));
  // 段间不封顶/封底，只有首段封底、冠部封顶，避免接高处出现重复水平面。
  const tower = sections.slice(0, -1).map((section, i) => loftPart(upper.id + ':tower:' + i, upper,
    section.ring, sections[i + 1].ring, section.y, sections[i + 1].y, 'shoppingParkGlass', {
      baseSourceId: podium.id, heightSource: upper.heightSource, uvOriginY: base,
      smoothSides: true, bottomFace: i === 0, topFace: false
    }));
  const crownRing = ellipseRing(cx, cz, rx, rz, fit * TOWER.crownScale);
  const crown = footprintParts({ ...upper, polygons: [{ outer: crownRing, holes: [] }] }, 0, 'landmarkEdge', {
    id: upper.id + ':crown', min: upperTop - TOWER.crownHeight, max: upperTop, derived: true,
    heightSource: upper.heightSource
  })[0];
  parts.push(...tower, { ...crown, id: upper.id + ':crown' });
  soffitTrim(podium, upperRing, cx, cz, rx, rz, fit, podiumTop, trim);
  return { parts, trim };
}
