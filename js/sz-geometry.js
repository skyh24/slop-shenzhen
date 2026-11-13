import * as THREE from 'three/webgpu';

class GrowArray {
  constructor(Type, initial = 4096) {
    this.Type = Type;
    this.data = new Type(initial);
    this.length = 0;
  }

  reserve(n) {
    if (this.length + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new this.Type(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  view() {
    return this.data.slice(0, this.length);
  }
}

// 带索引的顶点缓冲；每个顶点：位置、法线、uv，外加可选的 vec4 属性 meta
export class GeoBuilder {
  constructor(withMeta = false) {
    this.pos = new GrowArray(Float32Array);
    this.nrm = new GrowArray(Float32Array);
    this.uv = new GrowArray(Float32Array);
    this.meta = withMeta ? new GrowArray(Float32Array) : null;
    this.idx = new GrowArray(Uint32Array);
  }

  get count() {
    return this.pos.length / 3;
  }

  vertex(x, y, z, nx, ny, nz, u, v, meta) {
    const i = this.count;
    this.pos.reserve(3);
    this.nrm.reserve(3);
    this.uv.reserve(2);
    const p = this.pos.data, n = this.nrm.data, t = this.uv.data;
    let k = this.pos.length;
    p[k] = x; p[k + 1] = y; p[k + 2] = z;
    n[k] = nx; n[k + 1] = ny; n[k + 2] = nz;
    this.pos.length += 3;
    this.nrm.length += 3;
    k = this.uv.length;
    t[k] = u; t[k + 1] = v;
    this.uv.length += 2;
    if (this.meta) {
      this.meta.reserve(4);
      this.meta.data.set(meta, this.meta.length);
      this.meta.length += 4;
    }
    return i;
  }

  tri(a, b, c) {
    this.idx.reserve(3);
    const d = this.idx.data, k = this.idx.length;
    d[k] = a; d[k + 1] = b; d[k + 2] = c;
    this.idx.length += 3;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.view(), 2));
    if (this.meta) g.setAttribute('bmeta', new THREE.BufferAttribute(this.meta.view(), 4));
    g.setIndex(new THREE.BufferAttribute(this.idx.view(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// 从已写入的 Float32 显示几何读取接触面，避免重复三角化和精度差。
export function readTriangles(batch, firstIndex) {
  const triangles = [];
  const vertices = batch.pos.data;
  const indices = batch.idx.data;
  for (let i = firstIndex; i < batch.idx.length; i += 3) {
    const tri = [];
    for (let j = i; j < i + 3; j++) {
      const offset = indices[j] * 3;
      tri.push({ x: vertices[offset], y: vertices[offset + 1], z: vertices[offset + 2] });
    }
    triangles.push(tri);
  }
  return triangles;
}

function signedArea(ring) {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return a / 2;
}

function toVec2(ring, wantPositive) {
  const pts = [];
  for (let i = 0; i < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i], ring[i + 1]));
  if ((signedArea(ring) > 0) !== wantPositive) pts.reverse();
  return pts;
}

// 屋面裁切使用与直接绘制相同的凹多边形和带孔三角化。
export function triangulateFootprint({ outer, holes = [] }) {
  const flat = ring => ring.flatMap(p => [p.x, p.z]);
  const boundary = toVec2(flat(outer), true);
  const inner = holes.map(ring => toVec2(flat(ring), false));
  const faces = THREE.ShapeUtils.triangulateShape(boundary, inner);
  const points = boundary.concat(...inner).map(({ x, y }) => ({ x, z: y }));
  return faces.map(face => {
    const [a, b, c] = face.map(index => points[index]);
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x) > 0 ? [a, b, c] : [a, c, b];
  });
}

// 水平面保留内院；架空实体底盖朝下，不能靠双面材质掩盖缺失的实体边界。
export function addFlatPolygon(b, rings, y, meta, uvScale = 1, facing = 1) {
  if (facing !== 1 && facing !== -1) throw new Error(`Invalid polygon facing: ${facing}`);
  const outer = toVec2(rings[0], true);
  if (outer.length < 3) return;
  const holes = rings.slice(1).map((r) => toVec2(r, false)).filter((h) => h.length >= 3);
  const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
  const all = outer.concat(...holes);
  const base = b.count;
  for (const p of all) b.vertex(p.x, y, p.y, 0, facing, 0, p.x * uvScale, p.y * uvScale, meta);
  for (const [ia, ib, ic] of faces) {
    const a = all[ia], q = all[ib], r = all[ic];
    // 绕序与指定法线一致；从通道下方观察应命中实体底面。
    if (((q.y - a.y) * (r.x - a.x) - (q.x - a.x) * (r.y - a.y)) * facing < 0) b.tri(base + ia, base + ic, base + ib);
    else b.tri(base + ia, base + ib, base + ic);
  }
}

// 外墙：u 是每面墙自己的累计长度（米，从墙角 0 起，便于按墙拟合整数开间），v 是离地高度（米）。
// meta 为 [立面编号, 种子, 0, 楼高]；顶点级 meta.z 改写为该面墙的长度，meta.w 保持楼高。
export function addWalls(b, rings, y0, y1, meta, uvOriginY = 0, replaceEdge = null, clipEdge = null) {
  // 每面墙复用同一份 meta 数组，GeoBuilder 会立刻拷贝数值，不能跨顶点保留引用。
  const wallMeta = meta ? meta.slice() : null;
  const fullWall = { u0: 0, u1: 0, y0, y1 };
  const fullSpan = [fullWall];
  rings.forEach((ring, ri) => {
    const n = ring.length / 2;
    if (n < 3) return;
    const ccw = signedArea(ring) > 0;
    const forward = ri === 0 ? ccw : !ccw;
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k;
      const j = forward ? (i + 1) % n : (i - 1 + n) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1];
      const bx = ring[j * 2], bz = ring[j * 2 + 1];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = dz / len, nz = -dx / len;
      const slices = clipEdge?.(ax, az, bx, bz, nx, nz, len, y0, y1);
      const wallBottom = !slices && ri === 0 && replaceEdge
        ? replaceEdge(ax, az, bx, bz, nx, nz, len) ?? y0 : y0;
      if (wallBottom >= y1) continue;
      if (wallMeta) wallMeta[2] = len;
      fullWall.u1 = len;
      fullWall.y0 = wallBottom;
      for (const span of slices ?? fullSpan) {
        const { u0, u1 } = span;
        const x0 = u0 === 0 ? ax : ax + dx * (u0 / len), z0 = u0 === 0 ? az : az + dz * (u0 / len);
        const x1 = u1 === len ? bx : ax + dx * (u1 / len), z1 = u1 === len ? bz : az + dz * (u1 / len);
        const v0 = span.y0 - uvOriginY, v1 = span.y1 - uvOriginY;
        const a0 = b.vertex(x0, span.y0, z0, nx, 0, nz, u0, v0, wallMeta);
        const b0 = b.vertex(x1, span.y0, z1, nx, 0, nz, u1, v0, wallMeta);
        const b1 = b.vertex(x1, span.y1, z1, nx, 0, nz, u1, v1, wallMeta);
        const a1 = b.vertex(x0, span.y1, z0, nx, 0, nz, u0, v1, wallMeta);
        b.tri(a0, b1, b0);
        b.tri(a0, a1, b1);
      }
    }
  });
}

// 道路条带：u 沿路长度（米），v 离中心线的横向距离（米）；meta.x 存路宽
export function addRibbon(b, pts, width, y, meta) {
  const n = pts.length / 2;
  if (n < 2) return;
  const half = width / 2;
  let u = 0;
  let prevL = -1, prevR = -1;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, n - 1);
    let dx = pts[i1 * 2] - pts[i0 * 2];
    let dz = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    if (i > 0) u += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    const x = pts[i * 2], z = pts[i * 2 + 1];
    // 左侧 = 行进方向逆时针转 90°（x 向东、z 向南的平面里是 (dz, −dx)）
    const L = b.vertex(x + dz * half, y, z - dx * half, 0, 1, 0, u, half, meta);
    const R = b.vertex(x - dz * half, y, z + dx * half, 0, 1, 0, u, -half, meta);
    if (prevL >= 0) {
      // 两个三角形都要求法线朝上，用第一个三角形检查一次方向
      const p = b.pos.data;
      const ax = p[prevL * 3], az = p[prevL * 3 + 2];
      const bx = p[prevR * 3], bz = p[prevR * 3 + 2];
      const cx = p[R * 3], cz = p[R * 3 + 2];
      if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) >= 0) {
        b.tri(prevL, prevR, R);
        b.tri(prevL, R, L);
      } else {
        b.tri(prevL, R, prevR);
        b.tri(prevL, L, R);
      }
    }
    prevL = L;
    prevR = R;
  }
}
