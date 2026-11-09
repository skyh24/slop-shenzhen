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

// 立面表，顺序和 tools/sz/buildings.py 的 FACADES 一致：
// glass_tower office residential_tower residential_low village industrial public landmark
const BAY = [1.6, 3.0, 3.4, 3.2, 2.6, 6.0, 4.0, 1.5];
const FLOOR = [4.2, 3.9, 3.0, 3.0, 2.9, 6.0, 4.5, 4.4];
const WIN_W = [0.92, 0.7, 0.42, 0.45, 0.35, 0.6, 0.6, 0.94];
const WIN_H = [0.9, 0.62, 0.5, 0.5, 0.42, 0.25, 0.5, 0.92];
const GLASSY = [1.0, 0.6, 0.3, 0.25, 0.15, 0.35, 0.5, 1.0];
const TINT_A = [0x7d95a6, 0xc4c8c6, 0xe8e1d4, 0xd9cfbf, 0xd4c2ab, 0xbcc3c6, 0xd6d2c9, 0xdde5ea];
const TINT_B = [0x9fb4c0, 0xa9b2b6, 0xefe9e2, 0xc9b8a8, 0xe2ddd3, 0x9db0bb, 0xc2c6c4, 0xf0f3f5];

const pickF = (id, values) => values.reduce((acc, v, i) => acc.add(step(abs(id.sub(i)), 0.5).mul(v)), float(0));
const pickC = (id, values) => values.reduce((acc, v, i) => acc.add(color(v).mul(step(abs(id.sub(i)), 0.5))), vec3(0));

export function createBuildingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
  const meta = attribute('bmeta', 'vec4');
  const fid = meta.x;
  const seed = meta.y;
  const tall = meta.z;
  const top = meta.w;
  const fp = vec4(pickF(fid, BAY), pickF(fid, FLOOR), pickF(fid, WIN_W), pickF(fid, WIN_H));
  const glassy = pickF(fid, GLASSY);
  const base = mix(pickC(fid, TINT_A), pickC(fid, TINT_B), hash21(vec2(seed, seed.mul(1.7))));
  const n = normalWorldGeometry;
  const wall = smoothstep(0.6, 0.3, abs(n.y));
  const u = uv().x;
  const v = uv().y;
  const bay = fp.x;
  const fh = fp.y;
  const fx = fract(u.div(bay));
  const fy = fract(v.div(fh));
  const wx = max(fwidth(u).div(bay), 0.001);
  const wy = max(fwidth(v).div(fh), 0.001);
  const halfW = fp.z.mul(0.5);
  const halfH = fp.w.mul(0.5);
  const win = band(fx, float(0.5).sub(halfW), float(0.5).add(halfW), wx)
    .mul(band(fy, float(0.5).sub(halfH), float(0.5).add(halfH), wy))
    .mul(wall).mul(step(4.0, v));
  const cell = vec2(floor(u.div(bay)), floor(v.div(fh)).add(seed.mul(97.0)));
  const rnd = hash21(cell);
  const glass = mix(vec3(0.16, 0.22, 0.28), vec3(0.42, 0.56, 0.66), rnd.mul(0.5).add(glassy.mul(0.4)));
  const ground = smoothstep(0.0, 6.0, v).mul(0.25).add(0.75);
  const roof = base.mul(0.72).mul(hash21(floor(positionWorld.xz.div(3.0))).mul(0.12).add(0.9));
  m.colorNode = mix(roof, mix(base, glass, win).mul(ground), wall);
  m.roughnessNode = mix(float(0.85), mix(float(0.75), float(0.08), win.mul(glassy.mul(0.6).add(0.4))), wall);
  m.metalnessNode = win.mul(glassy).mul(0.55);

  // 夜间：窗户随机亮灯；超高层叠加按高度扫动的灯光秀，APEC 主题时偏红金
  const night = sceneUniforms.night;
  const lit = step(rnd, mix(float(0.35), float(0.62), glassy.oneMinus()));
  const warm = mix(color(0xffc58a), color(0xf2f6ff), fract(rnd.mul(7.3)).mul(glassy));
  const winGlow = warm.mul(win).mul(lit).mul(night).mul(1.3);
  const wave = sin(v.mul(0.035).sub(time.mul(1.6)).add(u.mul(0.01))).mul(0.5).add(0.5);
  const sweep = smoothstep(0.75, 1.0, wave);
  const showCol = mix(mix(color(0x2bd9ff), color(0x7a5cff), fract(time.mul(0.05))), mix(color(0xff3b30), color(0xffd166), wave), sceneUniforms.apec);
  const showGlow = showCol.mul(sweep.mul(0.9).add(0.15)).mul(tall).mul(wall).mul(sceneUniforms.show).mul(1.4);
  const crown = smoothstep(fp.y.mul(-1.5), float(0.0), v.sub(top)).mul(tall).mul(night).mul(0.8);
  m.emissiveNode = winGlow.add(showGlow).add(vec3(0.95, 0.97, 1.0).mul(crown).mul(wall));
  return m;
}

export function createGroundMaterial(hex, rough = 0.95) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: 0 });
  const p = positionWorld.xz;
  const grain = hash21(floor(p.div(7.0))).mul(0.08).add(0.96);
  m.colorNode = color(hex).mul(grain);
  return m;
}

export function createWaterMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0.35 });
  const p = positionWorld.xz;
  const w1 = sin(p.x.mul(0.045).add(time.mul(0.6))).mul(sin(p.y.mul(0.06).sub(time.mul(0.45))));
  const w2 = sin(p.x.mul(0.18).sub(p.y.mul(0.11)).add(time.mul(1.4)));
  const ripple = w1.mul(0.5).add(w2.mul(0.25)).mul(0.5).add(0.5);
  const day = mix(color(0x2f6f86), color(0x4c94a6), ripple);
  const nightCol = mix(color(0x0b1a2a), color(0x173149), ripple);
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
