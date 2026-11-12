import * as THREE from 'three/webgpu';
import {
  Fn, attribute, uv, vec2, vec3, vec4, float, fract, floor, step, mix, smoothstep, abs, sin, dot, max, min,
  clamp, pow, normalize, uniform, positionWorld, normalWorldGeometry, cameraPosition, time, color, fwidth
} from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';

// 全局氛围参数：night 0 白天 → 1 深夜；show 控制楼体灯光秀。
// 楼体窗灯和首层灯按 docs/22 的 V2 改读 cityUniforms.uInteriorGlow（和纽约立面同一套时段参数），
// night 仍供水面、地标、灯光秀等模块使用。
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

// 航天科技广场 A 座与深圳湾公馆的外观样本。大堂高度参考设计方资料，
// 窗格、阳台和雨棚尺寸取外观估计，坐标为正式包足迹的米制范围。
// materialSeed 取 Math.fround(buildingSeed(id) * 10)，与合批顶点属性一致。
const HOUHAI_OFFICE = 'way/737426464';
const SHENZHEN_BAY_MANSION = 'way/1352291472';
export const FACADE_SAMPLE_PROFILES = {
  [HOUHAI_OFFICE]: {
    appearanceSource: 'estimate', materialSeed: 2.5392842292785645, bounds: [-12104, -12049, 2568, 2626],
    lobbyHeight: 30, canopy: { width: 18, depth: 4.4, height: 5.8 }
  },
  [SHENZHEN_BAY_MANSION]: {
    appearanceSource: 'estimate', materialSeed: 7.08568000793457, bounds: [-13040, -12999, 4019, 4059],
    bayWidth: 4.8, floorHeight: 3.1, balconyDepth: 1.45,
    winRatioW: 0.91, winRatioH: 0.78, sill: 0.15, glazing: 0.9, wallColor: 0x8297a0
  }
};

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

export function createBuildingMaterial() {
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
  const sampleMask = id => {
    const { materialSeed, bounds: [minX, maxX, minZ, maxZ] } = FACADE_SAMPLE_PROFILES[id];
    // 合批后的种子为 float32；足迹范围限制样本的影响范围。
    const seedMask = ONE.sub(step(num(0.00001), abs(seed.sub(num(materialSeed)))));
    return seedMask.mul(stepBand(positionWorld.x, num(minX), num(maxX)))
      .mul(stepBand(positionWorld.z, num(minZ), num(maxZ)));
  };
  const residence = FACADE_SAMPLE_PROFILES[SHENZHEN_BAY_MANSION];
  const residentialSample = sampleMask(SHENZHEN_BAY_MANSION);
  const northLobby = sampleMask(HOUHAI_OFFICE).mul(step(normalWorldGeometry.z, num(-0.85)));
  const bayNominal = max(mix(p0.x, num(residence.bayWidth), residentialSample), num(0.6));
  const floorHeight = max(mix(p0.y, num(residence.floorHeight), residentialSample), num(2));
  const winW = mix(p0.z, num(residence.winRatioW), residentialSample);
  const winH = mix(p0.w, num(residence.winRatioH), residentialSample);
  const sill = mix(p1.x, num(residence.sill), residentialSample);
  const glazing = mix(p1.y, num(residence.glazing), residentialSample);
  const warmth = p1.z;
  const litShare = p1.w;
  const groundHeight = max(mix(p2.x, num(FACADE_SAMPLE_PROFILES[HOUHAI_OFFICE].lobbyHeight), northLobby), num(2.2));
  const groundStyle = p2.y;
  const cornerNominal = p2.z;
  // 宽窗统一在一扇窗中间加竖挺表示成组窗/幕墙分格，不再单独画两扇窗。
  const grouped = step(num(0.7), winW);
  const curtain = step(num(0.85), glazing);
  const suiteSpan = ONE.add(step(num(0.9), winW));

  const tone = hash21(vec2(seed, seed.mul(num(1.7))));
  const wallBase = mix(pickC(fid, TINT_A), color(residence.wallColor), residentialSample).mul(tone.mul(num(0.22)).add(num(0.86)));
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
  const groundGlass = groundGlassV.mul(max(shopStyle, lobbyStyle)).mul(groundZone)
    .mul(ONE.sub(northLobby.mul(mullion).mul(detail)));
  const doorCenter = wallLength.mul(HALF);
  const centerDoor = stepBand(u, doorCenter.sub(num(1.1)), doorCenter.add(num(1.1)));
  const groundDoorV = stepBand(v, num(0.05), num(2.3));
  const groundDoor = groundDoorV.mul(centerDoor).mul(ONE.sub(plainStyle)).mul(groundZone);

  // 颜色全部从已算好的遮罩合成，避免重复的 mix 颜色链。
  const wallColor = wallBase.mul(tone.mul(num(0.16)).add(num(0.92)));
  const trimColor = wallColor.mul(num(1.18));
  const paneTone = mix(ONE, occupancy.mul(num(0.22)).add(num(0.89)), detail);
  // 幕墙玻璃的菲涅尔天空反射：正对视线几乎不变，掠射角向天空色偏移；权重乘玻璃率，
  // 实体墙和非幕墙开窗不受影响，也不重建法线。
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(ONE.sub(abs(dot(viewDir, normalWorldGeometry))), ZERO, ONE);
  const fresnel = pow(facing, num(2));
  const skyReflect = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, fresnel);
  const glassColor = mix(glassTint.mul(paneTone), skyReflect, fresnel.mul(num(0.62)).mul(glazing));
  const floorColor = wallColor.mul(mix(num(0.74), num(0.5), curtain));
  const frameColor = trimColor.mul(mix(ONE, num(0.6), glazing));
  const groundGlassColor = mix(glassTint.mul(num(0.3)), glassColor, northLobby.mul(num(0.72)));
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
  // 亮度只由城市时段参数 uInteriorGlow 驱动：gate 把白天（golden 0.48 / midday 0.24）完全关掉，
  // 仿射项给出黄昏 1.25 约 0.85、午夜 1.55 封顶 0.95 的强度，比旧 night 系数在黄昏亮约 3 倍、午夜约 1.1 倍。
  const interiorGlow = cityUniforms.uInteriorGlow;
  const glowGate = smoothstep(HALF, num(1.2), interiorGlow);
  const glowStrength = glowGate.mul(min(interiorGlow.mul(num(0.9)).sub(num(0.28)), num(0.95)));
  const probability = litShare.mul(tone.mul(num(0.5)).add(num(0.75)));
  const lit = step(occupancy, probability).mul(occupancy.mul(num(2)).add(num(0.7)));
  const light = mix(probability.mul(num(0.26)), lit, detail);
  const windowColor = mix(color(0xd7e6ff), color(0xffc58b), warmth);
  const windowGlow = windowColor.mul(glazed).mul(light).mul(glowStrength).mul(num(0.8));
  // 首层灯光压暗并按套间变化：原来整条店面同样亮，夜景里像一条发光带。
  const groundGlow = mix(color(0xd9e6f0), color(0xffd49a), warmth)
    .mul(groundGlass.add(groundDoor.mul(num(0.7)))).mul(num(0.34))
    .mul(occupancy.mul(num(0.45)).add(num(0.55))).mul(glowStrength);
  m.emissiveNode = windowGlow.add(groundGlow);

  const hardSurface = max(windowFrameMask, mullionMask);
  // 幕墙玻璃对齐纽约 createCurtainWallMaterial：满玻璃率粗糙度 0.055，窗台附近叠一点积灰；
  // 积灰只给幕墙（curtain=1），非幕墙立面的基础粗糙度仍是 0.42→0.12 的旧插值，观感不变。
  const sillDirt = ONE.sub(smoothstep(sill, sill.add(num(0.18)), cellV)).mul(num(0.12)).mul(curtain);
  const glassRough = mix(num(0.42), mix(num(0.12), num(0.055), curtain), glazing).add(sillDirt);
  let roughSurface = mix(num(0.86), num(0.55), hardSurface);
  roughSurface = mix(roughSurface, glassRough, glazed);
  roughSurface = mix(roughSurface, num(0.2), groundGlass.add(groundDoor));
  m.roughnessNode = roughSurface;

  // 只有满玻璃率幕墙抬到 0.72；普通开窗玻璃维持旧的 0.5 × glazing，避免全村窗户变成镜面。
  const glassMetal = glazing.mul(mix(HALF, num(0.72), curtain));
  let metalSurface = mix(num(0.04), num(0.3), hardSurface);
  metalSurface = mix(metalSurface, glassMetal, glazed);
  metalSurface = mix(metalSurface, num(0.15), groundGlass.add(groundDoor));
  m.metalnessNode = metalSurface;
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
