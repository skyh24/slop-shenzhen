export const URBAN_STONE_KIND = 10;
export const URBAN_LAWN_KIND = 11;

const recordUnpack = typeof location !== 'undefined'
  && ['127.0.0.1', 'localhost'].includes(location.hostname)
  && new URLSearchParams(location.search).get('qa') === '1';

// 显示、传送与接触共用派生地面三角形，裁除区不回退到原始 DSM。
export function unpackSurface(surface) {
  const started = recordUnpack ? performance.now() : 0;
  if (surface?.version !== 1 || !Number.isFinite(surface.chunkSize) || surface.chunkSize <= 0
    || surface.diagonal !== 'ne-sw' || !surface.grid || !Array.isArray(surface.chunks)) {
    throw new Error('Invalid terrain surface payload');
  }
  const grid = surface.grid;
  if (!Number.isFinite(grid.x0) || !Number.isFinite(grid.z0) || !Number.isFinite(grid.step) || grid.step <= 0
    || !Number.isInteger(grid.nx) || !Number.isInteger(grid.nz) || grid.nx < 2 || grid.nz < 2) {
    throw new Error('Invalid terrain surface grid');
  }
  const chunks = new Map();
  for (const source of surface.chunks) {
    if (source.positions.length % 3 || source.indices.length % 3 || source.cellRanges.length % 3
      || source.kinds.length !== source.positions.length / 3 || source.origin.length !== 2
      || source.origin.some(value => !Number.isFinite(value)) || chunks.has(source.id)
      || source.positions.some(value => !Number.isFinite(value))
      || source.kinds.some(kind => !Number.isInteger(kind) || kind < 0 || (kind > 9 && kind !== URBAN_STONE_KIND && kind !== URBAN_LAWN_KIND))
      || source.indices.some(index => !Number.isInteger(index) || index < 0 || index >= source.kinds.length)) {
      throw new Error(`Invalid terrain surface chunk: ${source.id}`);
    }
    let lastCell = -1;
    let lastEnd = 0;
    for (let i = 0; i < source.cellRanges.length; i += 3) {
      const [cell, start, count] = source.cellRanges.slice(i, i + 3);
      if (![cell, start, count].every(Number.isInteger) || cell <= lastCell || cell >= (grid.nx - 1) * (grid.nz - 1)
        || start !== lastEnd || count <= 0 || count % 3 || start + count > source.indices.length) {
        throw new Error(`Invalid terrain surface cell ranges: ${source.id}`);
      }
      lastCell = cell;
      lastEnd = start + count;
    }
    if (lastEnd !== source.indices.length) throw new Error(`Incomplete terrain surface cell ranges: ${source.id}`);
    chunks.set(source.id, { id: source.id, origin: [...source.origin], positions: new Float32Array(source.positions),
      indices: new Uint32Array(source.indices), cellRanges: new Uint32Array(source.cellRanges),
      kinds: new Uint8Array(source.kinds) });
  }
  if (recordUnpack) {
    let bytes = 0, buffers = 0;
    for (const { positions, indices, cellRanges, kinds } of chunks.values()) {
      bytes += positions.byteLength + indices.byteLength + cellRanges.byteLength + kinds.byteLength;
      buffers += 4;
    }
    performance.measure('sz.surface.unpack', {
      start: started, end: performance.now(), detail: { chunks: chunks.size, bytes, buffers }
    });
  }
  return chunks;
}

function rangeForCell(ranges, cell) {
  let lo = 0, hi = ranges.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = ranges[mid * 3];
    if (value === cell) return [ranges[mid * 3 + 1], ranges[mid * 3 + 2]];
    if (value < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function heightInTriangle(positions, ia, ib, ic, x, z) {
  const a = ia * 3, b = ib * 3, c = ic * 3;
  const ax = positions[a], az = positions[a + 2];
  const bx = positions[b], bz = positions[b + 2];
  const cx = positions[c], cz = positions[c + 2];
  const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(denominator) < 1e-12) return null;
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
  const w = 1 - u - v;
  if (u < -1e-7 || v < -1e-7 || w < -1e-7) return null;
  return u * positions[a + 1] + v * positions[b + 1] + w * positions[c + 1];
}

function sampler(surface, chunks, accepts = null) {
  const grid = surface.grid;
  return (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const fx = (x - grid.x0) / grid.step, fz = (z - grid.z0) / grid.step;
    if (fx < 0 || fz < 0 || fx > grid.nx - 1 || fz > grid.nz - 1) return null;
    const i = Math.min(Math.floor(fx), grid.nx - 2), j = Math.min(Math.floor(fz), grid.nz - 2);
    // 边界点同时检查邻接单元，覆盖刚好落在海岸或分块边缘的接触。
    const columns = Number.isInteger(fx) && i > 0 ? [i, i - 1] : [i];
    const rows = Number.isInteger(fz) && j > 0 ? [j, j - 1] : [j];
    for (const row of rows) {
      for (const col of columns) {
        const worldX = grid.x0 + (col + 0.5) * grid.step;
        const worldZ = grid.z0 + (row + 0.5) * grid.step;
        const id = `${Math.floor(worldX / surface.chunkSize)},${Math.floor(worldZ / surface.chunkSize)}`;
        const chunk = chunks.get(id);
        if (!chunk) continue;
        const range = rangeForCell(chunk.cellRanges, row * (grid.nx - 1) + col);
        if (!range) continue;
        for (let p = range[0]; p < range[0] + range[1]; p += 3) {
          if (accepts && (!accepts(chunk.kinds[chunk.indices[p]]) || !accepts(chunk.kinds[chunk.indices[p + 1]])
              || !accepts(chunk.kinds[chunk.indices[p + 2]]))) continue;
          const height = heightInTriangle(chunk.positions, chunk.indices[p], chunk.indices[p + 1], chunk.indices[p + 2],
            x - chunk.origin[0], z - chunk.origin[1]);
          if (height !== null) return height;
        }
      }
    }
    return null;
  };
}

// 每个载荷对象代表一次数据读取；只缓存完整校验后的快照。换包/重试使用新对象，
// WeakMap 不延长旧载荷生命周期；仍持有采样器时，它继续查询自己的快照。
const surfaceSnapshots = new WeakMap();

function surfaceSnapshot(surface) {
  let snapshot = surfaceSnapshots.get(surface);
  if (snapshot) return snapshot;
  const chunks = unpackSurface(surface);
  snapshot = { grid: { ...surface.grid }, chunkSize: surface.chunkSize, chunks };
  surfaceSnapshots.set(surface, snapshot);
  return snapshot;
}

export function createGroundSurfaceSampler(surface, accepts) {
  const snapshot = surfaceSnapshot(surface);
  return sampler(snapshot, snapshot.chunks, accepts);
}

export function copyGroundChunksForRender(surface) {
  const { chunks } = surfaceSnapshot(surface);
  // Three 的 BufferAttribute 可写。只复制建模用的列，不把查询索引或共享数组交给渲染资源。
  return (function* () {
    for (const { id, origin, positions, indices, kinds } of chunks.values()) {
      yield { id, origin: [...origin], positions: positions.slice(), indices: indices.slice(), kinds: kinds.slice() };
    }
  })();
}
