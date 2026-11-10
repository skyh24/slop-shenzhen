import * as THREE from 'three/webgpu';
import {
  Fn, attribute, uv, vec2, vec3, vec4, float, color, fract, mix, smoothstep, dot, sin, cos,
  normalize, pow, clamp, positionLocal, positionGeometry, normalLocal, normalViewGeometry,
  normalView, positionViewDirection, frontFacing, time, texture
} from 'three/tsl';

// 深圳近景树冠样板：把 icosahedron 叶球换成程序化叶卡树冠。
// 只用于 250 m LOD 子格的 near 档；远景仍是 sz-trees.js 的低模冠。
// 叶卡图集、风摆、透光做法移植自 ref/slop-newyork/js/trees.js 和 tsl-materials.js（createTreeMaterial）。
// 六个树种的形态、叶色和比例都是外观估计，不是实测物候；树干尺寸和碰撞仍由 sz-trees.js 的数据和圆柱决定。
// 棕榈类（大王椰/狐尾椰）不用分枝骨架：一根直干（沿用树干实例）加顶部放射状羽叶卡片。

const V3 = THREE.Vector3;

// 固定种子：同一次构建和每次加载都长出同一棵树。
const CROWN_SEED = 20261110;
const ATLAS_SIZE = 1024;
const TILE = ATLAS_SIZE / 2;
const GUTTER = 8;
const TILES = 2;
// 没有 document 时（node --test）用程序化占位图，几何和 UV 约定不变；只有浏览器才画叶图集。
const HEADLESS_ATLAS_SIZE = 64;

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------- 叶卡图集
// 2×2 格：0 榕树（宽椭圆叶）、1 香樟/宫粉紫荆/木棉（小叶密生）、2 棕榈羽叶、3 凤凰木（细碎羽状叶）。
// texel：r = 叶片亮度，g = 单叶色相抖动，b = 枝/叶柄遮罩，a = 覆盖。
const TILE_FICUS = 0;
const TILE_BROAD = 1;
const TILE_PALM = 2;
const TILE_FEATHER = 3;

function twigPoints(R, x, y, angle, len, curl, segs = 10) {
  const points = [[x, y]];
  let a = angle;
  for (let i = 1; i <= segs; i++) {
    a += curl / segs + R(-0.03, 0.03);
    const p = points[i - 1];
    points.push([p[0] + Math.sin(a) * len / segs, p[1] + Math.cos(a) * len / segs]);
  }
  return points;
}

function pointAt(points, t) {
  const f = Math.min(points.length - 1.001, t * (points.length - 1));
  const i = Math.floor(f);
  const k = f - i;
  const a = points[i];
  const b = points[i + 1];
  return { p: [lerp(a[0], b[0], k), lerp(a[1], b[1], k)], a: Math.atan2(b[0] - a[0], b[1] - a[1]) };
}

// 榕树：4 条梢、交互排列的宽椭圆叶，叶面比纽约的悬铃木小、密度高。
function buildFicusSpray(rng) {
  const R = (a, b) => a + (b - a) * rng();
  const prims = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n - 0.5;
    const points = twigPoints(R, f * 0.05, 0, f * 1.45 + R(-0.12, 0.12), R(0.55, 0.7) * (1 - Math.abs(f) * 0.2), f * 0.5);
    prims.push({ type: 'twig', pts: points, w0: 0.014, w1: 0.005 });
    let side = rng() < 0.5 ? 1 : -1;
    for (let t = R(0.08, 0.14); t < 1.0; t += R(0.042, 0.06)) {
      const { p, a } = pointAt(points, t);
      side = -side;
      prims.push({ type: 'oval', p, a: a + side * R(0.55, 0.95), len: R(0.17, 0.24) * (1 - t * 0.16),
        wid: 0.5, skew: side * 0.05, t });
    }
    const tip = pointAt(points, 1);
    for (let k = 0; k < 3; k++) {
      prims.push({ type: 'oval', p: [tip.p[0] + R(-0.04, 0.04), tip.p[1] + R(-0.04, 0.04)],
        a: tip.a + R(-0.7, 0.7), len: R(0.15, 0.21), wid: 0.52, t: 1 });
    }
  }
  return prims;
}

// 香樟、宫粉紫荆、木棉：小叶、更多分枝、叶层更密，近看是普通阔叶冠。
function buildBroadleafSpray(rng) {
  const R = (a, b) => a + (b - a) * rng();
  const prims = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n - 0.5;
    const points = twigPoints(R, f * 0.06, 0, f * 1.5 + R(-0.15, 0.15), R(0.5, 0.68) * (1 - Math.abs(f) * 0.18), f * 0.6);
    prims.push({ type: 'twig', pts: points, w0: 0.012, w1: 0.004 });
    let side = rng() < 0.5 ? 1 : -1;
    for (let t = R(0.06, 0.12); t < 1.0; t += R(0.05, 0.07)) {
      const { p, a } = pointAt(points, t);
      side = -side;
      prims.push({ type: 'oval', p, a: a + side * R(0.5, 0.95), len: R(0.11, 0.17) * (1 - t * 0.15),
        wid: 0.44, skew: side * 0.06, t });
    }
    const tip = pointAt(points, 1);
    for (let k = 0; k < 3; k++) {
      prims.push({ type: 'oval', p: [tip.p[0] + R(-0.03, 0.03), tip.p[1] + R(-0.03, 0.03)],
        a: tip.a + R(-0.8, 0.8), len: R(0.1, 0.15), wid: 0.46, t: 1 });
    }
  }
  return prims;
}

// 棕榈：一根主脉从叶柄往上，两侧交互排列细长小叶，末端收尖。
function buildPalmFrond(rng) {
  const R = (a, b) => a + (b - a) * rng();
  const prims = [];
  const points = twigPoints(R, 0, 0, R(-0.08, 0.08), R(1.85, 2.05), 0.05, 14);
  prims.push({ type: 'twig', pts: points, w0: 0.02, w1: 0.006 });
  let side = 1;
  for (let t = 0.1; t < 1.0; t += R(0.045, 0.055)) {
    const { p, a } = pointAt(points, t);
    side = -side;
    const len = R(0.16, 0.3) * (1 - Math.max(0, t - 0.75) * 2.4);
    prims.push({ type: 'oval', p, a: a + side * R(1.1, 1.5), len, wid: 0.16, skew: side * 0.08, t });
  }
  prims.push({ type: 'oval', p: pointAt(points, 1).p, a: 0, len: 0.28, wid: 0.12, t: 1 });
  return prims;
}

// 凤凰木：二回羽状细碎叶，小叶片更窄。
function buildFeatherSpray(rng) {
  const R = (a, b) => a + (b - a) * rng();
  const prims = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n - 0.5;
    const rachis = twigPoints(R, f * 0.07, 0, f * 1.5 + R(-0.12, 0.12), R(0.6, 0.78), f * 0.5, 12);
    prims.push({ type: 'twig', pts: rachis, w0: 0.01, w1: 0.004 });
    let side = rng() < 0.5 ? 1 : -1;
    for (let t = 0.12; t < 1.0; t += R(0.07, 0.09)) {
      const { p, a } = pointAt(rachis, t);
      side = -side;
      for (const sd of [-1, 1]) {
        prims.push({ type: 'oval', p, a: a + sd * R(0.95, 1.25), len: R(0.07, 0.11) * (1 - t * 0.2),
          wid: 0.3, t });
      }
    }
  }
  return prims;
}

const TILE_SPRAYS = [
  { build: buildFicusSpray, seed: 0x51ed2701 },
  { build: buildBroadleafSpray, seed: 0x2f5c1a3b },
  { build: buildPalmFrond, seed: 0x77a1c3d5 },
  { build: buildFeatherSpray, seed: 0x1b7e49a2 }
];

function sprayBounds(prims) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const add = (x, y, r = 0) => {
    minX = Math.min(minX, x - r);
    maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r);
    maxY = Math.max(maxY, y + r);
  };
  for (const q of prims) {
    if (q.type === 'twig') for (const p of q.pts) add(p[0], p[1]);
    else add(q.p[0] + Math.sin(q.a) * q.len * 0.5, q.p[1] + Math.cos(q.a) * q.len * 0.5, q.len * 0.62);
  }
  return { minX, maxX, minY, maxY };
}

// 覆盖率保持的 mip 链：按格重标 alpha，远处 alpha 测试不会把树冠剃薄甚至剃没。
function coverageMips(level0, size, tiles, cutoff = 128) {
  const levels = [{ data: level0, width: size, height: size }];
  const tilePx = size / tiles;
  const target = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      let count = 0;
      for (let y = ty * tilePx; y < (ty + 1) * tilePx; y++) {
        for (let x = tx * tilePx; x < (tx + 1) * tilePx; x++) if (level0[(y * size + x) * 4 + 3] >= cutoff) count++;
      }
      target.push(count / (tilePx * tilePx));
    }
  }
  const meanTarget = target.reduce((a, b) => a + b, 0) / target.length;
  let src = level0;
  let w = size;
  const hist = new Uint32Array(256);
  while (w > 1) {
    const h = w >> 1;
    const dst = new Uint8Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const i0 = ((2 * y) * w + 2 * x) * 4;
        const i1 = i0 + w * 4;
        const o = (y * h + x) * 4;
        for (let c = 0; c < 4; c++) dst[o + c] = (src[i0 + c] + src[i0 + 4 + c] + src[i1 + c] + src[i1 + 4 + c] + 2) >> 2;
      }
    }
    const nt = h >= tiles ? tiles : 1;
    const tp = h / nt;
    for (let ty = 0; ty < nt; ty++) {
      for (let tx = 0; tx < nt; tx++) {
        const want = (nt === tiles ? target[ty * tiles + tx] : meanTarget) * tp * tp;
        hist.fill(0);
        for (let y = ty * tp; y < (ty + 1) * tp; y++) for (let x = tx * tp; x < (tx + 1) * tp; x++) hist[dst[(y * h + x) * 4 + 3]]++;
        let acc = 0;
        let aStar = 255;
        for (let a = 255; a >= 1; a--) {
          acc += hist[a];
          if (acc >= want) {
            aStar = a;
            break;
          }
        }
        const scale = cutoff / Math.max(aStar, 1);
        if (Math.abs(scale - 1) < 0.01) continue;
        for (let y = ty * tp; y < (ty + 1) * tp; y++) {
          for (let x = tx * tp; x < (tx + 1) * tp; x++) {
            const i = (y * h + x) * 4 + 3;
            dst[i] = Math.min(255, Math.round(dst[i] * scale));
          }
        }
      }
    }
    levels.push({ data: dst, width: h, height: h });
    src = dst;
    w = h;
  }
  return levels;
}

function drawAtlasTiles() {
  const make2d = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ATLAS_SIZE;
    return canvas.getContext('2d', { willReadFrequently: true });
  };
  const col = make2d();
  const cov = make2d();
  col.fillStyle = 'rgb(170, 128, 0)';
  col.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  for (const c of [col, cov]) {
    c.lineCap = 'round';
    c.lineJoin = 'round';
  }
  const tileMeters = [];
  const drawTile = (tile, prims, rng) => {
    const R = (a, b) => a + (b - a) * rng();
    const b = sprayBounds(prims);
    const ox = (tile % TILES) * TILE;
    const oy = Math.floor(tile / TILES) * TILE;
    const room = TILE - 2 * GUTTER;
    // 附着点在底边中点：卡片贴到树梢后，叶簇向上展开；棕榈羽叶也一样。
    const s = Math.min((room / 2) / Math.max(-b.minX, b.maxX, 0.01), room / Math.max(b.maxY, 0.01));
    tileMeters[tile] = room / s;
    const cx = ox + TILE / 2;
    const by = oy + TILE - GUTTER;
    const X = p => cx + p[0] * s;
    const Y = p => by - p[1] * s;
    const frame = (P, a, L, W) => {
      const d = [Math.sin(a), -Math.cos(a)];
      const x0 = X(P);
      const y0 = Y(P);
      return (u, v) => [x0 + d[0] * u * L * s - d[1] * v * W * s, y0 + d[1] * u * L * s + d[0] * v * W * s];
    };
    const ovalPath = (c, f, skew) => {
      c.moveTo(...f(0, 0));
      c.bezierCurveTo(...f(0.05, 0.6 + skew), ...f(0.6, 0.62), ...f(1, 0));
      c.bezierCurveTo(...f(0.6, -0.62), ...f(0.05, -0.6 + skew), ...f(0, 0));
    };
    const fill = (path, rgb) => {
      for (const [c, style] of [[col, rgb], [cov, '#fff']]) {
        c.beginPath();
        path(c);
        c.fillStyle = style;
        c.fill();
      }
    };
    const stroke = (points, w0, w1, rgb) => {
      for (let i = 0; i < points.length - 1; i++) {
        const width = Math.max(0.8, lerp(w0, w1, i / (points.length - 1)) * s);
        for (const [c, style] of [[col, rgb], [cov, '#fff']]) {
          c.beginPath();
          c.moveTo(X(points[i]), Y(points[i]));
          c.lineTo(X(points[i + 1]), Y(points[i + 1]));
          c.lineWidth = width;
          c.strokeStyle = style;
          c.stroke();
        }
      }
    };
    const rgb = (r, g, bl = 0) => `rgb(${r}, ${g}, ${bl})`;
    for (const q of prims) {
      if (q.type === 'twig') {
        stroke(q.pts, q.w0, q.w1, rgb(110, 128, 255));
        continue;
      }
      // 越靠叶簇外缘越亮，少数老叶压暗。
      const r = Math.min(255, Math.round(255 * R(0.6, 0.9) * (0.8 + 0.2 * q.t)));
      const g = Math.round(255 * rng());
      const f = frame(q.p, q.a, q.len, q.len * q.wid);
      fill(c => ovalPath(c, f, q.skew || 0), rgb(r, g));
      if (q.len * s > 8) {
        col.beginPath();
        ovalPath(col, frame(q.p, q.a, q.len, q.len * q.wid * 0.22), 0);
        col.fillStyle = rgb(Math.round(r * 0.82), g);
        col.fill();
      }
    }
  };
  TILE_SPRAYS.forEach((spec, tile) => {
    const rng = mulberry32(CROWN_SEED ^ spec.seed);
    drawTile(tile, spec.build(rng), rng);
  });
  const data = col.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
  const mask = cov.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
  const level0 = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  for (let i = 0; i < level0.length; i += 4) {
    level0[i] = data[i];
    level0[i + 1] = data[i + 1];
    level0[i + 2] = data[i + 2];
    level0[i + 3] = mask[i + 3];
  }
  const tex = new THREE.DataTexture(level0, ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = coverageMips(level0, ATLAS_SIZE, TILES);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'ShenzhenTreeLeafAtlas';
  return { texture: tex, tileMeters, atlasSize: ATLAS_SIZE, gutter: GUTTER, tiles: TILES };
}

function createHeadlessLeafAtlas() {
  const size = HEADLESS_ATLAS_SIZE;
  const data = new Uint8Array(size * size * 4);
  const rng = mulberry32(CROWN_SEED ^ 0x2f5c1a3b);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const disc = (x % 16 - 8) ** 2 + (y % 16 - 8) ** 2 <= 30;
    const o = i * 4;
    data[o] = disc ? 150 + Math.round(rng() * 60) : 170;
    data[o + 1] = Math.round(rng() * 255);
    data[o + 2] = 0;
    data[o + 3] = disc ? 255 : 0;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'ShenzhenTreeLeafAtlasHeadless';
  return { texture: tex, tileMeters: [1.7, 1.7, 1.9, 1.7], atlasSize: size, gutter: 0, tiles: TILES, headless: true };
}

function createLeafAtlas() {
  if (typeof document === 'undefined') return createHeadlessLeafAtlas();
  return drawAtlasTiles();
}

// --------------------------------------------------------------- 骨架
// 单位向量 `angle` 偏离 `dir`，再绕它转 `azimuth`。
function deflect(dir, angle, azimuth) {
  const ref = Math.abs(dir.y) < 0.95 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const u = new V3().crossVectors(dir, ref).normalize();
  const w = new V3().crossVectors(dir, u);
  return dir.clone().multiplyScalar(Math.cos(angle))
    .addScaledVector(u, Math.sin(angle) * Math.cos(azimuth))
    .addScaledVector(w, Math.sin(angle) * Math.sin(azimuth))
    .normalize();
}

// 一条枝条：从 p0 沿 dir 长 len 米，按 up/out/droop 弯曲；返回折线和半径。
function growBranch(p0, dir, len, r0, r1, segs, bend, rng, level) {
  const ts = Array.from({ length: segs + 1 }, (_, i) => i / segs);
  const pts = [p0.clone()];
  const rad = [r0];
  const d = dir.clone();
  const p = p0.clone();
  const out = new V3();
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i];
    const step = (t - ts[i - 1]) * len;
    out.set(p.x, 0, p.z);
    if (out.lengthSq() > 1e-6) out.normalize();
    d.x += out.x * bend.out * step + (rng() - 0.5) * bend.jitter;
    d.y += (bend.up - bend.droop * t * 2.0) * step + (rng() - 0.5) * bend.jitter * 0.6;
    d.z += out.z * bend.out * step + (rng() - 0.5) * bend.jitter;
    d.normalize();
    p.addScaledVector(d, step);
    pts.push(p.clone());
    rad.push(r0 + (r1 - r0) * Math.pow(t, 0.8));
  }
  return { pts, rad, len, level, ts };
}

function along(b, t) {
  const ts = b.ts;
  let i = 0;
  while (i < ts.length - 2 && ts[i + 1] < t) i++;
  const k = Math.min(1, Math.max(0, (t - ts[i]) / (ts[i + 1] - ts[i])));
  return {
    p: b.pts[i].clone().lerp(b.pts[i + 1], k),
    d: b.pts[i + 1].clone().sub(b.pts[i]).normalize(),
    r: lerp(b.rad[i], b.rad[i + 1], k)
  };
}

// --------------------------------------------------------------- 树种形态
// 骨架参数：主干以上从低处/高处出粗枝，再分二级枝和细枝；尺度是“标准树”米，生成后统一归一化。
// 各树种的差别只在比例：榕树宽冠低分枝、香樟椭圆冠、凤凰木伞形平冠、宫粉紫荆小圆冠、木棉高直稀疏冠。
const CROWN_SPECIES = {
  ficus: {
    kind: 'broadleaf', tile: TILE_FICUS, seedSalt: 0,
    leader: { r: 0.24, top: 2.4, lean: 0.05, segs: 4 },
    limbs: { n: 6, y: [0.15, 2.2], tilt: [1.16, 0.62], len: [3.9, 3.1], r: 0.72,
      up: 0.04, out: 0.05, droop: 0.08, jitter: 0.11, segs: 5 },
    branches: { n: 4, t: [0.3, 0.98], angle: [0.55, 1.0], len: [0.52, 0.36],
      up: 0.02, out: 0.04, droop: 0.06, jitter: 0.13, segs: 4 },
    twigs: { n: 3, t: [0.25, 1.0], angle: [0.5, 1.0], len: [1.15, 0.8],
      up: 0, out: 0, droop: 0.12, jitter: 0.14, segs: 2 },
    cards: { perTwig: 6, scale: [1.12, 1.45], droop: 0.14 }
  },
  camphor: {
    kind: 'broadleaf', tile: TILE_BROAD, seedSalt: 7919,
    leader: { r: 0.2, top: 3.3, lean: 0.04, segs: 4 },
    limbs: { n: 6, y: [0.3, 2.8], tilt: [0.92, 0.45], len: [3.3, 2.7], r: 0.7,
      up: 0.07, out: 0.03, droop: 0.04, jitter: 0.1, segs: 5 },
    branches: { n: 5, t: [0.28, 0.98], angle: [0.55, 1.0], len: [0.5, 0.36],
      up: 0.03, out: 0.03, droop: 0.05, jitter: 0.12, segs: 4 },
    twigs: { n: 3, t: [0.25, 1.0], angle: [0.55, 1.05], len: [1.0, 0.72],
      up: 0, out: 0, droop: 0.1, jitter: 0.13, segs: 2 },
    cards: { perTwig: 5, scale: [1.0, 1.3], droop: 0.12 }
  },
  phoenix: {
    kind: 'broadleaf', tile: TILE_FEATHER, seedSalt: 15838,
    leader: { r: 0.17, top: 2.2, lean: 0.05, segs: 3 },
    limbs: { n: 7, y: [0.2, 1.9], tilt: [1.32, 0.98], len: [3.9, 3.2], r: 0.66,
      up: 0.02, out: 0.06, droop: 0.02, jitter: 0.12, segs: 5 },
    branches: { n: 4, t: [0.3, 0.98], angle: [0.65, 1.1], len: [0.5, 0.38],
      up: 0.02, out: 0.05, droop: 0.05, jitter: 0.14, segs: 4 },
    twigs: { n: 3, t: [0.25, 1.0], angle: [0.5, 1.0], len: [1.05, 0.75],
      up: 0, out: 0, droop: 0.2, jitter: 0.15, segs: 2 },
    cards: { perTwig: 5, scale: [1.0, 1.3], droop: 0.2 }
  },
  bauhinia: {
    kind: 'broadleaf', tile: TILE_BROAD, seedSalt: 23757,
    leader: { r: 0.16, top: 1.8, lean: 0.06, segs: 3 },
    limbs: { n: 5, y: [0.15, 1.5], tilt: [1.05, 0.7], len: [2.5, 2.1], r: 0.66,
      up: 0.05, out: 0.04, droop: 0.06, jitter: 0.12, segs: 4 },
    branches: { n: 4, t: [0.3, 0.98], angle: [0.55, 1.0], len: [0.52, 0.38],
      up: 0.02, out: 0.03, droop: 0.05, jitter: 0.13, segs: 4 },
    twigs: { n: 4, t: [0.25, 1.0], angle: [0.5, 1.0], len: [0.9, 0.65],
      up: 0, out: 0, droop: 0.1, jitter: 0.14, segs: 2 },
    cards: { perTwig: 5, scale: [0.85, 1.1], droop: 0.1 }
  },
  kapok: {
    kind: 'broadleaf', tile: TILE_BROAD, seedSalt: 31676,
    leader: { r: 0.2, top: 4.5, lean: 0.03, segs: 4 },
    limbs: { n: 5, y: [1.4, 4.0], tilt: [0.62, 0.34], len: [2.7, 2.1], r: 0.6,
      up: 0.08, out: 0.03, droop: 0.02, jitter: 0.09, segs: 4 },
    branches: { n: 3, t: [0.35, 0.98], angle: [0.5, 0.9], len: [0.46, 0.34],
      up: 0.04, out: 0.02, droop: 0.03, jitter: 0.11, segs: 4 },
    twigs: { n: 2, t: [0.3, 1.0], angle: [0.5, 1.0], len: [0.95, 0.7],
      up: 0, out: 0, droop: 0.1, jitter: 0.13, segs: 2 },
    cards: { perTwig: 4, scale: [1.0, 1.3], droop: 0.1 }
  },
  'royal-palm': {
    kind: 'palm', tile: TILE_PALM, seedSalt: 39595,
    fronds: 16, length: [2.3, 3.3], tilt: [0.5, 1.62], scale: [1.5, 2.3]
  }
};


function growBroadleaf(habit, seed) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const branches = [];
  const still = { up: 0, out: 0, droop: 0, jitter: 0.02 };
  const L = habit.leader;
  const lean = R(0, Math.PI * 2);
  const trunkDir = new V3(Math.cos(lean) * L.lean, 1, Math.sin(lean) * L.lean).normalize();
  const leader = growBranch(new V3(0, 0, 0), trunkDir, L.top, L.r, L.r * 0.25, L.segs, still, rng, 0);
  branches.push(leader);

  const limb = habit.limbs;
  const branch = habit.branches;
  const twigHabit = habit.twigs;
  let az = R(0, Math.PI * 2);
  for (let i = 0; i < limb.n; i++) {
    const f = limb.n > 1 ? i / (limb.n - 1) : 0;
    const y = lerp(limb.y[0], limb.y[1], f) + R(-0.2, 0.2);
    const base = along(leader, Math.min(0.98, y / L.top));
    az += 2.39996 + R(-0.35, 0.35);
    const tilt = lerp(limb.tilt[0], limb.tilt[1], f) + R(-0.08, 0.08);
    const dir = new V3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
    const len = lerp(limb.len[0], limb.len[1], f) * R(0.88, 1.1);
    const limbBranch = growBranch(base.p, dir, len, base.r * limb.r, 0.04, limb.segs, limb, rng, 1);
    branches.push(limbBranch);

    const nb = branch.n + (rng() < 0.5 ? 1 : 0);
    let baz = R(0, Math.PI * 2);
    for (let j = 0; j < nb; j++) {
      const bt = lerp(branch.t[0], branch.t[1], (j + R(0.15, 0.85)) / nb);
      const a = along(limbBranch, bt);
      baz += 2.39996 + R(-0.4, 0.4);
      const bdir = deflect(a.d, R(branch.angle[0], branch.angle[1]), baz);
      const outw = new V3(a.p.x, 0, a.p.z).normalize();
      if (bdir.dot(outw) < -0.15) bdir.addScaledVector(outw, 0.7).normalize();
      const blen = len * lerp(branch.len[0], branch.len[1], bt) * R(0.85, 1.12);
      const b = growBranch(a.p, bdir, blen, Math.max(0.03, a.r * 0.62), 0.02, branch.segs, branch, rng, 2);
      branches.push(b);

      const nw = twigHabit.n + (rng() < 0.4 ? 1 : 0);
      let taz = R(0, Math.PI * 2);
      for (let k = 0; k < nw; k++) {
        const tt = lerp(twigHabit.t[0], twigHabit.t[1], (k + R(0.2, 0.8)) / nw);
        const ta = along(b, tt);
        taz += 2.39996 + R(-0.5, 0.5);
        const tdir = deflect(ta.d, R(twigHabit.angle[0], twigHabit.angle[1]), taz);
        const tw = growBranch(ta.p, tdir, lerp(twigHabit.len[0], twigHabit.len[1], tt) * R(0.8, 1.2),
          Math.max(0.014, ta.r * 0.7), 0.008, twigHabit.segs, twigHabit, rng, 3);
        branches.push(tw);
      }
    }
  }
  return branches;
}

// --------------------------------------------------------------- 几何
class CrownGeometryBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.attr = [];
    this.idx = [];
  }

  vertex(p, n, u, v, leaf, ao, sway, rnd) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.attr.push(leaf, ao, sway, rnd);
    return this.pos.length / 3 - 1;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTree', new THREE.Float32BufferAttribute(this.attr, 4));
    const vCount = this.pos.length / 3;
    g.setIndex(vCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// 沿枝条生成锥形管：平行传输环，uv 以米为单位（树皮）。
function addTube(gb, b, radial, stride, aoAt, swayAt) {
  const n = b.pts.length;
  const keep = [];
  for (let i = 0; i < n; i += stride) keep.push(i);
  if (keep[keep.length - 1] !== n - 1) keep.push(n - 1);
  const tangent = i => b.pts[Math.min(n - 1, i + 1)].clone().sub(b.pts[Math.max(0, i - 1)]).normalize();
  let T = tangent(keep[0]);
  let N = Math.abs(T.y) < 0.9 ? new V3(0, 1, 0).cross(T).normalize() : new V3(1, 0, 0).cross(T).normalize();
  const q = new THREE.Quaternion();
  const around = 2 * Math.PI * Math.max(b.rad[0], 0.02);
  let vLen = 0;
  const base = gb.pos.length / 3;
  const dir = new V3();
  const p = new V3();
  keep.forEach((index, ki) => {
    if (ki > 0) {
      const T2 = tangent(index);
      q.setFromUnitVectors(T, T2);
      N.applyQuaternion(q).normalize();
      T = T2;
      vLen += b.pts[index].distanceTo(b.pts[keep[ki - 1]]);
    }
    const Bn = new V3().crossVectors(T, N);
    const t = b.ts[index];
    const ao = aoAt(b.pts[index]);
    const sway = swayAt(b, t);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(ang)).addScaledVector(Bn, Math.sin(ang));
      p.copy(b.pts[index]).addScaledVector(dir, b.rad[index]);
      gb.vertex(p, dir, (j / radial) * around, vLen, 0, ao, sway, 0);
    }
  });
  for (let k = 0; k < keep.length - 1; k++) {
    for (let j = 0; j < radial; j++) {
      const a = base + k * (radial + 1) + j;
      const c = a + radial + 1;
      gb.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
}

// 叶卡：底边中点贴在 at，沿 up 方向立起，正面朝 face；uv 取图集对应格（可镜像）。
function addCard(gb, at, up, face, size, tile, mirror, rnd, crown, atlas) {
  const side = new V3().crossVectors(up, face).normalize();
  const nrm = new V3().crossVectors(side, up).normalize();
  const ox = (tile % atlas.tiles) * TILE;
  const oy = Math.floor(tile / atlas.tiles) * TILE;
  const tileSize = atlas.atlasSize / atlas.tiles;
  let u0 = (ox + atlas.gutter) / atlas.atlasSize;
  let u1 = (ox + tileSize - atlas.gutter) / atlas.atlasSize;
  if (mirror) [u0, u1] = [u1, u0];
  const vTop = (oy + atlas.gutter) / atlas.atlasSize;
  const vBot = (oy + tileSize - atlas.gutter) / atlas.atlasSize;
  const corners = [
    [-0.5, 0, u0, vBot],
    [0.5, 0, u1, vBot],
    [0.5, 1, u1, vTop],
    [-0.5, 1, u0, vTop]
  ];
  const base = gb.pos.length / 3;
  const p = new V3();
  for (const [sx, sy, u, v] of corners) {
    p.copy(at).addScaledVector(side, sx * size).addScaledVector(up, sy * size);
    const { n, ao } = crown.shade(p, nrm);
    gb.vertex(p, n, u, v, 1, ao, lerp(0.8, 1.0, sy), rnd);
  }
  gb.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// 树冠椭球：外壳法线 + 内部遮蔽。卡片背面和正面用同一份壳法线，整冠像一个体积在受光。
function makeCrown(points) {
  const box = new THREE.Box3().setFromPoints(points);
  const C = box.getCenter(new V3());
  const R = box.getSize(new V3()).multiplyScalar(0.5).max(new V3(0.5, 0.5, 0.5));
  const tmp = new V3();
  const sn = new V3();
  return {
    C,
    R,
    bottom: box.min.y,
    shade(p, face) {
      tmp.copy(p).sub(C).divide(R);
      const e = tmp.length();
      sn.copy(tmp).normalize();
      sn.y += 0.22;
      sn.normalize();
      const f = face.dot(sn) < 0 ? face.clone().negate() : face.clone();
      const n = sn.clone().multiplyScalar(0.72).addScaledVector(f, 0.28).normalize();
      const top = Math.min(1, Math.max(-1, (p.y - C.y) / R.y));
      const ao = (0.22 + 0.78 * smooth(0.15, 1.0, e)) * (0.86 + 0.14 * top);
      return { n, ao };
    },
    barkAO(p) {
      if (p.y < box.min.y) return 0.9;
      tmp.copy(p).sub(C).divide(R);
      return lerp(0.32, 0.8, smooth(0.2, 1.0, tmp.length()));
    }
  };
}

function swayWeight(b, t) {
  switch (b.level) {
    case 0: return 0;
    case 1: return 0.18 * t;
    case 2: return 0.18 + 0.4 * t;
    default: return 0.58 + 0.4 * t;
  }
}

// 近景细枝上的小叶卡，加二级枝末端两张补缝。
function placeCards(habit, branches, rng, crown, tileMeters) {
  const R = (a, b) => a + (b - a) * rng();
  const cards = [];
  const outward = p => new V3(p.x - crown.C.x, (p.y - crown.C.y) * 0.6, p.z - crown.C.z).normalize();
  const orient = (p, d, droop) => {
    const o = outward(p);
    const up = d.clone().multiplyScalar(0.55).addScaledVector(o, 0.45)
      .add(new V3(R(-0.3, 0.3), R(-0.2, 0.3), R(-0.3, 0.3)));
    up.y -= droop;
    up.normalize();
    let face = o.clone().add(new V3(R(-0.9, 0.9), R(-0.6, 0.9), R(-0.9, 0.9))).normalize();
    face.addScaledVector(up, -face.dot(up));
    if (face.lengthSq() < 1e-4) face = new V3(0, 1, 0).cross(up);
    return { up, face: face.normalize() };
  };
  const habits = habit.cards;
  for (const b of branches) {
    if (b.level === 3) {
      for (let k = 0; k < habits.perTwig; k++) {
        const t = lerp(0.4, 1.0, (k + R(0.3, 0.9)) / habits.perTwig);
        const a = along(b, t);
        const { up, face } = orient(a.p, a.d, habits.droop);
        cards.push({ at: a.p, up, face, size: tileMeters * R(habits.scale[0], habits.scale[1]) });
      }
    } else if (b.level === 2) {
      for (const t of [0.72, 1.0]) {
        const a = along(b, t);
        const { up, face } = orient(a.p, a.d, habits.droop);
        cards.push({ at: a.p, up, face, size: tileMeters * R(1.15, 1.45) });
      }
    }
  }
  return cards;
}

// 归一化：水平按最大冠幅（半宽 0.5），垂直以枝条起点 y=0 为冠底、冠顶为 1。
// 不把最低点抬到 0：下垂叶卡可以略低于树干顶，正好和圆柱搭接。
function normalizeGeometry(geometry) {
  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  let minX = Infinity; let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const width = Math.max(maxX - minX, maxZ - minZ, 0.001);
  const height = Math.max(maxY, 0.001);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, (pos.getX(i) - cx) / width, pos.getY(i) / height, (pos.getZ(i) - cz) / width);
    normal.setXYZ(i, normal.getX(i), normal.getY(i), normal.getZ(i));
  }
  normal.needsUpdate = true;
  pos.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}

function buildBroadleafGeometry(name, habit, atlas) {
  const seed = CROWN_SEED + habit.seedSalt;
  const rng = mulberry32(seed);
  const branches = growBroadleaf(habit, seed);
  const tips = [];
  for (const b of branches) if (b.level === 3) tips.push(b.pts[b.pts.length - 1]);
  const roughCrown = makeCrown(tips);
  const rngC = mulberry32(seed ^ 0x5bd1e995);
  const cards0 = placeCards(habit, branches, rngC, roughCrown, atlas.tileMeters[habit.tile]);
  const points = [];
  for (const c of cards0) {
    points.push(c.at.clone().addScaledVector(c.up, c.size * 0.5));
    points.push(c.at.clone().addScaledVector(c.up, c.size));
  }
  const crown = makeCrown(points);
  const gb = new CrownGeometryBuilder();
  const aoAt = p => crown.barkAO(p);
  for (const b of branches) {
    if (b.level <= 2) addTube(gb, b, [4, 4, 3][b.level], [2, 3, 4][b.level], aoAt, swayWeight);
  }
  const barkTriangles = gb.idx.length / 3;
  for (const c of cards0) {
    addCard(gb, c.at, c.up, c.face, c.size, habit.tile, rng() < 0.5, rng(), crown, atlas);
  }
  const geometry = gb.build();
  normalizeGeometry(geometry);
  const triangles = geometry.index.count / 3;
  geometry.userData = { species: name, kind: habit.kind, seed, triangles, cards: cards0.length,
    barkTriangles, tile: habit.tile, tileMeters: atlas.tileMeters[habit.tile], atlasSize: atlas.atlasSize };
  return { geometry, triangles, cards: cards0.length, barkTriangles, seed, tile: habit.tile };
}

// 棕榈：从树干顶放射出羽叶卡片；没有分枝骨架和树皮管。
function buildPalmGeometry(name, habit, atlas) {
  const seed = CROWN_SEED + habit.seedSalt;
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const cards = [];
  const n = habit.fronds;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const az = i * 2.39996 + R(-0.12, 0.12);
    const tilt = lerp(habit.tilt[0], habit.tilt[1], f) + R(-0.1, 0.1);
    const len = lerp(habit.length[0], habit.length[1], f) * R(1, 1.08);
    const up = new V3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)).normalize();
    // 叶面朝外：水平径向外法线去掉沿叶轴分量。
    const outward = new V3(Math.cos(az), 0, Math.sin(az));
    let face = outward.clone().addScaledVector(up, -outward.dot(up));
    if (face.lengthSq() < 1e-4) face = new V3(-Math.sin(az), 0, Math.cos(az));
    face.normalize();
    const at = new V3(0, 0, 0);
    // 羽叶卡片长度随外圈叶序略增，内圈短、外圈长。
    const size = atlas.tileMeters[habit.tile] * R(habit.scale[0], habit.scale[1]) * (0.9 + len * 0.05);
    cards.push({ at, up, face, size });
  }
  const points = [];
  for (const c of cards) {
    points.push(c.at.clone().addScaledVector(c.up, c.size * 0.5));
    points.push(c.at.clone().addScaledVector(c.up, c.size));
  }
  const crown = makeCrown(points);
  const gb = new CrownGeometryBuilder();
  for (const c of cards) addCard(gb, c.at, c.up, c.face, c.size, habit.tile, rng() < 0.5, rng(), crown, atlas);
  const geometry = gb.build();
  normalizeGeometry(geometry);
  const triangles = geometry.index.count / 3;
  geometry.userData = { species: name, kind: 'palm', seed, triangles, cards: cards.length,
    barkTriangles: 0, tile: habit.tile, tileMeters: atlas.tileMeters[habit.tile], atlasSize: atlas.atlasSize };
  return { geometry, triangles, cards: cards.length, barkTriangles: 0, seed, tile: habit.tile };
}

/**
 * 构建一个树种的近景叶卡树冠几何。坐标已归一化：冠底 y=0、冠顶 y≈1、水平半宽 0.5；
 * 实例缩放传 (冠幅, 冠高, 冠幅) 就得到数据里的冠幅和树高。
 */
export function buildCrownGeometry(name, atlas = createLeafAtlas()) {
  const habit = CROWN_SPECIES[name];
  if (!habit) throw new Error(`Unhandled crown species: ${name}`);
  switch (habit.kind) {
    case 'broadleaf': return buildBroadleafGeometry(name, habit, atlas);
    case 'palm': return buildPalmGeometry(name, habit, atlas);
    default: throw new Error(`Unhandled crown kind: ${habit.kind}`);
  }
}

// --------------------------------------------------------------- 材质
// 深圳主导风（xz）：只是外观参数，不是气象实测。
const TREE_WIND = vec2(0.86, 0.51);

// 阳光透过叶片：沿视线看过去，叶子像磨砂玻璃一样亮起来。直接光颜色和阴影一起进入，树冠自阴影也会压暗透光。
class FoliageLightingModel extends THREE.PhysicalLightingModel {
  direct(lightData, builder) {
    const { lightDirection, lightColor, reflectedLight } = lightData;
    const translucency = builder.material.translucencyNode;
    if (translucency) {
      const scatter = normalize(lightDirection.add(normalView.mul(0.3)));
      const through = pow(clamp(dot(positionViewDirection, scatter.negate()), 0.0, 1.0), 3.0);
      reflectedLight.directDiffuse.addAssign(lightColor.mul(translucency).mul(through));
    }
    super.direct(lightData, builder);
  }
}

class TreeCrownMaterial extends THREE.MeshStandardNodeMaterial {
  static get type() {
    return 'TreeCrownMaterial';
  }

  constructor(parameters) {
    super(parameters);
    this.translucencyNode = null;
  }

  setupLightingModel() {
    return new FoliageLightingModel();
  }
}

/**
 * 近景树冠材质：树皮管和 alpha 测试叶卡共用一个 draw。几何属性：
 * - uv：叶卡取图集对应格；树皮按米展开
 * - normal：叶卡用树冠壳法线，正反面同向，整冠像一个被照亮的体积
 * - aTree vec4：x 叶卡=1/树皮=0，y 冠内遮蔽，z 风摆权重，w 每张叶卡的扑动相位
 * - aTreeData vec4（实例）：rgb 每棵树的叶色，w 随机数
 * - aTreeSway vec2（实例）：x 世界米级的整树摆幅（按树高给），y 相位
 */
export function createTreeCrownMaterial(leafAtlas) {
  const mat = new TreeCrownMaterial({
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    metalness: 0.0,
    roughness: 0.8
  });

  const aTree = attribute('aTree', 'vec4');
  const aData = attribute('aTreeData', 'vec4');
  const aSway = attribute('aTreeSway', 'vec2');
  const isLeaf = aTree.x;
  const crownAO = aTree.y;
  const rnd = fract(aData.w);
  const leaf = texture(leafAtlas, uv());

  // 风摆：positionLocal 已经过实例矩阵（世界空间），positionGeometry 是归一化后的本树坐标。
  mat.positionNode = Fn(() => {
    const p = positionLocal;
    const g = positionGeometry;
    const phase = rnd.mul(6.2832);
    const gust = sin(time.mul(0.5).sub(dot(p.xz, TREE_WIND).mul(0.045))).mul(0.5).add(0.5);
    const strength = gust.mul(gust).mul(0.7).add(0.3);
    const bend = g.y.mul(g.y);
    const lean = sin(time.mul(0.85).add(phase)).mul(0.45).add(0.55).mul(strength).mul(aSway.x);
    const rock = sin(time.mul(0.67).add(phase.mul(1.7))).mul(0.25).mul(strength).mul(aSway.x);
    const sway = vec3(TREE_WIND.x.mul(lean).sub(TREE_WIND.y.mul(rock)), 0.0,
      TREE_WIND.y.mul(lean).add(TREE_WIND.x.mul(rock))).mul(bend);
    const bob = sin(time.mul(2.1).add(g.x.mul(9.0)).add(g.z.mul(7.0)).add(phase)).mul(0.04).mul(aTree.z).mul(strength);
    const flutter = sin(time.mul(8.0).add(aTree.w.mul(37.0)).add(g.y.mul(2.0))).mul(0.03).mul(isLeaf).mul(aTree.z)
      .mul(strength.add(0.25));
    return p.add(sway).add(vec3(0.0, bob, 0.0)).add(normalLocal.mul(flutter));
  })();

  const alpha = mix(float(frontFacing), leaf.a, isLeaf);
  mat.alphaTest = 0.5;

  mat.colorNode = Fn(() => {
    // 叶片：每棵树的叶色 × 图集亮度，混入少量偏黄和偏冷的叶子，枝条/叶柄用褐色，冠内压暗。
    const tint = aData.xyz;
    const base = tint.mul(leaf.r.mul(1.4));
    const warm = smoothstep(0.62, 1.0, leaf.g).mul(0.55);
    const cool = smoothstep(0.38, 0.0, leaf.g).mul(0.45);
    const leafCol = mix(mix(base, base.mul(vec3(1.22, 1.06, 0.55)), warm), base.mul(vec3(0.82, 0.94, 1.06)), cool);
    const foliage = mix(leafCol, color(0x4a3b2c), leaf.b).mul(crownAO.mul(0.45).add(0.55));

    // 树皮：uv 以米展开，做纵向沟槽；深褐，比叶暗。
    const bu = uv();
    const ridge = smoothstep(0.28, 0.78, fract(bu.y.mul(0.55).add(bu.x.mul(0.12))));
    const bark = mix(color(0x39302a), color(0x6b5946), ridge).mul(crownAO.mul(0.4).add(0.6));

    return vec4(mix(bark, foliage, isLeaf), alpha);
  })();

  mat.roughnessNode = mix(float(0.93), float(0.72).sub(leaf.r.mul(0.1)), isLeaf);
  mat.normalNode = normalViewGeometry;
  mat.aoNode = crownAO.mul(0.75).add(0.25);
  mat.translucencyNode = aData.xyz.mul(vec3(1.0, 1.2, 0.45)).mul(leaf.r.mul(1.5))
    .mul(crownAO.mul(0.8).add(0.2)).mul(isLeaf);
  return mat;
}

// --------------------------------------------------------------- 对外入口
/**
 * 近景树冠库：每个树种一份共享几何，材质和叶卡图集全场共用。
 * sz-trees.js 每个 LOD 子格、每个树种建一个实例网格，几何属性共享，只多一份实例属性和矩阵。
 */
export function createCrownLibrary(names = Object.keys(CROWN_SPECIES)) {
  const atlas = createLeafAtlas();
  const geometries = new Map();
  const stats = [];
  for (const name of names) {
    if (!CROWN_SPECIES[name]) throw new Error(`Unhandled crown species: ${name}`);
    const built = buildCrownGeometry(name, atlas);
    geometries.set(name, built.geometry);
    stats.push({ name, seed: built.seed, triangles: built.triangles, barkTriangles: built.barkTriangles,
      cards: built.cards, tile: built.tile, kind: CROWN_SPECIES[name].kind,
      tileMeters: atlas.tileMeters[built.tile] });
  }
  const material = createTreeCrownMaterial(atlas.texture);
  material.name = 'shenzhen-tree-crown';
  const triangles = Object.fromEntries(stats.map(item => [item.name, item.triangles]));
  return {
    material,
    atlas,
    geometryFor(name) {
      const geometry = geometries.get(name);
      if (!geometry) throw new Error(`Tree crown geometry not built: ${name}`);
      return geometry;
    },
    hasSpecies(name) {
      return geometries.has(name);
    },
    statistics: { species: stats, triangles, headlessAtlas: Boolean(atlas.headless) },
    dispose() {
      for (const geometry of geometries.values()) geometry.dispose();
      geometries.clear();
      atlas.texture.dispose();
      material.dispose();
    }
  };
}

export { CROWN_SPECIES, CROWN_SEED, TILE_FICUS, TILE_BROAD, TILE_PALM, TILE_FEATHER, TREE_WIND };
