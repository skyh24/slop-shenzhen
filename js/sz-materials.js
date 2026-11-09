import * as THREE from 'three/webgpu';
import {
  Fn, attribute, uv, vec2, vec3, vec4, float, fract, floor, step, mix, smoothstep, abs, sin, dot, max, min,
  uniform, positionWorld, normalWorldGeometry, time, color, fwidth
} from 'three/tsl';

// 全局氛围参数：night 0 白天 → 1 深夜；show 控制楼体灯光秀
export const sceneUniforms = {
  night: uniform(0),
  show: uniform(0),
  apec: uniform(1)
};

const hash21 = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

// 抗锯齿的区间遮罩：x 在 [a, b] 内为 1
const band = (x, a, b, w) => smoothstep(a.sub(w), a.add(w), x).mul(float(1).sub(smoothstep(b.sub(w), b.add(w), x)));

// 对像素覆盖的完整周期和两端残余求面积，远处窗格收敛到平均覆盖率。
const windowCoverage = Fn(([x, ratio, width]) => {
  const half = width.mul(0.5).toVar();
  const start = float(0.5).sub(ratio.mul(0.5)).toVar();
  const area = t => floor(t).mul(ratio).add(min(max(fract(t).sub(start), 0), ratio));
  return area(x.add(half)).sub(area(x.sub(half))).div(width);
});

// 立面表，顺序和 tools/sz/buildings.py 的 FACADES 一致：
// glass_tower office residential_tower residential_low village industrial public landmark
const BAY = [1.6, 3.0, 3.4, 3.2, 2.6, 6.0, 4.0, 1.5];
const FLOOR = [4.2, 3.9, 3.0, 3.0, 2.9, 6.0, 4.5, 4.4];
const WIN_W = [0.92, 0.7, 0.42, 0.45, 0.35, 0.6, 0.6, 0.94];
const WIN_H = [0.9, 0.62, 0.5, 0.5, 0.42, 0.25, 0.5, 0.92];
const GLASSY = [1.0, 0.6, 0.3, 0.25, 0.15, 0.35, 0.5, 1.0];
const TINT_A = [0x72828a, 0xa8aba5, 0xd4cabc, 0xc3b29c, 0xbdb3a3, 0x999f9f, 0xb8b3a7, 0x9ca9b0];
const TINT_B = [0x9dabb2, 0x8e999e, 0xc1beb1, 0xab9d91, 0xcac7bf, 0x83949a, 0x9da8a1, 0xc1c9ce];
// 按立面类型模拟照明，比例与色温为外观参数。
const LIT_SHARE = [0.095, 0.115, 0.14, 0.14, 0.095, 0.06, 0.08, 0.1];
const WARMTH = [0.14, 0.24, 0.75, 0.85, 0.9, 0.35, 0.52, 0.2];

const pickF = (id, values) => values.reduce((acc, v, i) => acc.add(step(abs(id.sub(i)), 0.5).mul(v)), float(0));
const pickC = (id, values) => values.reduce((acc, v, i) => acc.add(color(v).mul(step(abs(id.sub(i)), 0.5))), vec3(0));

export function createBuildingMaterial({ showLandmarkLights = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
  const meta = attribute('bmeta', 'vec4');
  const fid = meta.x;
  const seed = meta.y;
  const fp = vec4(pickF(fid, BAY), pickF(fid, FLOOR), pickF(fid, WIN_W), pickF(fid, WIN_H));
  const glassy = pickF(fid, GLASSY);
  const tone = hash21(vec2(seed, seed.mul(1.7)));
  const base = mix(pickC(fid, TINT_A), pickC(fid, TINT_B), tone);
  const wall = float(1).sub(smoothstep(0.3, 0.6, abs(normalWorldGeometry.y)));
  const u = uv().x;
  const v = uv().y;
  const grid = vec2(u, v).div(fp.xy);
  const inCell = fract(grid);
  const cell = floor(grid).add(vec2(0, seed.mul(97)));
  const width = max(fwidth(vec2(u, v)).div(fp.xy), vec2(0.001));
  const detail = float(1).sub(smoothstep(0.18, 0.68, max(width.x, width.y)));
  const glazing = windowCoverage(inCell.x, fp.z, width.x).mul(windowCoverage(inCell.y, fp.w, width.y))
    .mul(smoothstep(2.8, 4.0, v));
  const win = glazing.mul(wall);
  const paneTone = mix(float(1), hash21(cell).mul(0.28).add(0.86), detail);
  const glass = mix(color(0x465962), color(0x6b899a), glassy).mul(paneTone);
  const baseBand = smoothstep(0.0, 5.0, v).mul(0.20).add(0.80);
  const roof = base.mul(0.55).mul(tone.mul(0.12).add(0.94));
  m.colorNode = mix(roof, mix(base, glass, glazing).mul(baseBand), wall);
  m.roughnessNode = mix(float(0.84), float(0.14), win.mul(glassy.mul(0.63).add(0.37)));
  m.metalnessNode = win.mul(glassy).mul(0.42);

  const night = sceneUniforms.night;
  const probability = pickF(fid, LIT_SHARE).mul(tone.mul(0.45).add(0.76));
  const suite = vec2(floor(cell.x.div(step(0.55, glassy).add(1))), cell.y);
  const occupancy = hash21(suite.add(vec2(32.1, 7.6)));
  const lit = step(occupancy, probability).mul(occupancy.mul(2).add(0.75));
  // 窗格不足以分辨时只保留低强度的建筑级亮度，避免逐窗亮灭形成远景碎点。
  const light = mix(probability.mul(0.26), lit, detail);
  const windowColor = mix(color(0xd7e6ff), color(0xffc58b), pickF(fid, WARMTH));
  const windowGlow = windowColor.mul(win).mul(light).mul(night).mul(0.75);
  m.emissiveNode = windowGlow;
  if (showLandmarkLights) {
    // 临时预览页仍沿用原灯光秀，正式入口的地标各自控制亮灯部位。
    const tall = meta.z;
    const wave = sin(v.mul(0.035).sub(time.mul(1.6)).add(u.mul(0.01))).mul(0.5).add(0.5);
    const sweep = smoothstep(0.75, 1.0, wave);
    const showCol = mix(mix(color(0x2bd9ff), color(0x7a5cff), fract(time.mul(0.05))), mix(color(0xff3b30), color(0xffd166), wave), sceneUniforms.apec);
    const showGlow = showCol.mul(sweep.mul(0.9).add(0.15)).mul(tall).mul(wall).mul(sceneUniforms.show).mul(1.4);
    const crown = smoothstep(fp.y.mul(-1.5), float(0.0), v.sub(meta.w)).mul(tall).mul(night).mul(0.8);
    m.emissiveNode = windowGlow.add(showGlow).add(vec3(0.95, 0.97, 1.0).mul(crown).mul(wall));
  }
  return m;
}

export function createGroundMaterial(hex, rough = 0.95) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: 0 });
  const p = positionWorld.xz;
  const grain = hash21(floor(p.div(7.0))).mul(0.08).add(0.96);
  m.colorNode = color(hex).mul(grain);
  return m;
}

export function createWaterMaterial({ coastal = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: coastal ? 0.22 : 0.35 });
  const p = positionWorld.xz;
  const w1 = sin(p.x.mul(0.045).add(time.mul(0.6))).mul(sin(p.y.mul(0.06).sub(time.mul(0.45))));
  const w2 = sin(p.x.mul(0.18).sub(p.y.mul(0.11)).add(time.mul(1.4)));
  const pixel = max(fwidth(p.x), fwidth(p.y));
  const ripple = w1.mul(0.5).mul(smoothstep(10, 55, pixel).oneMinus())
    .add(w2.mul(0.25).mul(smoothstep(3, 18, pixel).oneMinus())).mul(0.5).add(0.5);
  const day = mix(color(coastal ? 0x3c5759 : 0x2f6f86), color(coastal ? 0x607679 : 0x4c94a6), ripple);
  const nightCol = mix(color(0x101e27), color(0x21343e), ripple);
  m.colorNode = mix(day, nightCol, sceneUniforms.night);
  m.roughnessNode = ripple.mul(0.15).add(0.06);
  return m;
}

export function createRoadMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const u = uv().x;
  const v = uv().y;
  const w = attribute('bmeta', 'vec4').x;
  const major = step(9.0, w);
  const halfW = w.mul(0.5);
  const fw = max(fwidth(v), 0.01);
  const center = smoothstep(fw.add(0.12), 0.12, abs(v)).mul(step(fract(u.div(9.0)), 0.5)).mul(major);
  const edge = band(abs(v), halfW.sub(0.55), halfW.sub(0.35), fw).mul(major);
  const asphalt = color(0x3a3d42).mul(hash21(floor(positionWorld.xz.div(2.0))).mul(0.08).add(0.95));
  const paint = min(center.add(edge), 1.0);
  m.colorNode = mix(asphalt, color(0xe9e6dc), paint.mul(0.85));
  // 夜间路面被路灯照亮，主干道偏暖
  m.emissiveNode = color(0xffb46b).mul(sceneUniforms.night).mul(major.mul(0.06).add(0.02));
  return m;
}
