import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, cameraPosition, cameraViewMatrix, clamp, color, dot, float, floor, fract, fwidth, length, max, min,
  mix, normalize, normalWorldGeometry, positionWorld, pow, reflect, sin, smoothstep, sqrt, step, texture, time, vec2,
  vec3, vec4
} from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';

// 深圳湾海面、内河与水库共用的 TSL 水面材质（V3 水面）。
// 做法移植自纽约 createWaterMaterial（ref/slop-newyork/js/tsl-materials.js 2894）和武汉
// createWaterMaterial（ref/slop-wuhan/js/runtime/tsl-materials.js 2468）：四层波浪贴图给法线，
// 未解析坡度方差给粗糙度，菲涅尔进金属度；夜间用解析楼群带做出岸线灯光反光。
// 地理换成深圳湾：城市在北侧（世界 x 向东、z 向南为正），所以反射射线朝北（R.z < 0）才看得到楼群。
// 只读 cityUniforms 的时段参数（uInteriorGlow），不写它。

// 确定性 2D -> 1D 哈希与平滑值噪声（纽约 83/88，武汉同）。
const hash2D = Fn(([p]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// 周期脉冲的盒滤波：足迹宽 w 时 fract(x) 落在 [a, b] 内的比例；周期小于像素后收敛到均值 (b-a)，
// 所以远处楼窗不会闪烁或出摩尔纹。
const filteredPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});

// 非周期区间 [a, b] 被窗口 [x - s, x + s] 覆盖的比例：点位光和窄带灯的精确盒滤波。
const waterBoxCover = Fn(([x, a, b, s]) => {
  const xv = float(x).toVar();
  const sv = max(float(s), 0.001).toVar();
  return clamp(min(xv.add(sv), b).sub(max(xv.sub(sv), a)).div(sv.mul(2.0)), 0.0, 1.0);
});

let _waterWaveTexture = null;

// 原地 2D 逆 FFT（不归一化，n 为 2 的幂），实部与虚部分开存储。
function fft2DInverse(re, im, n) {
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const fft1D = () => {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = ar[i]; ar[i] = ar[j]; ar[j] = t;
        t = ai[i]; ai[i] = ai[j]; ai[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const wr = Math.cos((2 * Math.PI) / len);
      const wi = Math.sin((2 * Math.PI) / len);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tr = ar[b] * cr - ai[b] * ci;
          const ti = ar[b] * ci + ai[b] * cr;
          ar[b] = ar[a] - tr; ai[b] = ai[a] - ti;
          ar[a] += tr; ai[a] += ti;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) { // 先按行再按列
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) { const idx = pass === 0 ? r * n + c : c * n + r; ar[c] = re[idx]; ai[c] = im[idx]; }
      fft1D();
      for (let c = 0; c < n; c++) { const idx = pass === 0 ? r * n + c : c * n + r; re[idx] = ar[c]; im[idx] = ai[c]; }
    }
  }
}

/**
 * 256² 可平铺风浪贴图，整个进程只生成一次；固定种子（武汉 mulberry32 + 0x2f6b9d1）保证每次一致。
 * RGBA 半浮点：R,G = 每块单位 RMS 的坡度 dh/du、dh/dv，B = 该点坡度平方，A = 高度。
 * 频谱是 k^-4 饱和区 + cos² 方向扩散的风浪谱，用逆 FFT 变回空间域；mip 链在 float 里手工求均值，
 * 所以三线性/各向异性采样返回的是像素足迹内的平均坡度与平均坡度平方，两者之差就是解析不了的
 * 细浪坡度方差（LEAN mapping），交给粗糙度用，近处有细碎浪、远处化成柔和反光，不会闪烁或露平铺。
 */
export function getWaterWaveTexture() {
  if (_waterWaveTexture) return _waterWaveTexture;
  const N = 256;
  const size = N * N;
  let seed = 0x2f6b9d1;
  const rand = () => { // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gRe = new Float64Array(size);
  const gIm = new Float64Array(size);
  for (let i = 0; i < size; i++) { // 复高斯白噪声（Box-Muller）
    const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9)));
    const a = 2 * Math.PI * rand();
    gRe[i] = r * Math.cos(a);
    gIm[i] = r * Math.sin(a);
  }

  const sRe = new Float64Array(size); // 坡度场打包成 dh/du + i dh/dv
  const sIm = new Float64Array(size);
  const hRe = new Float64Array(size); // 高度场
  const hIm = new Float64Array(size);
  const kPeak = 5.0; // 谱峰（每块周期数）
  const kCut = 56.0; // 高频软截断，留在 Nyquist 内侧，mip 0 的坡度仍然解析得出来
  const windU = Math.cos(0.3);
  const windV = Math.sin(0.3);
  for (let y = 0; y < N; y++) {
    const ky = y < N / 2 ? y : y - N;
    for (let x = 0; x < N; x++) {
      const kx = x < N / 2 ? x : x - N;
      const k = Math.hypot(kx, ky);
      if (k < 1 || k > N / 2 - 2) continue;
      const c = (kx * windU + ky * windV) / k;
      const spread = 0.22 + c * c; // 主要沿风向，留一点横向浪
      const amp = Math.sqrt(spread * Math.exp(-1.25 * (kPeak / k) ** 2 - (k / kCut) ** 2)) / (k * k);
      const i = y * N + x;
      const m = ((N - y) % N) * N + ((N - x) % N); // -k 的下标：H(-k) = conj(H(k))，保证两个场是实函数
      const aRe = (gRe[i] + gRe[m]) * amp;
      const aIm = (gIm[i] - gIm[m]) * amp;
      hRe[i] = aRe;
      hIm[i] = aIm;
      sRe[i] = -kx * aIm - ky * aRe; // FFT⁻¹(i·kx·H − ky·H) = dh/du + i·dh/dv（差 2π 常数，后面归一化掉）
      sIm[i] = kx * aRe - ky * aIm;
    }
  }
  fft2DInverse(sRe, sIm, N);
  fft2DInverse(hRe, hIm, N);

  let s2 = 0;
  let h2 = 0;
  for (let i = 0; i < size; i++) {
    s2 += sRe[i] * sRe[i] + sIm[i] * sIm[i];
    h2 += hRe[i] * hRe[i];
  }
  const sNorm = 1 / Math.sqrt(s2 / size);
  const hNorm = 1 / Math.sqrt(h2 / size);

  let w = N;
  let level = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const sx = sRe[i] * sNorm;
    const sy = sIm[i] * sNorm;
    level[i * 4] = sx;
    level[i * 4 + 1] = sy;
    level[i * 4 + 2] = sx * sx + sy * sy;
    level[i * 4 + 3] = hRe[i] * hNorm;
  }
  const toHalf = THREE.DataUtils.toHalfFloat;
  const mipmaps = [];
  for (;;) {
    const data = new Uint16Array(level.length);
    for (let i = 0; i < level.length; i++) data[i] = toHalf(level[i]);
    mipmaps.push({ data, width: w, height: w });
    if (w === 1) break;
    const h = w >> 1;
    const next = new Float32Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        for (let c = 0; c < 4; c++) {
          const a = (2 * y * w + 2 * x) * 4 + c;
          next[(y * h + x) * 4 + c] = 0.25 * (level[a] + level[a + 4] + level[a + w * 4] + level[a + w * 4 + 4]);
        }
      }
    }
    level = next;
    w = h;
  }

  const tex = new THREE.DataTexture(mipmaps[0].data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mipmaps;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _waterWaveTexture = tex;
  return tex;
}

// 按水域与夜间岸线反光配置缓存。
const _waterMaterials = new Map();

/**
 * 深圳湾海面（coastal=true，默认）或内河/水库（coastal=false）的水面材质。
 * - 法线：4 层不同尺度、旋转、漂移的波浪贴图采样求平均坡度；风斑噪声驱动能量，浪尖起伏进 crest。
 * - 粗糙度：未解析坡度方差开四次方（GGX alpha 的平方根），内河再压暗一点。
 * - 金属度：菲涅尔（F0≈0.02）交给金属度通道，透射份额留给水体色；反射只来自天空 IBL、太阳 GGX 与 SSR。
 * - 夜间：沿反射射线解析深圳湾北岸楼群带（平面距离与楼高由变体常数给出），用波浪坡度方差做盒滤波，
 *   远处灯光沿竖直方向拉成条纹；白天与朝香港方向权重为 0。
 */
export function createSzWaterMaterial({ coastal = true, cityReflection = true } = {}) {
  const key = `${coastal ? 'coastal' : 'inland'}:${cityReflection}`;
  const cached = _waterMaterials.get(key);
  if (cached) return cached;

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.25 });
  const waveTex = getWaterWaveTexture();
  // 海面和内河/水库在数据里都用 y=0 输出，按高度区分不了，所以按变体给常数 pond：
  // 1 = 内河/水库（更绿更暗、波纹更细），0 = 海面。
  const pond = coastal ? 0.0 : 1.0;

  // [每块边长 m, 旋转 rad, RMS 坡度]：尺度与角度互不成倍数，所以看不出平铺。
  const LAYERS = [
    [61.0, 0.0, 0.052], // 长涌浪
    [23.3, 1.93, 0.06],
    [8.7, 4.07, 0.064],
    [3.3, 2.71, 0.064] // 风生细浪
  ];

  // vec4(平均坡度 x, 平均坡度 z, 未解析坡度方差, 浪峰高度)
  const waves = Fn(() => {
    const p = positionWorld.xz;
    const t = time;
    const q = coastal ? p : p.mul(2.6); // 内河：贴图坐标放大，波纹更细

    // 随风漂移的大尺度风斑：从空中也能看出起伏，同时掩盖平铺。
    const gustA = noise2D(p.mul(0.0047).add(vec2(t.mul(0.011), t.mul(-0.007))));
    const gustB = noise2D(p.mul(0.0135).add(vec2(t.mul(-0.009), t.mul(0.013))).add(31.7));
    const gust = smoothstep(0.18, 0.82, gustA.mul(0.62).add(gustB.mul(0.38)));
    const energy = mix(float(0.45), float(1.3), gust).mul(coastal ? 1.0 : 0.42).toVar();

    const slope = vec2(0.0, 0.0).toVar();
    const variance = energy.mul(energy).mul(0.0022).toVar(); // 永远小于一个像素的毛细涟漪
    const crest = float(0.0).toVar();
    for (const [L, rot, sigma] of LAYERS) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const speed = (0.8 * Math.sqrt(L / 9)) / L; // 该尺度主浪的相速度，单位：块/秒
      const uv = vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c))).div(L)
        .add(vec2(Math.cos(0.3) * speed, Math.sin(0.3) * speed).mul(t));
      const smp = texture(waveTex, uv);
      const amp = energy.mul(sigma);
      slope.addAssign(vec2(smp.x.mul(c).add(smp.y.mul(s)), smp.y.mul(c).sub(smp.x.mul(s))).mul(amp));
      variance.addAssign(max(smp.z.sub(dot(smp.xy, smp.xy)), 0.0).mul(amp.mul(amp)));
      crest.addAssign(smp.w.mul(sigma));
    }
    return vec4(slope, variance, crest.mul(4.0));
  })();

  const slope = waves.xy;
  const variance = waves.z;
  // 喷泉边缘等非水平面保留自己的法线。
  const flatTop = smoothstep(0.5, 0.9, normalWorldGeometry.y);
  const waterNormal = normalize(mix(normalWorldGeometry, vec3(slope.x.negate(), 1.0, slope.y.negate()), flatTop));
  mat.normalNode = cameraViewMatrix.transformDirection(waterNormal);

  // GGX alpha ≈ 未解析波的 RMS 坡度（Beckmann m），roughness = sqrt(alpha)；内河更浑、稍钝。
  mat.roughnessNode = clamp(pow(variance, 0.25).add(float(pond).mul(0.05)), 0.08, 0.65);

  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(float(1.0).sub(clamp(dot(waterNormal, viewDir), 0.0, 1.0)), 5.0).mul(0.98).add(0.02);
  mat.metalnessNode = clamp(fresnel.mul(1.6), 0.0, 0.9);

  // 珠江口是泥沙加藻类的绿灰水，不是纽约的深蓝绿：R≈G、B 最低。
  // 深水 0x1f312b（暗绿灰）、含沙浅滩 0x49563f（橄榄灰绿）、浪峰透光偏黄绿 0x71835a；
  // 内河更暗更绿：0x15241a / 0x33432a。浪峰提亮沿用纽约 2961 的标量提亮，再轻微偏向黄绿。
  mat.colorNode = Fn(() => {
    const silt = noise2D(positionWorld.xz.mul(0.0031).add(7.3));
    const body = mix(color(0x1f312b), color(0x49563f), smoothstep(0.25, 0.85, silt));
    const inland = mix(color(0x15241a), color(0x33432a), silt);
    const crest = smoothstep(0.6, 2.4, waves.w).toVar();
    const lit = (coastal ? body : inland).mul(crest.mul(0.32).add(1.0));
    return mix(lit, color(0x71835a), crest.mul(0.16));
  })();

  // 夜间岸线反光：沿反射射线解析一条楼群带（不用循环，节点数固定）。
  // 深圳湾城市在北侧：反射方向 z 更小（dir.y = R.z < 0）才指向城市，朝香港（南）时 gate=0。
  // 水平坐标取岸线方向 u = hit.x（城市带沿东西向），垂直坐标 hRefl = tHit·tanEl 是反射看到的楼高；
  // 用未解析坡度方差 sigma2 = sqrt(variance)·2 作竖直盒滤波宽度、按透视压缩作水平宽度，灯光拉成竖条。
  // 时段权重 smoothstep(0.62, 1.28, uInteriorGlow)：midday 0.24、golden 0.48 → 0；twilight 1.25 → 0.92；
  // night 1.55 → 1。黄昏先亮起来，白天严格为 0，也不会在白天白算这些节点。
  const night = smoothstep(0.62, 1.28, cityUniforms.uInteriorGlow);
  mat.emissiveNode = cityReflection ? Fn(() => {
    const emit = vec3(0.0).toVar();
    If(night.greaterThan(0.0005), () => {
      const R = reflect(viewDir.negate(), waterNormal);
      const horiz = max(length(R.xz), 0.001);
      const dir = R.xz.div(horiz).toVar();
      const tanEl = R.y.div(horiz).toVar();
      const P = positionWorld.xz;
      // 海面：城市带约 1.6 km 远、140 m 高（深圳湾北岸尺度）；内河：两岸 360 m、42 m 高，且没有北向限制。
      const tHit = float(coastal ? 1600.0 : 360.0);
      const northGate = coastal ? smoothstep(0.10, 0.45, dir.y.negate()) : float(1.0).toVar();
      const hit = P.add(dir.mul(tHit)).toVar();
      const hRefl = tHit.mul(tanEl).toVar();
      const u = hit.x.toVar();
      const S = float(coastal ? 140.0 : 42.0);

      // 盒滤波宽度上下设限：下限避免近处细碎闪烁，上限避免大尺度方差把整条楼群带糊成一片均匀亮毯，
      // 那样会失去岸线灯光的竖条结构（首版实测出现过）。
      const sigma2 = sqrt(variance).mul(2.0);
      const fwH = fwidth(hRefl).toVar();
      const fwU = fwidth(u).toVar();
      const sV = clamp(tHit.mul(sigma2).add(fwH).add(0.5), 0.6, 36.0).toVar();
      const sU = clamp(tHit.mul(sigma2).mul(max(viewDir.y, 0.05)).add(fwU).add(0.8), 0.8, 28.0).toVar();

      // 每 40 m（内河 24 m）一个地块：楼高 0.3~1.0 倍带高，远处收敛到地块均值 0.72 倍。
      const lot = floor(u.div(coastal ? 40.0 : 24.0));
      const r1 = hash2D(vec2(lot, 5.1));
      const r2 = hash2D(vec2(lot, 9.7));
      const r3 = hash2D(vec2(lot, 13.3));
      const lotMix = smoothstep(5.0, 20.0, sU);
      const upper = mix(
        waterBoxCover(hRefl, 4.5, S.mul(r1.mul(r1).mul(0.7).add(0.3)), sV),
        waterBoxCover(hRefl, 4.5, S.mul(0.72), sV),
        lotMix
      );
      const ground = waterBoxCover(hRefl, 0.0, 4.5, sV);

      // 3.6 m 开间 × 3.3 m 层高的亮窗，远处按均值 0.4 收敛。
      const dens = mix(float(0.25), float(0.7), r2);
      const bayF = u.div(3.6);
      const floorF = hRefl.div(3.3);
      const litWin = step(hash2D(floor(vec2(bayF, floorF)).add(lot.mul(0.731))), dens);
      const pane = filteredPulse(fract(bayF), 0.18, 0.82, sU.div(3.6))
        .mul(filteredPulse(fract(floorF), 0.28, 0.86, sV.div(3.3)));
      const winDetail = float(1.0).sub(smoothstep(0.7, 1.8, max(sU.div(3.6), sV.div(3.3))));
      const windows = mix(mix(dens.mul(0.4), litWin.mul(pane), winDetail), float(0.4), lotMix);
      // 深圳湾夜景：冷白 LED 为主，住宅暖黄。不做高饱和媒体立面：首版按纽约做法加了青/品红地块，
      // 在开阔海湾的大尺度反射里变成彩色条带，与"远处岸线灯"观感不符，已去掉。
      const warm = mix(color(0xffd9b0), color(0xdce8ff), step(0.58, r3));
      const tint = mix(warm, color(0xf2f6ff), lotMix.mul(0.6));
      const shopLit = mix(mix(float(0.12), float(1.0), step(0.3, r3)), float(0.7), lotMix);

      // 岸线灯：每 30 m（内河 25 m）一盏，灯头高 8 m。
      const lampStep = coastal ? 30.0 : 25.0;
      const lampDist = abs(fract(u.div(lampStep)).sub(0.5)).mul(lampStep);
      const lampU = mix(waterBoxCover(lampDist, -0.5, 0.5, sU), float(1.0 / lampStep), smoothstep(5.0, 14.0, sU));
      const lamps = lampU.mul(waterBoxCover(hRefl, 7.6, 8.6, sV)).mul(70.0);

      // 海面是开阔湾面，岸线在 1.6 km 外，反光只应是"远处一条泛光带"，所以整体压暗；
      // 太亮会在水面铺出一层假亮毯，白天/黄昏交界也容易抢画面。
      const city = tint.mul(windows.mul(upper).mul(0.62))
        .add(color(0xffcf9a).mul(ground.mul(shopLit).mul(0.26)))
        .add(color(0xffd9b0).mul(lamps.mul(0.55)));
      emit.assign(city.mul(fresnel).mul(night).mul(northGate).mul(0.85));
    });
    return emit;
  })() : color(0x132a41).mul(night).mul(fresnel.mul(0.45).add(0.2));

  _waterMaterials.set(key, mat);
  return mat;
}
