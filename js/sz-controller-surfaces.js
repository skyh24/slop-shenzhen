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

/** 解析：只按表面身份取高度（车流/规划用），索引与控制器接触面使用同一批三角面。
 *  输入：surfaces（id + triangles）。
 *  输出：(x, z, surfaceId) → 高度或 null；平面不在该表面覆盖范围内时返回 null，由调用方回退到地面。 */
export function createSurfaceHeightAt(surfaces = []) {
  const cells = new Map();
  for (const surface of surfaces) {
    if (!surface?.id) throw new Error('A rendered surface requires identity');
    for (const triangle of surface.triangles) {
      const xs = triangle.map(p => p.x), zs = triangle.map(p => p.z);
      if (!xs.every(Number.isFinite) || !zs.every(Number.isFinite)
        || !triangle.every(p => Number.isFinite(p.y))) {
        throw new Error(`Invalid contact triangle: ${surface.id}`);
      }
      const row = { surfaceId: surface.id, triangle };
      for (let ix = Math.floor(Math.min(...xs) / CELL); ix <= Math.floor(Math.max(...xs) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(...zs) / CELL); iz <= Math.floor(Math.max(...zs) / CELL); iz++) {
          const key = `${ix},${iz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(row);
        }
      }
    }
  }
  return (x, z, surfaceId) => {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !surfaceId) return null;
    let height = null;
    // 相邻三角面在共享边上会重复命中且同高；取最高值避免凹缝，不跨表面混合层级。
    for (const row of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      if (row.surfaceId !== surfaceId) continue;
      const candidate = triangleHeight(row.triangle, x, z);
      if (candidate !== null && (height === null || candidate > height)) height = candidate;
    }
    return height;
  };
}

export function createSurfaceResolver({ groundHeight, groundIdentity = () => 'terrain', surfaces = [] }) {
  if (typeof groundHeight !== 'function') throw new Error('A terrain contact function is required');
  const cells = new Map();
  const driveSuccessors = new Map();
  const structured = new Set();
  const flightRoadDecks = new Set();
  const solidDecks = new Set();
  for (const surface of surfaces) {
    if (!surface.id || !surface.heightSource || surface.heightSource === 'unresolved') {
      throw new Error('A rendered surface requires identity and resolved height provenance');
    }
    if (Array.isArray(surface.driveSuccessors) && surface.driveSuccessors.length > 0) {
      driveSuccessors.set(surface.id, surface.driveSuccessors);
    }
    if (surface.structured) structured.add(surface.id);
    if (surface.flightRoadDeck) flightRoadDecks.add(surface.id);
    if (surface.solidDeck) solidDecks.add(surface.id);
    const access = new Set(surface.accessTriangles);
    for (const triangle of surface.triangles) {
      if (triangle.length !== 3 || triangle.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) {
        throw new Error(`Invalid contact triangle: ${surface.id}`);
      }
      const xs = triangle.map(p => p.x), zs = triangle.map(p => p.z);
      const row = { surfaceId: surface.id, heightSource: surface.heightSource, triangle,
        climbableFromGround: surface.climbableFromGround === true, modes: surface.modes,
        roadAccess: access.has(triangle) };
      for (let ix = Math.floor(Math.min(...xs) / CELL); ix <= Math.floor(Math.max(...xs) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(...zs) / CELL); iz <= Math.floor(Math.max(...zs) / CELL); iz++) {
          const key = `${ix},${iz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(row);
        }
      }
    }
  }

  function at(x, z, mode = null) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const candidates = new Map();
    const ground = groundHeight(x, z);
    if (Number.isFinite(ground)) {
      const surfaceId = groundIdentity(x, z);
      candidates.set(surfaceId, { height: ground, surfaceId, heightSource: 'terrain' });
    }
    for (const row of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      if (row.modes && mode && !row.modes.includes(mode)) continue;
      const height = triangleHeight(row.triangle, x, z);
      if (height === null) continue;
      const previous = candidates.get(row.surfaceId);
      if (previous && Math.abs(previous.height - height) > 0.01) {
        throw new Error(`Overlapping levels share a surface identity: ${row.surfaceId}`);
      }
      candidates.set(row.surfaceId, { height, surfaceId: row.surfaceId, heightSource: row.heightSource,
        climbableFromGround: row.climbableFromGround, roadAccess: row.roadAccess || previous?.roadAccess });
    }
    return [...candidates.values()].sort((a, b) => a.height - b.height || a.surfaceId.localeCompare(b.surfaceId));
  }

  function resolve(x, z, { previousY = null, previousSurfaceId = null, mode = null, maxStepUp = 0.6, maxDrop = 1.5 } = {}) {
    if (![maxStepUp, maxDrop].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid surface step limits');
    const candidates = at(x, z, mode);
    // 没有上一次接触高度时只返回真实地面，防止传送到桥下却自动吸到桥面。
    if (previousY === null) return candidates.find(c => c.heightSource === 'terrain') ?? null;
    if (!Number.isFinite(previousY)) return null;
    const reachable = candidates.filter(c => c.height <= previousY + maxStepUp && c.height >= previousY - maxDrop);
    const same = reachable.find(c => c.surfaceId === previousSurfaceId);
    if (structured.has(previousSurfaceId)) {
      if (same) return same;
      const successors = driveSuccessors.get(previousSurfaceId) ?? [];
      for (const id of successors) {
        const next = reachable.find(c => c.surfaceId === id);
        if (next) return next;
      }
      return null;
    }
    if (previousSurfaceId === 'terrain' && mode === 'car') {
      const access = reachable.find(c => c.roadAccess && (!same || c.height > same.height + 1e-5));
      if (access) return access;
    }
    // 封闭的结构面只能从同源路口或该路线的相邻路段进入。
    const ordinary = reachable.filter(c => !structured.has(c.surfaceId));
    if (same) {
      // 下坡跨过已建平台时先接触较高的上表面。桥下仍沿当前地面，不向上吸附。
      // 地面走到桥头时，只有显式声明可接地、且高差在抬脚高度内的桥面才允许踏上（桥面比地面高 4.8 m 时不可达）。
      const raised = ordinary.findLast(c => c.height > same.height + 1e-7
        && (c.height <= previousY + 1e-7
          || (same.heightSource === 'terrain' && c.climbableFromGround && c.height <= previousY + maxStepUp)));
      return raised ?? same;
    }
    // 多条并行桥面在分岔鼻端重叠时，按车行连通性交接到本段在车流图里的后继表面，
    // 不按几何最近随便吸附到相邻层（否则会骑到 1.5 m 以上的另一条缎带上卡住）。
    const successors = driveSuccessors.get(previousSurfaceId);
    if (successors) {
      // 按计划给出的走向顺序取第一条可达链路，避免在重叠缎带里吸附到相邻层。
      for (const surfaceId of successors) {
        const candidate = ordinary.find(c => c.surfaceId === surfaceId);
        if (candidate) return candidate;
      }
    }
    return ordinary.sort((a, b) => Math.abs(a.height - previousY) - Math.abs(b.height - previousY)
      || a.surfaceId.localeCompare(b.surfaceId))[0] ?? null;
  }

  function below(x, z, y) {
    if (!Number.isFinite(y)) return null;
    return at(x, z, 'helicopter').filter(c => c.height <= y + 1e-7).at(-1) ?? null;
  }

  function footing(x, z, radius, minY, maxY) {
    if (![x, z, radius, minY, maxY].every(Number.isFinite) || radius <= 0 || minY > maxY) return null;
    let best = null;
    for (let ix = Math.floor((x - radius) / CELL); ix <= Math.floor((x + radius) / CELL); ix++) {
      for (let iz = Math.floor((z - radius) / CELL); iz <= Math.floor((z + radius) / CELL); iz++) {
        for (const { surfaceId, heightSource, triangle, modes } of cells.get(`${ix},${iz}`) || []) {
          if (modes && !modes.includes('person')) continue;
          const height = heightInDisc(triangle, x, z, radius);
          if (height >= minY - 1e-7 && height <= maxY + 1e-7 && (!best || height > best.height)) {
            best = { height, surfaceId, heightSource };
          }
        }
      }
    }
    return best;
  }

  return { at, resolve, below, footing, isFlightRoadDeck: id => flightRoadDecks.has(id),
    isSolidDeck: id => solidDecks.has(id) };
}
