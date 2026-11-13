import * as THREE from 'three/webgpu';
import {
  Fn, attribute, uv, vec2, vec3, vec4, float, fract, floor, step, mix, smoothstep, abs, sin, dot, max, min,
  clamp, pow, normalize, uniform, positionWorld, normalWorldGeometry, cameraPosition, time, color, fwidth
} from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';
import { FACADE_PROFILES, FACADE_SAMPLE_PROFILES, HOUHAI_OFFICE, SHENZHEN_BAY_MANSION } from './sz-facade-profiles.js';

// 全局氛围参数：night 0 白天 → 1 深夜；show 控制楼体灯光秀。
// 楼体窗灯和首层灯按 docs/22 的 V2 改读 cityUniforms.uInteriorGlow（和纽约立面同一套时段参数），
// night 仍供水面、地标、灯光秀等模块使用。
export const sceneUniforms = {
  night: uniform(0),
  show: uniform(0),
  apec: uniform(1)
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

// 零售开间：左侧橱窗、右侧落地玻璃门，上方气窗；远景平均玻璃比例，陈列仅近看显示。
const shopDetails = Fn(([x, y, pixel]) => {
  const detail = ONE.sub(smoothstep(num(0.12), num(0.48), pixel));
  const display = aaBand(x, num(0.075), num(0.687), pixel).mul(stepBand(y, num(0.105), num(0.653)));
  const entry = aaBand(x, num(0.715), num(0.925), pixel).mul(stepBand(y, num(0.025), num(0.653)));
  const transom = stepBand(y, num(0.675), num(0.802)).mul(aaBand(x, num(0.075), num(0.925), pixel));
  const pane = mix(num(0.66), max(transom, max(display, entry)), detail);
  const stock = stepBand(fract(x.mul(num(9))), num(0.18), num(0.77))
    .mul(stepBand(y, num(0.17), num(0.32))).mul(display).mul(detail);
  const frame = aaBand(x, num(0.045), num(0.955), pixel);
  return vec3(pane, stock, frame);
}).setLayout({ name: 'retail_shop_details', type: 'vec3', inputs: [
  { name: 'shopX', type: 'float' }, { name: 'shopY', type: 'float' }, { name: 'pixel', type: 'float' }
] });

// 立面参数按编号插值。fid 是 attribute，不能改写成 JS 分支，否则着色器无法按实例换材质。
const packV = (fields, fallback = 0) => FACADE_PROFILES.map((p) => vec4(
  num(p[fields[0]]), num(p[fields[1]]), num(p[fields[2]]), fields.length > 3 ? num(p[fields[3]]) : num(fallback)));

export function createBuildingMaterial(programEmission = null) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.68, metalness: 0.06 });
  const meta = attribute('bmeta', 'vec4');

  const P0 = packV(['bayWidth', 'floorHeight', 'winRatioW', 'winRatioH']);
  const P1 = packV(['sill', 'glazing', 'warmth', 'litShare']);
  const P2 = packV(['groundHeight', 'groundStyle', 'cornerMargin']);
  const fid = meta.x;
  const seed = meta.y;
  const buildingHeight = max(meta.w, ONE);
  const matches = FACADE_PROFILES.map((_, i) => step(abs(fid.sub(num(i))), HALF));
  const pickV = values => values.reduce((acc, value, i) => acc.add(value.mul(matches[i])), vec4(0));
  const p0 = pickV(P0);
  const p1 = pickV(P1);
  const p2 = pickV(P2);
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
  const wallTint = TINT_A.reduce((acc, value, i) => acc.add(color(value).mul(matches[i])), vec3(0));
  const wallBase = mix(wallTint, color(residence.wallColor), residentialSample).mul(tone.mul(num(0.22)).add(num(0.86)));
  // 玻璃色由墙色推导：同类型楼的玻璃自然带一点墙色，省掉一次颜色查表。
  const glassTint = mix(color(0x14232c), wallBase.mul(num(0.5)), HALF);
  const trimBase = wallBase.mul(num(1.18));

  const u = uv().x;
  const v = uv().y;
  const wall = ONE.sub(smoothstep(num(0.3), num(0.6), abs(normalWorldGeometry.y)));

  // 按墙长拟合整数开间，墙角留实体余量；u 每面墙从 0 起、meta.z 是墙长，所以两端不会切半窗。
  const wallLength = max(abs(meta.z), HALF);
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

  // 零售商区参照纽约的分铺、落地橱窗和侧门。玻璃反射与陈列由墙面着色模拟，保持实体碰撞。
  const retailHeight = min(num(3.65), min(groundHeight, buildingHeight.sub(num(0.08))));
  const retailWall = step(meta.z, num(-0.5));
  const shopZone = wall.mul(retailWall).mul(stepBand(v, ZERO, retailHeight));
  const shopMargin = min(num(0.45), wallLength.mul(num(0.1)));
  const shopSpan = max(wallLength.sub(shopMargin.mul(num(2))), HALF);
  const shopGrid = u.sub(shopMargin).div(shopSpan).mul(max(ONE, floor(shopSpan.div(num(6.3)).add(HALF))));
  const shopU = fract(shopGrid);
  const shopV = v.div(retailHeight);
  const shopPixel = max(fwidth(shopGrid), num(0.002));
  const details = shopDetails(shopU, shopV, shopPixel);
  const shopFront = shopZone.mul(stepBand(u, shopMargin, wallLength.sub(shopMargin))).mul(details.z);
  const shopPane = shopFront.mul(details.x);
  const shopTone = fract(seed.mul(num(0.83)).add(floor(shopGrid).mul(num(0.618))));

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
  const ordinaryGround = ONE.sub(retailWall);
  const baseGlass = groundGlass.mul(ordinaryGround);
  const baseDoor = groundDoor.mul(ordinaryGround);
  surface = mix(surface, groundGlassColor, baseGlass);
  surface = mix(surface, doorColor, baseDoor);
  const shopFrame = mix(color(0x253439), color(0x5b493c), shopTone);
  const shopGlass = mix(mix(color(0x435961), color(0xb89a76), details.y.mul(num(0.65))),
    skyReflect, num(0.13).add(fresnel.mul(num(0.58))));
  surface = mix(surface, shopFrame, shopFront);
  surface = mix(surface, shopGlass, shopPane);
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
    .mul(baseGlass.add(baseDoor.mul(num(0.7)))).mul(num(0.34))
    .mul(occupancy.mul(num(0.45)).add(num(0.55))).mul(glowStrength);
  const officeGlow = programEmission ? programEmission(windowGlow, glazed.mul(ONE.sub(mullionMask))) : windowGlow;
  const shopGlow = color(0xffd19b).mul(shopPane).mul(shopTone.mul(num(0.19)).add(num(0.055)))
    .mul(glowStrength);
  m.emissiveNode = officeGlow.add(groundGlow).add(shopGlow);

  const hardSurface = max(windowFrameMask, mullionMask);
  // 幕墙玻璃对齐纽约 createCurtainWallMaterial：满玻璃率粗糙度 0.055，窗台附近叠一点积灰；
  // 积灰只给幕墙（curtain=1），非幕墙立面的基础粗糙度仍是 0.42→0.12 的旧插值，观感不变。
  const sillDirt = ONE.sub(smoothstep(sill, sill.add(num(0.18)), cellV)).mul(num(0.12)).mul(curtain);
  const glassRough = mix(num(0.42), mix(num(0.12), num(0.055), curtain), glazing).add(sillDirt);
  let roughSurface = mix(num(0.86), num(0.55), hardSurface);
  roughSurface = mix(roughSurface, glassRough, glazed);
  roughSurface = mix(roughSurface, num(0.2), baseGlass.add(baseDoor).add(shopPane));
  m.roughnessNode = roughSurface;

  // 只有满玻璃率幕墙抬到 0.72；普通开窗玻璃维持旧的 0.5 × glazing，避免全村窗户变成镜面。
  const glassMetal = glazing.mul(mix(HALF, num(0.72), curtain));
  let metalSurface = mix(num(0.04), num(0.3), hardSurface);
  metalSurface = mix(metalSurface, glassMetal, glazed);
  metalSurface = mix(metalSurface, num(0.15), baseGlass.add(baseDoor).add(shopPane));
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
