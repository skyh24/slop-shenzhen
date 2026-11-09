// 结构面必须来自实际显示几何，不能把 layer 换算成固定层高。
const CELL = 64;

export function triangleHeight(triangle, x, z) {
  const [a, b, c] = triangle;
  const determinant = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(determinant) < 1e-10) return null;
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / determinant;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / determinant;
  const w = 1 - u - v;
  if (Math.min(u, v, w) < -1e-7) return null;
  // 同高平台需返回与侧面上界完全相同的值，避免浮点舍入触发侧碰。
  return a.y + (b.y - a.y) * v + (c.y - a.y) * w;
}

function heightInDisc(triangle, x, z, radius) {
  let highest = triangleHeight(triangle, x, z) ?? -Infinity;
  const [a, b, c] = triangle;
  const bx = b.x - a.x, bz = b.z - a.z, cx = c.x - a.x, cz = c.z - a.z;
  const determinant = bx * cz - bz * cx;
  if (Math.abs(determinant) < 1e-10) return -Infinity;
  const dyB = b.y - a.y, dyC = c.y - a.y;
  const slopeX = (dyB * cz - bz * dyC) / determinant;
  const slopeZ = (bx * dyC - dyB * cx) / determinant;
  const slope = Math.hypot(slopeX, slopeZ);
  if (slope > 1e-10) {
    const rim = triangleHeight(triangle, x + slopeX * radius / slope, z + slopeZ * radius / slope);
    if (rim !== null) highest = Math.max(highest, rim);
  }
  // 极值在圆周的上坡方向或三角形边上。裁边保留前脚碰到的窄踏面。
  for (let i = 0; i < 3; i++) {
    const p = triangle[i], q = triangle[(i + 1) % 3];
    const dx = q.x - p.x, dz = q.z - p.z;
    const length2 = dx * dx + dz * dz;
    if (length2 <= 1e-10) continue;
    const center = ((x - p.x) * dx + (z - p.z) * dz) / length2;
    const errorX = p.x + dx * center - x, errorZ = p.z + dz * center - z;
    const room = radius * radius - errorX * errorX - errorZ * errorZ;
    if (room < 0) continue;
    const half = Math.sqrt(room / length2);
    const from = Math.max(0, center - half), to = Math.min(1, center + half);
    if (from <= to) highest = Math.max(highest, p.y + (q.y - p.y) * (q.y > p.y ? to : from));
  }
  return highest;
}

export function createSurfaceResolver({ groundHeight, surfaces = [] }) {
  if (typeof groundHeight !== 'function') throw new Error('A terrain contact function is required');
  const cells = new Map();
  for (const surface of surfaces) {
    if (!surface.id || !surface.heightSource || surface.heightSource === 'unresolved') {
      throw new Error('A rendered surface requires identity and resolved height provenance');
    }
    for (const triangle of surface.triangles) {
      if (triangle.length !== 3 || triangle.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) {
        throw new Error(`Invalid contact triangle: ${surface.id}`);
      }
      const xs = triangle.map(p => p.x), zs = triangle.map(p => p.z);
      const row = { surfaceId: surface.id, heightSource: surface.heightSource, triangle };
      for (let ix = Math.floor(Math.min(...xs) / CELL); ix <= Math.floor(Math.max(...xs) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(...zs) / CELL); iz <= Math.floor(Math.max(...zs) / CELL); iz++) {
          const key = `${ix},${iz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(row);
        }
      }
    }
  }

  function at(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const candidates = new Map();
    const ground = groundHeight(x, z);
    if (Number.isFinite(ground)) candidates.set('terrain', { height: ground, surfaceId: 'terrain', heightSource: 'terrain' });
    for (const row of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      const height = triangleHeight(row.triangle, x, z);
      if (height === null) continue;
      const previous = candidates.get(row.surfaceId);
      if (previous && Math.abs(previous.height - height) > 0.01) {
        throw new Error(`Overlapping levels share a surface identity: ${row.surfaceId}`);
      }
      candidates.set(row.surfaceId, { height, surfaceId: row.surfaceId, heightSource: row.heightSource });
    }
    return [...candidates.values()].sort((a, b) => a.height - b.height || a.surfaceId.localeCompare(b.surfaceId));
  }

  function resolve(x, z, { previousY = null, previousSurfaceId = null, maxStepUp = 0.6, maxDrop = 1.5 } = {}) {
    if (![maxStepUp, maxDrop].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid surface step limits');
    const candidates = at(x, z);
    // 没有上一次接触高度时只返回真实地面，防止传送到桥下却自动吸到桥面。
    if (previousY === null) return candidates.find(c => c.surfaceId === 'terrain') ?? null;
    if (!Number.isFinite(previousY)) return null;
    const reachable = candidates.filter(c => c.height <= previousY + maxStepUp && c.height >= previousY - maxDrop);
    const same = reachable.find(c => c.surfaceId === previousSurfaceId);
    if (same) {
      // 下坡跨过已建平台时先接触较高的上表面。桥下仍沿当前地面，不向上吸附。
      return reachable.findLast(c => c.height > same.height + 1e-7 && c.height <= previousY + 1e-7) ?? same;
    }
    return reachable.sort((a, b) => Math.abs(a.height - previousY) - Math.abs(b.height - previousY)
      || a.surfaceId.localeCompare(b.surfaceId))[0] ?? null;
  }

  function below(x, z, y) {
    if (!Number.isFinite(y)) return null;
    return at(x, z).filter(c => c.height <= y + 1e-7).at(-1) ?? null;
  }

  function footing(x, z, radius, minY, maxY) {
    if (![x, z, radius, minY, maxY].every(Number.isFinite) || radius <= 0 || minY > maxY) return null;
    let best = null;
    for (let ix = Math.floor((x - radius) / CELL); ix <= Math.floor((x + radius) / CELL); ix++) {
      for (let iz = Math.floor((z - radius) / CELL); iz <= Math.floor((z + radius) / CELL); iz++) {
        for (const { surfaceId, heightSource, triangle } of cells.get(`${ix},${iz}`) || []) {
          const height = heightInDisc(triangle, x, z, radius);
          if (height >= minY - 1e-7 && height <= maxY + 1e-7 && (!best || height > best.height)) {
            best = { height, surfaceId, heightSource };
          }
        }
      }
    }
    return best;
  }

  return { at, resolve, below, footing };
}
