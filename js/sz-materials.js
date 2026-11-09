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

// 普通楼立面参数表。顺序必须和 tools/sz/buildings.py 的 FACADES 一致：
// glass_tower office residential_tower residential_low village industrial public landmark
// 这些是外观参数，不是逐楼实测的层数、用途或建成年份；窗层节奏只作外观估计。
// 字段：bayWidth/floorHeight 为米；winRatioW/H 是窗占开间/层高的比例；sill 是窗台相对层底的比例；
// glazing 0 实体墙 → 1 玻璃幕墙；warmth 是夜灯偏暖比例；litShare 是模拟亮灯比例；
// groundStyle 0 大堂 / 1 店面 / 2 单元入口 / 3 工业门洞；cornerMargin 墙角留白米数。
// winCount/ac/tiles/suiteSpan/pierWidth 是给细节模块保留的外观参数，本材质直接按上面字段推导。
export const FACADE_PROFILES = [
  {
    name: 'glass_tower', bayWidth: 1.6, floorHeight: 4.2, winRatioW: 0.94, winRatioH: 0.84,
    sill: 0.12, glazing: 1.0, warmth: 0.12, litShare: 0.10,
    groundHeight: 5.2, groundStyle: 0, winCount: 1, ac: 0, tiles: 0, suiteSpan: 1,
    cornerMargin: 0.25, pierWidth: 0,
    wallA: 0x7d8f99, wallB: 0xa6b6c0, trim: 0xb9c4ca, glass: 0x48697c
  },
  {
    name: 'office', bayWidth: 3.0, floorHeight: 3.9, winRatioW: 0.96, winRatioH: 0.50,
    sill: 0.34, glazing: 0.62, warmth: 0.22, litShare: 0.13,
    groundHeight: 4.5, groundStyle: 0, winCount: 1, ac: 0, tiles: 0, suiteSpan: 2,
    cornerMargin: 0.4, pierWidth: 0.06,
    wallA: 0xaeb3ad, wallB: 0xc4c7bf, trim: 0x8e9491, glass: 0x5b7484
  },
  {
    name: 'residential_tower', bayWidth: 3.4, floorHeight: 3.0, winRatioW: 0.80, winRatioH: 0.50,
    sill: 0.28, glazing: 0.28, warmth: 0.80, litShare: 0.18,
    groundHeight: 4.2, groundStyle: 2, winCount: 2, ac: 1, tiles: 0, suiteSpan: 2,
    cornerMargin: 0.4, pierWidth: 0.02,
    wallA: 0xd8d0c2, wallB: 0xc7c0b1, trim: 0xb7ae9e, glass: 0x4e6673
  },
  {
    name: 'residential_low', bayWidth: 3.2, floorHeight: 3.2, winRatioW: 0.78, winRatioH: 0.50,
    sill: 0.30, glazing: 0.25, warmth: 0.88, litShare: 0.17,
    groundHeight: 4.2, groundStyle: 2, winCount: 2, ac: 1, tiles: 0, suiteSpan: 2,
    cornerMargin: 0.35, pierWidth: 0.02,
    wallA: 0xc9b696, wallB: 0xd8c7ae, trim: 0xa8977c, glass: 0x40515a
  },
  {
    name: 'village', bayWidth: 2.6, floorHeight: 2.9, winRatioW: 0.38, winRatioH: 0.40,
    sill: 0.30, glazing: 0.15, warmth: 0.90, litShare: 0.11,
    groundHeight: 4.5, groundStyle: 1, winCount: 1, ac: 1, tiles: 1, suiteSpan: 1,
    cornerMargin: 0.28, pierWidth: 0.015,
    wallA: 0xd9d6cd, wallB: 0xc4c2b9, trim: 0x9a978e, glass: 0x3f5058
  },
  {
    name: 'industrial', bayWidth: 6.0, floorHeight: 6.0, winRatioW: 0.84, winRatioH: 0.26,
    sill: 0.56, glazing: 0.40, warmth: 0.35, litShare: 0.05,
    groundHeight: 6.0, groundStyle: 3, winCount: 1, ac: 0, tiles: 0, suiteSpan: 3,
    cornerMargin: 0.5, pierWidth: 0.04,
    wallA: 0x9aa3a4, wallB: 0xb4b8b4, trim: 0x7e8788, glass: 0x50636c
  },
  {
    name: 'public', bayWidth: 4.0, floorHeight: 4.5, winRatioW: 0.55, winRatioH: 0.55,
    sill: 0.22, glazing: 0.50, warmth: 0.50, litShare: 0.08,
    groundHeight: 4.8, groundStyle: 0, winCount: 1, ac: 0, tiles: 0, suiteSpan: 1,
    cornerMargin: 0.45, pierWidth: 0.03,
    wallA: 0xc8c3b5, wallB: 0xdad5c7, trim: 0xa9a390, glass: 0x4d626d
  },
  {
    name: 'landmark', bayWidth: 1.6, floorHeight: 4.4, winRatioW: 0.94, winRatioH: 0.88,
    sill: 0.10, glazing: 1.0, warmth: 0.18, litShare: 0.10,
    groundHeight: 5.2, groundStyle: 0, winCount: 1, ac: 0, tiles: 0, suiteSpan: 1,
    cornerMargin: 0.25, pierWidth: 0,
    wallA: 0x9ca9b0, wallB: 0xc1c9ce, trim: 0xc4cdd2, glass: 0x546e7e
  }
];

const TINT_A = FACADE_PROFILES.map((p) => p.wallA);

// 常量节点全局复用：重写前 colorNode 里有 329 个重复的 ConstNode，Dawn 编译代价高。
const constants = new Map();
const num = (value) => {
  let node = constants.get(value);
  if (node === undefined) {
    node = float(value);
    constants.set(value, node);
  }
  return node;
};
const ZERO = num(0);
const ONE = num(1);
const HALF = num(0.5);

const hash21 = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

// 不带 fwidth 的区间判断：只用于首层门洞、楼板带这类有明确几何边界的遮罩。
const stepBand = (x, a, b) => step(a, x).mul(step(x, b));

// 带一像素抗锯齿的窗框。边缘过渡用 [0, fw]，比居中 smoothstep 省两个加减节点。
const aaBand = (x, a, b, fw) => smoothstep(ZERO, fw, x.sub(a)).mul(smoothstep(ZERO, fw, b.sub(x)));

// 立面参数按编号插值。fid 是 attribute，不能改写成 JS 分支，否则着色器无法按实例换材质。
const packV = (fields, fallback = 0) => FACADE_PROFILES.map((p) => vec4(
  num(p[fields[0]]), num(p[fields[1]]), num(p[fields[2]]), fields.length > 3 ? num(p[fields[3]]) : num(fallback)));

export function createBuildingMaterial({ showLandmarkLights = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.68, metalness: 0.06 });
  const pickV = (id, values) => values.reduce((acc, value, i) => acc.add(value.mul(step(abs(id.sub(num(i))), HALF))), vec4(0));
  const pickC = (id, values) => values.reduce((acc, value, i) => acc.add(color(value).mul(step(abs(id.sub(num(i))), HALF))), vec3(0));
  const meta = attribute('bmeta', 'vec4');

  const P0 = packV(['bayWidth', 'floorHeight', 'winRatioW', 'winRatioH']);
  const P1 = packV(['sill', 'glazing', 'warmth', 'litShare']);
  const P2 = packV(['groundHeight', 'groundStyle', 'cornerMargin']);
  const fid = meta.x;
  const seed = meta.y;
  const buildingHeight = max(meta.w, ONE);
  const p0 = pickV(fid, P0);
  const p1 = pickV(fid, P1);
  const p2 = pickV(fid, P2);
  const bayNominal = max(p0.x, num(0.6));
  const floorHeight = max(p0.y, num(2));
  const winW = p0.z;
  const winH = p0.w;
  const sill = p1.x;
  const glazing = p1.y;
  const warmth = p1.z;
  const litShare = p1.w;
  const groundHeight = max(p2.x, num(2.2));
  const groundStyle = p2.y;
  const cornerNominal = p2.z;
  // 宽窗统一在一扇窗中间加竖挺表示成组窗/幕墙分格，不再单独画两扇窗。
  const grouped = step(num(0.7), winW);
  const curtain = step(num(0.85), glazing);
  const suiteSpan = ONE.add(step(num(0.9), winW));

  const tone = hash21(vec2(seed, seed.mul(num(1.7))));
  const wallBase = pickC(fid, TINT_A).mul(tone.mul(num(0.22)).add(num(0.86)));
  // 玻璃色由墙色推导：同类型楼的玻璃自然带一点墙色，省掉一次颜色查表。
  const glassTint = mix(color(0x14232c), wallBase.mul(num(0.5)), HALF);
  const trimBase = wallBase.mul(num(1.18));

  const u = uv().x;
  const v = uv().y;
  const wall = ONE.sub(smoothstep(num(0.3), num(0.6), abs(normalWorldGeometry.y)));

  // 按墙长拟合整数开间，墙角留实体余量；u 每面墙从 0 起、meta.z 是墙长，所以两端不会切半窗。
  const wallLength = max(meta.z, HALF);
  const margin = min(cornerNominal, wallLength.mul(num(0.18)));
  const innerLength = max(wallLength.sub(margin.mul(num(2))), num(0.2));
  const bayCount = max(floor(innerLength.div(bayNominal).add(HALF)), ONE);
  const bayWidth = innerLength.div(bayCount);
  const gridU = u.sub(margin).div(bayWidth);
  const inBay = step(margin, u).mul(step(u, wallLength.sub(margin)));
  const fwU = max(fwidth(gridU), num(0.0008));

  // 首层单独分层；标准层从首层顶起算，避免首层被标准层网格切半。
  const groundMask = ONE.sub(smoothstep(groundHeight, groundHeight.add(num(0.35)), v));
  const gridV = max(v.sub(groundHeight), ZERO).div(floorHeight);
  const cellU = fract(gridU);
  const cellV = fract(gridV);
  const row = floor(gridV);
  const cellId = vec2(floor(gridU), row);
  const suite = vec2(floor(gridU.div(suiteSpan)), row);
  const occupancy = hash21(suite.add(vec2(seed.mul(num(17.3)).add(num(32.1)), num(7.6))));
  const fwV = max(fwidth(gridV), num(0.0008));
  const detail = ONE.sub(smoothstep(num(0.2), num(0.7), max(fwU, fwV)));

  // 楼高切到窗台以上时整排窗改实墙，压顶/女儿墙带用 meta.w（楼高）定位。
  const windowTop = groundHeight.add(row.mul(floorHeight)).add(sill.add(winH).mul(floorHeight));
  const topFit = step(windowTop, buildingHeight);
  const belowTop = buildingHeight.sub(v);
  const parapet = wall.mul(ONE.sub(smoothstep(num(0.35), ONE, belowTop)));
  const coping = wall.mul(ONE.sub(smoothstep(num(0.02), num(0.16), belowTop))).mul(detail);

  const upperMask = wall.mul(ONE.sub(groundMask));
  const frameW = num(0.04);
  const halfWin = winW.mul(HALF);
  const glassA = HALF.sub(halfWin);
  const glassB = HALF.add(halfWin);
  const openA = glassA.sub(frameW);
  const openB = glassB.add(frameW);
  const glassX = aaBand(cellU, glassA, glassB, fwU);
  const openX = aaBand(cellU, openA, openB, fwU);
  const glassY = aaBand(cellV, sill, sill.add(winH), fwV);
  const openY = aaBand(cellV, sill.sub(frameW), sill.add(winH).add(frameW), fwV);
  const windowGlass = glassX.mul(glassY);
  const windowFrame = max(openX.mul(openY).sub(windowGlass), ZERO);

  // 成组窗/幕墙竖挺：一格窗中间一道竖挺，不再画第二道横挺。
  const mullion = ONE.sub(smoothstep(ZERO, fwU, abs(cellU.sub(HALF))));
  const mullionMask = mullion.mul(grouped).mul(inBay).mul(upperMask).mul(detail);

  // 阳台门：住宅宽窗右侧下延到楼面，做成落地玻璃门，不再单独画栏杆。
  const doorX = stepBand(cellU, num(0.58), num(0.82));
  const doorLower = step(cellV, sill).mul(doorX).mul(grouped)
    .mul(step(num(0.55), fract(seed.add(cellU.mul(num(0.37))).add(row.mul(num(0.29))))));
  const glazedUpper = max(windowGlass, doorLower).mul(inBay).mul(upperMask);
  const windowArea = winW.mul(winH);
  // 窗格小于一像素时用平均开窗率/平均框宽收敛，远景幕墙仍保持玻璃比例，也不被逐窗框线糊成实墙。
  const glazed = mix(windowArea.mul(inBay).mul(upperMask), glazedUpper, detail).mul(topFit);
  const openingArea = winW.add(frameW.mul(num(2))).mul(winH.add(frameW.mul(num(2))));
  const windowFrameMask = mix(openingArea.sub(windowArea).mul(inBay).mul(upperMask),
    windowFrame.mul(inBay).mul(upperMask), detail);

  // 楼板带：幕墙用更厚的层间带，其余楼一道细带；远景收敛成平均带宽避免条纹。
  const slabWidth = mix(num(0.03), sill, curtain);
  const floorBandMask = mix(slabWidth, step(cellV, slabWidth), detail).mul(inBay).mul(upperMask);

  // 首层：0 大堂、1 店面、2 单元入口、3 工业门洞（与 FACADE_PROFILES.groundStyle 对应）。
  const groundZone = groundMask.mul(inBay).mul(wall);
  const shopStyle = step(num(0.5), groundStyle).mul(ONE.sub(step(num(1.5), groundStyle)));
  const plainStyle = step(num(2.5), groundStyle);
  const lobbyStyle = ONE.sub(shopStyle).sub(plainStyle);
  const groundGlassV = stepBand(v, num(0.3), groundHeight.sub(num(1.1)));
  const groundGlass = groundGlassV.mul(max(shopStyle, lobbyStyle)).mul(groundZone);
  const doorCenter = wallLength.mul(HALF);
  const centerDoor = stepBand(u, doorCenter.sub(num(1.1)), doorCenter.add(num(1.1)));
  const groundDoorV = stepBand(v, num(0.05), num(2.3));
  const groundDoor = groundDoorV.mul(centerDoor).mul(ONE.sub(plainStyle)).mul(groundZone);

  // 颜色全部从已算好的遮罩合成，避免重复的 mix 颜色链。
  const wallColor = wallBase.mul(tone.mul(num(0.16)).add(num(0.92)));
  const trimColor = wallColor.mul(num(1.18));
  const paneTone = mix(ONE, occupancy.mul(num(0.22)).add(num(0.89)), detail);
  const glassColor = glassTint.mul(paneTone);
  const floorColor = wallColor.mul(mix(num(0.74), num(0.5), curtain));
  const frameColor = trimColor.mul(mix(ONE, num(0.6), glazing));
  const groundGlassColor = glassTint.mul(num(0.3));
  const doorColor = glassTint.mul(num(0.18));
  const roofColor = wallColor.mul(num(0.55));

  let surface = wallColor;
  surface = mix(surface, floorColor, floorBandMask);
  surface = mix(surface, glassColor, glazed);
  surface = mix(surface, frameColor, windowFrameMask);
  surface = mix(surface, frameColor, mullionMask);
  surface = mix(surface, groundGlassColor, groundGlass);
  surface = mix(surface, doorColor, groundDoor);
  surface = mix(surface, surface.mul(num(0.62)), parapet);
  surface = mix(surface, trimColor.mul(num(1.04)), coping);
  m.colorNode = mix(surface, roofColor, ONE.sub(wall));

  // 夜间窗灯：按恒定种子决定套间亮灯，不逐帧随机；远景退化成整栋平均亮度，避免碎点闪烁。
  const night = sceneUniforms.night;
  const probability = litShare.mul(tone.mul(num(0.5)).add(num(0.75)));
  const lit = step(occupancy, probability).mul(occupancy.mul(num(2)).add(num(0.7)));
  const light = mix(probability.mul(num(0.26)), lit, detail);
  const windowColor = mix(color(0xd7e6ff), color(0xffc58b), warmth);
  const windowGlow = windowColor.mul(glazed).mul(light).mul(night).mul(num(0.8));
  const groundGlow = mix(color(0xd9e6f0), color(0xffd49a), warmth)
    .mul(groundGlass.add(groundDoor.mul(num(0.7)))).mul(num(0.5)).mul(night);
  m.emissiveNode = windowGlow.add(groundGlow);

  if (showLandmarkLights) {
    // 临时预览页沿用原灯光秀，正式入口的地标各自控制亮灯部位。
    const tall = smoothstep(num(70), num(130), buildingHeight);
    const wave = sin(v.mul(num(0.035)).sub(time.mul(num(1.6))).add(u.mul(num(0.01)))).mul(HALF).add(HALF);
    const sweep = smoothstep(num(0.75), ONE, wave);
    const showCol = mix(mix(color(0x2bd9ff), color(0x7a5cff), fract(time.mul(num(0.05)))),
      mix(color(0xff3b30), color(0xffd166), wave), sceneUniforms.apec);
    const showGlow = showCol.mul(sweep.mul(num(0.9)).add(num(0.15))).mul(tall).mul(wall).mul(sceneUniforms.show).mul(num(1.4));
    const crown = smoothstep(floorHeight.mul(num(-1.5)), ZERO, v.sub(buildingHeight)).mul(tall).mul(night).mul(num(0.8));
    m.emissiveNode = m.emissiveNode.add(showGlow).add(vec3(0.95, 0.97, 1.0).mul(crown).mul(wall));
  }

  const hardSurface = max(windowFrameMask, mullionMask);
  const glassRough = mix(num(0.42), num(0.12), glazing);
  let roughSurface = mix(num(0.86), num(0.55), hardSurface);
  roughSurface = mix(roughSurface, glassRough, glazed);
  roughSurface = mix(roughSurface, num(0.2), groundGlass.add(groundDoor));
  m.roughnessNode = roughSurface;

  const glassMetal = glazing.mul(HALF);
  let metalSurface = mix(num(0.04), num(0.3), hardSurface);
  metalSurface = mix(metalSurface, glassMetal, glazed);
  metalSurface = mix(metalSurface, num(0.15), groundGlass.add(groundDoor));
  m.metalnessNode = metalSurface;
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
  const major = step(9, w);
  const halfW = w.mul(0.5);
  const fw = max(fwidth(v), 0.01);
  const center = smoothstep(fw.add(0.12), 0.12, abs(v)).mul(step(fract(u.div(9)), 0.5)).mul(major);
  const edge = stepBand(abs(v), halfW.sub(0.55), halfW.sub(0.35)).mul(major);
  const asphalt = color(0x3a3d42).mul(hash21(floor(positionWorld.xz.div(2))).mul(0.08).add(0.95));
  const paint = min(center.add(edge), 1);
  m.colorNode = mix(asphalt, color(0xe9e6dc), paint.mul(0.85));
  // 夜间路面被路灯照亮，主干道偏暖
  m.emissiveNode = color(0xffb46b).mul(sceneUniforms.night).mul(major.mul(0.06).add(0.02));
  return m;
}
