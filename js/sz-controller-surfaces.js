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
  return a.y * u + b.y * v + c.y * w;
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
    if (same) return same;
    return reachable.sort((a, b) => Math.abs(a.height - previousY) - Math.abs(b.height - previousY)
      || a.surfaceId.localeCompare(b.surfaceId))[0] ?? null;
  }

  function below(x, z, y) {
    if (!Number.isFinite(y)) return null;
    return at(x, z).filter(c => c.height <= y + 1e-7).at(-1) ?? null;
  }

  return { at, resolve, below };
}
