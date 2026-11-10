import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, attribute, cameraPosition, clamp, color, dot, float, floor, fract, fwidth, length, max, min, mix, mrt,
  normalize, normalView, positionView, positionWorld, pow, sin, smoothstep, step, vec2, vec3, vec4
} from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';

// 路面和标线材质共用这里的世界坐标噪声与积水场：标线读同一场，水坑才能压住标线。
// 只读 cityUniforms 的时段参数（uRoadWetness/uSky*/uInteriorGlow），不写它。
const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

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

// Mikkelsen 表面梯度凹凸。height 先落成标量，dFdx/dFdy 只求值一次。
const bumpNormal = Fn(([height]) => {
  const h = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(h.dFdx().mul(r1).add(h.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

// active 成立才算 detail()，否则直接给 detail 自身淡出后的值；被像素足迹抹掉的纹理不必计算。
function fadedDetail(active, flat, detail) {
  const out = float(flat).toVar();
  If(active, () => {
    out.assign(detail());
  });
  return out;
}

// 抖动 3x3 Voronoi 胞边界距离（胞单位，(F2 - F1) / 2）。
const voronoiBorder = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const ip = floor(pv).toVar();
  const fp = fract(pv).toVar();
  const f1 = float(8.0).toVar();
  const f2 = float(8.0).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const id = ip.add(vec2(i, j));
      const site = vec2(i, j).add(vec2(hash2D(id), hash2D(id.add(vec2(37.1, 11.7)))).mul(0.8).add(0.1));
      const d = length(fp.sub(site)).toVar();
      f2.assign(min(f2, max(f1, d)));
      f1.assign(min(f1, d));
    }
  }
  return f2.sub(f1).mul(0.5);
});

// 世界 xz 处的沥青磨损，px 为一个像素的米数：x=发丝裂缝覆盖率，y=矩形开挖补丁边缘有符号距离（米，<0 在内部），z=坑洞深度，w=该 11 m 网格有补丁。
const roadWear = Fn(([wxz, px]) => {
  const worn = smoothstep(0.5, 0.78, noise2D(wxz.mul(0.045).add(71.0))).toVar();
  const crack = float(0.0).toVar();
  If(worn.greaterThan(0.001).and(px.lessThan(0.04)), () => {
    const warp = vec2(noise2D(wxz.mul(2.7)), noise2D(wxz.mul(2.7).add(13.0))).sub(0.5).mul(0.35);
    const border = voronoiBorder(wxz.div(0.55).add(warp)).mul(0.55);
    const width = worn.mul(0.0016).add(0.0012);
    const effWidth = max(width, px.mul(0.6));
    crack.assign(float(1.0).sub(smoothstep(effWidth, effWidth.add(px), border)).mul(width.div(effWidth)).mul(worn).mul(smoothstep(0.04, 0.015, px)));
  });
  // 开挖补丁：11 m 网格里约一半有，方形切口或沿路/横路的窄沟槽，都限制在自己的网格内。
  const pCell = floor(wxz.div(11.0));
  const hasPatch = step(0.5, hash2D(pCell.add(vec2(3.7, 8.1))));
  const trench = step(0.6, hash2D(pCell.add(vec2(2.9, 6.3))));
  const alongX = step(0.5, hash2D(pCell.add(vec2(5.5, 9.9))));
  const pCentre = pCell.add(0.5).add(vec2(hash2D(pCell.add(vec2(1.3, 5.9))), hash2D(pCell.add(vec2(9.2, 2.4)))).sub(0.5).mul(mix(float(0.4), float(0.08), trench))).mul(11.0);
  const cutHalf = vec2(hash2D(pCell.add(vec2(4.4, 0.6))).mul(1.8).add(0.6), hash2D(pCell.add(vec2(7.8, 3.1))).mul(1.4).add(0.5));
  const trenchLong = hash2D(pCell.add(vec2(0.7, 4.8))).mul(2.0).add(2.4);
  const trenchNarrow = hash2D(pCell.add(vec2(6.6, 7.2))).mul(0.25).add(0.3);
  const trenchHalf = mix(vec2(trenchNarrow, trenchLong), vec2(trenchLong, trenchNarrow), alongX);
  const pq = abs(wxz.sub(pCentre)).sub(mix(cutHalf, trenchHalf, trench));
  const patchDist = max(pq.x, pq.y);
  // 坑洞：多出现在磨损路段，一个巴掌到两个巴掌大的碎边碗。
  const hCell = floor(wxz.div(7.0)).toVar();
  const hCentre = hCell.add(vec2(hash2D(hCell.add(vec2(2.2, 7.7))), hash2D(hCell.add(vec2(6.1, 1.9)))).mul(0.6).add(0.2)).mul(7.0);
  const pothole = float(0.0).toVar();
  If(hash2D(hCell.add(vec2(8.8, 0.3))).greaterThanEqual(float(0.975).sub(worn.mul(0.12))), () => {
    const hRadius = hash2D(hCell.add(vec2(5.3, 4.2))).mul(0.24).add(0.12);
    const hDist = length(wxz.sub(hCentre)).mul(noise2D(wxz.mul(6.0)).sub(0.5).mul(0.5).add(1.0));
    pothole.assign(smoothstep(hRadius.add(px), hRadius.mul(0.35), hDist));
  });
  return vec4(crack.mul(float(1.0).sub(step(patchDist, 0.0).mul(hasPatch))), patchDist, pothole, hasPatch);
});

// 世界 xz 处的“焦油蛇”，px 为一个像素的米数：浇进宽裂缝的 3~5 cm 黑色封缝胶，约 2.4 m 网格的断续网络。
const roadTarSnakes = Fn(([wxz, px]) => {
  const zone = smoothstep(0.3, 0.48, noise2D(wxz.mul(0.03).add(17.0))).toVar();
  const snake = float(0.0).toVar();
  If(zone.greaterThan(0.001).and(px.lessThan(0.12)), () => {
    const warp = vec2(noise2D(wxz.mul(0.9)), noise2D(wxz.mul(0.9).add(31.0))).sub(0.5).mul(0.6);
    const border = voronoiBorder(wxz.div(2.4).add(warp)).mul(2.4);
    // 只封了一部分裂缝：网络断成几米长的一段段。
    const keep = smoothstep(0.38, 0.5, noise2D(wxz.mul(0.6).add(5.0)));
    const width = noise2D(wxz.mul(1.7).add(9.0)).mul(0.012).add(0.014);
    const effWidth = max(width, px.mul(0.6));
    snake.assign(float(1.0).sub(smoothstep(effWidth, effWidth.add(px), border)).mul(width.div(effWidth)).mul(zone).mul(keep).mul(smoothstep(0.12, 0.06, px)));
  });
  return snake;
});

// 雨后的积水场：三层噪声叠出低洼处成片的水面。
function roadPuddleField(wx, wz) {
  const nMacro = noise2D(vec2(wx.mul(0.095), wz.mul(0.075)));
  const nMid = noise2D(vec2(wx.mul(0.25).add(19.4), wz.mul(0.22).add(11.8)));
  const nDetail = noise2D(vec2(wx.mul(0.68).sub(7.3), wz.mul(0.68).add(29.1)));
  return nMacro.mul(0.52).add(nMid.mul(0.34)).add(nDetail.mul(0.14));
}

// cityUniforms.uRoadWetness 驱动三种湿度（0 全干 … 1 刚下透）：x=湿渍（更深、半光），y=积水（镜面，干天没有），z=整体水膜；drainage 抬高水面，给排水更好的铺装用。
function roadWetMasks(field, drainage = 0.0) {
  const w = cityUniforms.uRoadWetness;
  const level = mix(float(0.86), float(0.56), clamp(w.sub(0.1).div(0.55), 0.0, 1.0)).add(drainage);
  const damp = smoothstep(level.sub(0.09), level.sub(0.015), field);
  const puddle = smoothstep(level, level.add(0.022), field).mul(smoothstep(0.1, 0.22, w));
  const film = smoothstep(0.2, 0.8, w);
  return vec3(damp, puddle, film);
}

let roadSurfaceMaterial = null;
// 沥青路面：程序化色/粗糙度/凹凸，水按 Fresnel 走 metalness，让 SSR 在掠射角反出街景、俯视时只压暗。
export function createSzRoadSurfaceMaterial() {
  if (roadSurfaceMaterial) return roadSurfaceMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.24, roughness: 0.48,
    // 与地形共面，靠深度偏移压住 z-fighting；接触判定仍用真实地形三角面。
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  });
  // 风化氧化沥青；只有新补丁是乌黑新料。
  const cAsphaltDark = color(0x2b2f31);
  const cAsphaltLight = color(0x4e5256);
  const cOldPatch = color(0x63666a);
  // 一个像素覆盖的世界尺寸：细纹理缩到像素以下前先收敛到均值，避免远景摩尔纹。
  const pixelSize = length(fwidth(positionWorld.xz));
  // 裂缝、开挖补丁、坑洞只求值一次，供下面所有通道复用。
  const wear = roadWear(positionWorld.xz, pixelSize);
  const crack = wear.x, patchDist = wear.y, pothole = wear.z;
  const patchCover = smoothstep(pixelSize, pixelSize.negate(), patchDist).mul(wear.w);
  // 锯缝两侧几厘米宽的焦油封边。
  const sealWidth = max(float(0.022), pixelSize.mul(0.75));
  const patchSeal = float(1.0).sub(smoothstep(sealWidth, sealWidth.add(pixelSize), abs(patchDist))).mul(float(0.022).div(sealWidth)).mul(wear.w);
  // 新补丁比路面更黑更紧，旧补丁发灰泛白。
  const patchFresh = step(0.55, hash2D(floor(positionWorld.xz.div(11.0)).add(vec2(12.9, 6.6))));
  // 磨损处露出的浅色石料，缩到像素以下时收敛到平均值。
  const chips = Fn(() => {
    const px = float(pixelSize).toVar();
    return fadedDetail(px.lessThan(0.03), 0.035, () =>
      mix(float(0.035), smoothstep(0.72, 0.8, noise2D(positionWorld.xz.mul(30.0))), smoothstep(0.03, 0.012, px)));
  })();
  // 焦油蛇不铺在新补丁上。
  const tarSnake = roadTarSnakes(positionWorld.xz, pixelSize).mul(float(1.0).sub(patchCover));
  // 怠速车漏下的机油斑点，2.5 m 网格里约三分之一有。
  const oilDrip = Fn(() => {
    const px = float(pixelSize).toVar();
    const oilCell = floor(positionWorld.xz.div(2.5)).toVar();
    return fadedDetail(hash2D(oilCell.add(vec2(7.7, 3.3))).greaterThanEqual(0.66), 0.0, () => {
      const oilCentre = oilCell.add(vec2(hash2D(oilCell.add(vec2(4.1, 2.2))), hash2D(oilCell.add(vec2(8.3, 6.7)))).mul(0.6).add(0.2)).mul(2.5);
      const oilDist = length(positionWorld.xz.sub(oilCentre)).mul(noise2D(positionWorld.xz.mul(5.0)).sub(0.5).mul(0.8).add(1.0));
      const oilRadius = hash2D(oilCell.add(vec2(1.9, 9.4))).mul(0.25).add(0.1);
      return smoothstep(oilRadius.add(px), oilRadius.mul(0.3), oilDist).mul(hash2D(oilCell.add(vec2(2.6, 5.1))).mul(0.6).add(0.4));
    });
  })();
  // 积水场与湿润遮罩供所有通道共用；坑洞先积水。
  const wet = roadWetMasks(roadPuddleField(positionWorld.x, positionWorld.z).add(pothole.mul(0.45)));
  const damp = wet.x, puddle = wet.y, film = wet.z;
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const waterFresnel = pow(float(1.0).sub(clamp(viewDir.y, 0.0, 1.0)), 5.0).mul(0.98).add(0.02);
  mat.colorNode = Fn(() => {
    const wx = positionWorld.x, wz = positionWorld.z;
    const px = float(pixelSize).toVar();
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(240.0, 22.0, camDist).toVar();
    // 双尺度骨料颗粒、分次摊铺的做旧色、油污磨痕与焦油灌缝。
    const microAggregate = fadedDetail(px.lessThan(0.06), 0.5, () => mix(float(0.5), noise2D(vec2(wx.mul(16.0), wz.mul(16.0))), smoothstep(0.06, 0.02, px)));
    const fineGrain = fadedDetail(px.lessThan(0.4), 0.5, () => mix(float(0.5), noise2D(vec2(wx.mul(3.2), wz.mul(3.2))), smoothstep(0.4, 0.12, px)));
    const patchNoise = noise2D(vec2(wx.mul(0.18), wz.mul(0.18)));
    const oilyStain = fadedDetail(camDist.lessThan(240.0), 0.0, () =>
      smoothstep(0.52, 0.84, noise2D(vec2(wx.mul(0.42), wz.mul(0.42)))).mul(detail));
    const tarSeam = float(1.0).sub(smoothstep(0.0, 0.04, abs(patchNoise.sub(0.52)))).mul(0.42).mul(detail);
    // 沥青富集（深）与骨料脱落（浅）的一步宽斑驳。
    const mottle = noise2D(vec2(wx.mul(0.9), wz.mul(0.9)).add(41.0)).mul(0.65).add(noise2D(vec2(wx.mul(2.3), wz.mul(2.3)).add(7.0)).mul(0.35));
    const baseAsphalt = mix(
      cAsphaltDark,
      cAsphaltLight,
      fineGrain.mul(0.3).add(microAggregate.mul(0.22)).add(patchNoise.mul(0.22)).add(smoothstep(0.3, 0.7, mottle).mul(0.26)).sub(0.04)
    )
      .mul(float(1.0).sub(oilyStain.mul(0.32)))
      .mul(float(1.0).sub(tarSeam));
    // 带焦油封边的开挖补丁，再叠石料、焦油蛇、油斑、裂缝与坑洞。
    const patchCol = mix(mix(baseAsphalt, cOldPatch, 0.45).mul(1.08), color(0x2b2e33).mul(0.85), patchFresh);
    const repaired = mix(baseAsphalt, patchCol, patchCover)
      .mul(float(1.0).sub(patchSeal.mul(0.5)))
      .add(chips.mul(0.08).mul(float(1.0).sub(patchCover.mul(patchFresh))))
      .mul(float(1.0).sub(tarSnake.mul(0.62)))
      .mul(float(1.0).sub(oilDrip.mul(0.45)))
      .mul(float(1.0).sub(crack.mul(0.65)))
      .mul(float(1.0).sub(pothole.mul(0.4)));
    // 孔隙进水后变暗：湿渍和积水最明显，整个水膜只压一点。
    const wetDarkening = mix(mix(float(1.0), float(0.72), damp), float(0.6), puddle).mul(mix(float(1.0), float(0.8), film));
    return repaired.mul(wetDarkening);
  })();

  mat.roughnessNode = Fn(() => {
    const px = float(pixelSize).toVar();
    const microRough = fadedDetail(px.lessThan(0.08), 0.04, () =>
      mix(float(0.04), noise2D(positionWorld.xz.mul(12.0)).mul(0.08), smoothstep(0.08, 0.03, px)));
    // 焦油封缝更亮、机油半哑、新补丁略紧，坑洞与裂缝更糙。
    const dry = float(0.90).add(microRough)
      .sub(patchSeal.mul(0.3))
      .sub(tarSnake.mul(0.38))
      .sub(oilDrip.mul(0.18))
      .sub(patchCover.mul(patchFresh).mul(0.06))
      .add(pothole.mul(0.06));
    // 水膜只把沥青从全哑变成柔光（仍然很糙，不进 SSR），真镜面留给湿渍和积水。
    const filmed = mix(dry, float(0.68), film.mul(0.7));
    const wetRough = mix(filmed, float(0.4), damp.mul(0.85));
    return mix(wetRough, float(0.1), puddle);
  })();

  // 水的 Fresnel（F0 = 0.02）：按积水（全部）、湿渍（部分）、水膜（极少）把漫反射换成反射。
  mat.metalnessNode = clamp(waterFresnel.mul(1.6), 0.0, 0.85).mul(max(puddle, max(damp.mul(0.35), film.mul(0.15))));

  // 用 bumpNormal 做带像素足迹门控的沥青起伏：缓坡、浅辙与波纹、粗中细三级骨料、石料、发丝裂缝、补丁台阶与封边、焦油蛇条、坑洞碗；
  // 台阶至少跨 2 px，最细的凹凸在缩到一像素前淡出；站在水里时压平成 0.0，SSR 反射才干净。
  mat.normalNode = Fn(() => {
    const wx = positionWorld.x, wz = positionWorld.z;
    const px = float(pixelSize).toVar();
    const coarseFade = smoothstep(0.12, 0.035, px).toVar();
    const midFade = smoothstep(0.035, 0.012, px).toVar();
    const fineFade = smoothstep(0.02, 0.006, px).mul(float(1.0).sub(film.mul(0.6))).toVar();
    const ramp = max(float(0.012), px.mul(2.0));
    const swell = noise2D(vec2(wx.mul(0.55), wz.mul(0.55)).add(23.0)).sub(0.5).mul(0.02).add(noise2D(vec2(wx.mul(1.9), wz.mul(1.9))).sub(0.5).mul(0.005));
    const ripples = fadedDetail(px.lessThan(0.3), 0.0, () =>
      noise2D(vec2(wx.mul(3.6), wz.mul(3.6)).add(61.0)).sub(0.5).mul(0.004).mul(smoothstep(0.3, 0.1, px)));
    const coarseGrit = fadedDetail(px.lessThan(0.12), 0.0, () =>
      noise2D(vec2(wx.mul(8.5), wz.mul(8.5))).sub(0.5).mul(0.006).mul(coarseFade));
    const midGrit = fadedDetail(px.lessThan(0.035), 0.0, () =>
      noise2D(vec2(wx.mul(19.0), wz.mul(19.0)).add(3.0)).sub(0.5).mul(0.0022).mul(midFade));
    const fineGrit = fadedDetail(px.lessThan(0.02), 0.0, () =>
      noise2D(vec2(wx.mul(36.0), wz.mul(36.0))).sub(0.5).mul(0.0016).mul(fineFade));
    const chipRelief = chips.mul(0.0015).mul(midFade);
    const snakeBead = tarSnake.mul(0.0018);
    const crackGroove = crack.mul(0.003).mul(smoothstep(0.012, 0.004, px));
    const patchStep = smoothstep(ramp, ramp.negate(), patchDist).mul(wear.w).mul(0.004);
    const sealBead = float(1.0).sub(smoothstep(0.0, max(float(0.03), ramp), abs(patchDist))).mul(wear.w).mul(0.0015);
    const bowl = pothole.mul(0.03);
    const height = swell.add(ripples).add(coarseGrit).add(midGrit).add(fineGrit).add(chipRelief).add(snakeBead).sub(crackGroove).add(patchStep).add(sealBead).sub(bowl);
    return bumpNormal(height.mul(float(1.0).sub(puddle)));
  })();

  // 湿面反射天光：天空色、内透光强和路面湿度随四时段变化都会进画面。
  mat.emissiveNode = Fn(() => {
    const roadFresnel = pow(float(1.0).sub(clamp(viewDir.y, 0.0, 1.0)), 2.3);
    const skyMirror = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, 0.4).mul(0.10).toVar();
    return skyMirror.mul(max(puddle, film.mul(0.35))).mul(roadFresnel).mul(cityUniforms.uInteriorGlow).mul(0.05);
  })();

  roadSurfaceMaterial = mat;
  return mat;
}

// 透明叠加层的 MRT 清零：标线不写 normal/metalRough，SSR 继续看到下面的沥青和水坑。
const szTransparentEffectMRT = mrt({
  normal: vec4(0.0, 0.0, 0.0, 0.0),
  metalRough: vec4(0.0, 0.0, 0.0, 0.0)
});

let roadPaintMaterial = null;
// 沥青标线：顶点色定黄白，paint 属性给（沿线米数、花纹周期、占空比）；虚线按像素足迹做精确盒滤波。
// 磨损和远处淡出压不透明度，湿了变暗变亮，积水处压暗并压光。
export function createSzRoadPaintMaterial() {
  if (roadPaintMaterial) return roadPaintMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, transparent: true, depthWrite: false, metalness: 0, roughness: 0.7,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  mat.mrtNode = szTransparentEffectMRT;
  const paint = attribute('paint', 'vec3');
  const t = paint.x.div(paint.y), footprint = max(fwidth(t), 0.0001), duty = paint.z;
  const onSoFar = x => floor(x).mul(duty).add(clamp(fract(x).sub(float(1.0).sub(duty).mul(0.5)), 0.0, duty));
  const dashes = onSoFar(t.add(footprint.mul(0.5))).sub(onSoFar(t.sub(footprint.mul(0.5)))).div(footprint);
  const xz = positionWorld.xz, camDist = length(positionWorld.sub(cameraPosition));
  const detail = smoothstep(70.0, 15.0, camDist), distFade = smoothstep(1650.0, 1300.0, camDist);
  // 近处才叠两层噪声磨损；远处直接给均值，省掉一片噪声求值。
  const wear = Fn(() => {
    const w = float(0.5).toVar();
    If(detail.greaterThan(0.001), () => {
      w.assign(mix(float(0.5), noise2D(xz.mul(0.8)).mul(0.6).add(noise2D(xz.mul(2.3)).mul(0.4)), detail));
    });
    return w;
  })();
  // 磨损把不透明度压到 0.4~0.95，1600 m 外整条标线淡出。
  mat.opacityNode = dashes.mul(smoothstep(0.1, 0.6, wear).mul(0.55).add(0.4)).mul(distFade);
  // uRoadWetness <= 0.1（正午）时积水遮罩恒为 0，不必求值。
  const puddle = Fn(() => {
    const p = float(0.0).toVar();
    If(cityUniforms.uRoadWetness.greaterThan(0.1), () => {
      p.assign(roadWetMasks(roadPuddleField(positionWorld.x, positionWorld.z)).y);
    });
    return p;
  })();
  const film = smoothstep(0.2, 0.8, cityUniforms.uRoadWetness);
  mat.colorNode = vec3(mix(float(1.0), float(0.72), puddle).mul(mix(float(1.0), float(0.86), film)));
  mat.roughnessNode = mix(mix(float(0.62), float(0.42), film), float(0.2), puddle);
  roadPaintMaterial = mat;
  return mat;
}
