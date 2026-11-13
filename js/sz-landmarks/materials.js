import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, max, mix, normalWorldGeometry, positionWorld,
  sin, smoothstep, step, texture, uniform, uv, vec2 } from 'three/tsl';
import { NORTH_FRAME } from '../sz-rail/geometry.js';
import { sceneUniforms } from '../sz-materials.js';
import { createCulturePavingMask } from './shenzhen-bay-culture-square.js';
import { createUpperhillsMaterial } from './upperhills.js';
import { createNonferrousMaterial } from './nonferrous-tower.js';
import { createIecMaterial } from './iec-xiangmihu.js';
import { createSuperHqMaterial } from './super-hq.js';

const styles = {
  cultureDarkGlass: { metal: 0x56615e, glass: 0x344653, roof: 0x798381, bay: 2.7, floor: 5.3, fin: 0.07, sill: 0.105, lit: 0.15, rough: 0.24, glow: 0xffd6a9, wash: 0.105 },
  mocapeGlass: { metal: 0x82958e, glass: 0x526a68, roof: 0xa4a8a2, bay: 3.8, floor: 2.6, fin: 0.05, sill: 0.04, lit: 0.09, rough: 0.19, glow: 0xffd9ab, wash: 0.19 },
  northGlass: { metal: 0xbcc7cb, glass: 0x375569, roof: 0x9fa7aa, bay: 3.1, floor: 5.0, fin: 0.12, sill: 0.075, lit: 0.3, rough: 0.22, glow: 0xffe5bd, wash: 0.6 },
  tencentTower: { metal: 0xc9d0d5, glass: 0x60819c, roof: 0x879096, bay: 1.58, floor: 4.87, fin: 0.22, sill: 0.092, lit: 0.15, rough: 0.16, glow: 0xeeeaf2 },
  tencentPodium: { metal: 0xaab2af, glass: 0x556d79, roof: 0x697371, bay: 3.1, floor: 6.9, fin: 0.12, sill: 0.065, lit: 0.1, rough: 0.24, glow: 0xffca97 },
  tencentCopper: { metal: 0xb87543, glass: 0x93603f, roof: 0x776454, bay: 1.38, floor: 5.4, fin: 0.24, sill: 0.095, lit: 0.21, rough: 0.26, glow: 0xffb179 },
  tencentLegacyGlass: { metal: 0x6a7f82, glass: 0x496f73, roof: 0x647678, bay: 2.22, floor: 4.72, fin: 0.06, sill: 0.22, lit: 0.11, rough: 0.23, glow: 0xcde4ff, wash: 0.04 },
  landmarkLobby: { metal: 0x839095, glass: 0x3e545a, roof: 0x8a8b82, bay: 2.7, floor: 7.8, fin: 0.09, sill: 0.1, lit: 0.22, rough: 0.31, glow: 0xffdfb7, wash: 0.15 },
  libraryRibbon: { metal: 0xb7c1be, glass: 0x51696c, roof: 0xa7adab, bay: 1.75, floor: 3.4, fin: 0.11, sill: 0.14, lit: 0.12, rough: 0.31, glow: 0xffdfbc, wash: 0.12 },
  diwangShaft: { metal: 0x9b9987, glass: 0x2c6863, roof: 0x728477, bay: 4.4, floor: 4.35, fin: 0.20, sill: 0.10, lit: 0.12, rough: 0.21, glow: 0xc8f2de, wash: 0.047 },
  diwangGlass: { metal: 0x5d9183, glass: 0x2a6059, roof: 0x68877a, bay: 2.6, floor: 4.35, fin: 0.095, sill: 0.14, lit: 0.08, rough: 0.24, glow: 0xc8f2de, wash: 0.074 },
  diwangPodium: { metal: 0xb6a390, glass: 0x544941, roof: 0x87766b, bay: 3.7, floor: 3.35, fin: 0.24, sill: 0.23, lit: 0.19, rough: 0.33, glow: 0xffd6aa },
  kkGlass: { metal: 0x9faeb8, glass: 0x456886, roof: 0x718492, bay: 3.15, floor: 4.3, fin: 0.135, sill: 0.085, lit: 0.105, rough: 0.2, glow: 0xe3efff, wash: 0.036 },
  kkCrown: { metal: 0xb7c7d0, glass: 0x54768e, roof: 0x9daab2, bay: 2.7, floor: 6.1, fin: 0.1, sill: 0.12, lit: 0.16, rough: 0.24, glow: 0xdceeff, wash: 0.19 },
  stockExchangeTower: { metal: 0xc0c7c9, glass: 0x738795, roof: 0x8f999d, bay: 5.54, floor: 8.1, fin: 0.19, sill: 0.15, lit: 0.11, rough: 0.25, glow: 0xd6e4ee },
  stockExchangePodium: { metal: 0xa7b0b4, glass: 0x5c7179, roof: 0x818b90, bay: 2.55, floor: 8.8, fin: 0.23, sill: 0.13, lit: 0.18, rough: 0.27, glow: 0xe9e6d1, wash: 0.11 },
  stockExchangeLobby: { metal: 0xadb5b5, glass: 0x5b6b76, roof: 0x9ea6a7, bay: 4.15, floor: 7.0, fin: 0.12, sill: 0.14, lit: 0.14, rough: 0.29, glow: 0xffdfb7 },
  shoppingParkBase: { metal: 0xb1a7a0, glass: 0x546779, roof: 0x9e9a96, bay: 5.4, floor: 4.4, fin: 0.2, sill: 0.29, lit: 0.14, rough: 0.35, glow: 0xffd6aa },
  shoppingParkGlass: { metal: 0x8d9ba6, glass: 0x345575, roof: 0x717d86, bay: 3.5, floor: 4.1, fin: 0.12, sill: 0.11, lit: 0.11, rough: 0.26, glow: 0xd5e9ff },
  djiCore: { metal: 0xadb5ba, glass: 0x5f6c75, roof: 0x8d959a, bay: 0.67, floor: 4.5, fin: 0.54, sill: 0.04, lit: 0.045, rough: 0.3, glow: 0xe9eff5 },
  djiWing: { metal: 0x9faeb9, glass: 0x385666, roof: 0x828f89, bay: 1.54, floor: 4.5, fin: 0.052, sill: 0.065, lit: 0.14, rough: 0.125, glow: 0xe6f1ff },
  pingAnGlass: { metal: 0x7e929c, glass: 0x455b6d, roof: 0x67737c, bay: 1.56, floor: 4.45, fin: 0.09, sill: 0.11, lit: 0.075, rough: 0.19, glow: 0xd5e9fa, wash: 0.052 },
  pingAnObservation: { metal: 0xaebfc6, glass: 0x435a6d, roof: 0x66717e, bay: 1.07, floor: 5.8, fin: 0.28, sill: 0.082, lit: 0.075, rough: 0.24, glow: 0xd8eeff, wash: 0.31 },
  pingAnLobby: { metal: 0x657076, glass: 0x857359, roof: 0x6c7376, bay: 2.6, floor: 7.9, fin: 0.12, sill: 0.16, lit: 0.16, rough: 0.22, glow: 0xffd095, wash: 0.18 },
  pingAnMallBase: { metal: 0x706562, glass: 0x6d6462, roof: 0x6c7071, bay: 3.7, floor: 6.8, fin: 0.14, sill: 0.17, lit: 0.12, rough: 0.3, glow: 0xffd5a0, wash: 0.09 },
  pingAnMall: { metal: 0xa4a6a6, glass: 0x535a62, roof: 0x7f8586, bay: 1.8, floor: 2.35, fin: 0.045, sill: 0.26, lit: 0.08, rough: 0.28, glow: 0xeed1aa },
  chunsunGlass: { metal: 0x7d8990, glass: 0x4c697b, roof: 0x7e919d, bay: 1.8, floor: 4.95, fin: 0.045, sill: 0.11, lit: 0.075, rough: 0.16, glow: 0xddefff, wash: 0.064 },
  pressTowerGlass: { metal: 0x607f89, glass: 0x286178, roof: 0x67767b, bay: 1.64, floor: 3.94, fin: 0.08, sill: 0.045, lit: 0.13, rough: 0.21, glow: 0xe5f2f4 },
  chunsunLobby: { metal: 0x7b8387, glass: 0x6c858e, roof: 0x8b9597, bay: 2.12, floor: 7.0, fin: 0.06, sill: 0.06, lit: 0.085, rough: 0.22, glow: 0xf2d9ae, wash: 0.37 },
  chunsunCrown: { metal: 0xaebfc9, glass: 0x648599, roof: 0xa4b4bd, bay: 1.5, floor: 5.2, fin: 0.06, sill: 0.1, lit: 0.05, rough: 0.18, glow: 0xceeaff, wash: 0.66 },
  civicGlass: { metal: 0x81919a, glass: 0x667d8c, roof: 0x909798, bay: 2.75, floor: 5.1, fin: 0.1, sill: 0.08, lit: 0.08, rough: 0.23, glow: 0xe8d9bf },
  conventionGlass: { metal: 0x839ba2, glass: 0x455f6c, roof: 0x7b888b, bay: 2.5, floor: 5.8, fin: 0.085, sill: 0.085, lit: 0.1, rough: 0.24, glow: 0xeedfc5, wash: 0.055 }
};

function facadeMaterial(style, programEmission) {
  const material = new THREE.MeshStandardNodeMaterial();
  const u = uv().x;
  const v = uv().y;
  const width = uniform(style.bay);
  const level = uniform(style.floor);
  const bx = u.div(width);
  const by = v.div(level);
  const x = abs(fract(bx).sub(0.5));
  const y = abs(fract(by).sub(0.5));
  const borderX = uniform(0.5 - style.fin / 2);
  const borderY = uniform(0.5 - style.sill / 2);
  const wX = max(fwidth(bx), 0.003);
  const wY = max(fwidth(by), 0.003);
  const detail = smoothstep(0.22, 0.78, max(wX, wY)).oneMinus();
  const pane = mix(float((1 - style.fin) * (1 - style.sill)),
    smoothstep(borderX.sub(wX), borderX.add(wX), x).oneMinus()
      .mul(smoothstep(borderY.sub(wY), borderY.add(wY), y).oneMinus()), detail);
  const noise = fract(sin(dot(vec2(floor(bx), floor(by)), vec2(12.9898, 78.233))).mul(43758.5453));
  const wall = smoothstep(0.15, 0.65, abs(normalWorldGeometry.y)).oneMinus();
  const cladding = uniform(new THREE.Color(style.metal));
  const view = cameraPosition.sub(positionWorld).normalize();
  const fresnel = abs(dot(view, normalWorldGeometry)).oneMinus().pow(2.4);
  const tint = uniform(new THREE.Color(style.glass)).mul(mix(float(0.945), noise.mul(0.21).add(0.84), detail));
  const glazing = mix(tint, color(0xa1b9c9), fresnel.mul(sceneUniforms.night.oneMinus()).mul(0.32));
  material.colorNode = mix(uniform(new THREE.Color(style.roof)), mix(cladding, glazing, pane), wall);
  material.metalnessNode = mix(float(0.12), mix(float(0.38), float(0.26), pane), wall);
  material.roughnessNode = mix(float(0.75), mix(float(0.43), uniform(style.rough), pane), wall);
  const office = mix(float(style.lit * 0.27), step(noise, uniform(style.lit)), detail).mul(0.46);
  const glass = pane.mul(wall);
  const glow = uniform(new THREE.Color(style.glow)).mul(office.add(style.wash ?? 0))
    .mul(glass).mul(sceneUniforms.night);
  material.emissiveNode = programEmission ? programEmission(glow, glass) : glow;
  return material;
}

// 用世界坐标的交错板缝表达金属覆面；像素覆盖不足时淡出缝线，避免远景闪纹。
function cultureCladding(tint, jointColor, spacing, glowColor, glow) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.24, roughness: 0.54 });
  const { x, y, z } = positionWorld;
  const row = x.mul(0.26).sub(z.mul(0.42)).add(y.mul(0.93)).div(spacing);
  const col = x.mul(0.75).add(z.mul(0.71)).div(spacing * 1.55).add(floor(row).mod(2).mul(0.5));
  const seam = a => smoothstep(0.43, 0.5, abs(fract(a).sub(0.5)))
    .mul(smoothstep(0.12, 0.44, fwidth(a)).oneMinus());
  const seams = max(seam(row), seam(col));
  material.colorNode = mix(color(tint), color(jointColor), seams.mul(0.53));
  material.emissiveNode = color(glowColor).mul(sceneUniforms.night).mul(glow).mul(seams.mul(0.12).add(0.88));
  return material;
}

function crownMaterial(tint, roughness, metalness, strength) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, roughness, metalness });
  material.emissiveNode = color(0xc0def7).mul(sceneUniforms.night).mul(strength);
  return material;
}

function libraryShellMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.34, roughness: 0.46 });
  const seam = cell => smoothstep(0.46, 0.5, abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.12, 0.55, fwidth(cell)).oneMinus());
  const joints = max(seam(uv().x.div(2.15)), seam(uv().y.div(1.9)));
  material.colorNode = mix(color(0xc0c6c4), color(0x889291), joints.mul(0.45));
  return material;
}

function graniteMaterial(skylight) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.035, roughness: 0.7 });
  const coord = uv();
  const u = coord.x.mul(105);
  const v = coord.y.mul(37);
  const row = u.mul(0.58).add(v.mul(0.82)).div(0.34);
  const column = u.mul(0.82).sub(v.mul(0.58)).div(1.42).add(floor(row).mod(2).mul(0.5));
  const joint = cell => smoothstep(0.415, 0.485, abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.18, 0.76, fwidth(cell)).oneMinus());
  const seams = max(joint(row), joint(column));
  const stone = mix(color(0xd8d9d3), color(0xb1b6b4), seams.mul(0.45));
  material.colorNode = stone;
  if (skylight) {
    const h = coord.y.sub(0.838);
    const x = fract(coord.x).sub(0.5).sub(h.mul(0.21)).div(0.104);
    const y = h.div(0.116);
    const lens = x.mul(x).add(y.mul(y));
    const edge = smoothstep(0.91, 1.02, lens).oneMinus();
    const glass = smoothstep(0.82, 0.94, lens).oneMinus();
    const pane = max(joint(coord.x.mul(42)), joint(coord.y.mul(19)));
    const tint = mix(color(0x738d9f), color(0x354953), pane.mul(0.68));
    material.colorNode = mix(mix(stone, color(0x40545d), edge), tint, glass);
    material.metalnessNode = mix(float(0.035), float(0.28), glass);
    material.roughnessNode = mix(float(0.7), float(0.26), glass);
  }
  return material;
}

// 春茧园区的铺装和草坪：只按世界坐标做无缝分格与草纹，不引入贴图，标高由几何贴着 DSM 地面。
function stadiumPavingMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.84, metalness: 0.04 });
  const u = positionWorld.x.mul(0.31).add(positionWorld.z.mul(0.05));
  const v = positionWorld.z.mul(0.29).sub(positionWorld.x.mul(0.04));
  const joint = cell => smoothstep(0.455, 0.5, abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.12, 0.5, fwidth(cell)).oneMinus());
  const seams = max(joint(u), joint(v));
  material.colorNode = mix(color(0x918e86), color(0x6f6d67), seams.mul(0.55));
  material.roughnessNode = mix(float(0.86), float(0.7), seams);
  return material;
}

function stadiumLawnMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.02 });
  const wave = positionWorld.x.mul(0.09).add(positionWorld.z.mul(0.07));
  material.colorNode = mix(color(0x4c6a39), color(0x718b48), sin(wave).mul(0.5).add(0.5));
  return material;
}

function cultureParkMaterial() {
  const paving = createCulturePavingMask();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.83, metalness: 0.04 });
  const upper = smoothstep(0.08, 0.44, normalWorldGeometry.y);
  const wave = sin(positionWorld.x.mul(0.109).add(positionWorld.z.mul(0.057)))
    .mul(sin(positionWorld.z.mul(0.123).sub(positionWorld.x.mul(0.079)))).mul(0.5).add(0.5);
  const grass = mix(color(0x526c45), color(0x788d53), wave);
  const ground = mix(grass, color(0xd0cec3), texture(paving).r);
  material.colorNode = mix(color(0xacaea4), ground, upper);
  material.addEventListener('dispose', () => paving.dispose());
  return material;
}

function roofMaterial(top, bottom, roughness, wash = 0) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0.14 });
  const upper = smoothstep(-0.26, 0.42, normalWorldGeometry.y);
  material.colorNode = mix(color(bottom), color(top), upper);
  if (wash > 0) material.emissiveNode = color(0xa3c5ea).mul(upper).mul(sceneUniforms.night).mul(wash);
  return material;
}

function northStationRoof(canopy) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.46, metalness: 0.18 });
  const { center: [x, z], axis: [dx, dz] } = NORTH_FRAME;
  const local = positionWorld.xz.sub(vec2(x, z));
  const axis = dot(local, vec2(dz, -dx));
  const along = dot(local, vec2(dx, dz));
  const seam = (coordinate, spacing) => {
    const bay = coordinate.div(spacing);
    return smoothstep(0.40, 0.495, abs(fract(bay).sub(0.5)))
      .mul(smoothstep(0.12, 0.70, fwidth(bay)).oneMinus());
  };
  const ribs = seam(along, canopy ? 4.9 : 3.2);
  const metal = mix(color(canopy ? 0xaab8bf : 0xc4cdd0), color(0x6c818b), ribs.mul(0.53));
  const upper = smoothstep(0.30, 0.74, normalWorldGeometry.y);
  const underside = mix(color(0x9eabb2), color(0x5f7785), ribs.mul(0.44));
  if (canopy) material.colorNode = mix(underside, metal, upper);
  else {
    const bands = seam(axis, 8.1).mul(0.55).oneMinus();
    const solarZone = smoothstep(1, 2, abs(along.sub(8))).mul(smoothstep(84, 86, abs(along)).oneMinus())
      .mul(smoothstep(138, 140, abs(axis.sub(20))).oneMinus()).mul(step(0.18, fract(axis.div(22))));
    const panels = mix(color(0x303f4d), color(0x657582), max(seam(along, 2.25), seam(axis, 1.15)).mul(0.5));
    material.colorNode = mix(underside, mix(metal.mul(bands), panels, solarZone.mul(0.89)), upper);
  }
  material.emissiveNode = color(0x96b3c3).mul(sceneUniforms.night).mul(0.04);
  return material;
}

function conventionCover(glazed) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: glazed ? 0.27 : 0.51, metalness: glazed ? 0.16 : 0.26 });
  const upper = smoothstep(0.12, 0.48, normalWorldGeometry.y);
  const across = positionWorld.x.add(positionWorld.z.mul(0.026)).div(glazed ? 1.04 : 0.65);
  const groove = smoothstep(0.43, 0.49, abs(fract(across).sub(0.5)))
    .mul(smoothstep(0.18, 0.72, fwidth(across)).oneMinus());
  const face = glazed ? mix(color(0x788b94), color(0x465964), groove.mul(0.58))
    : mix(color(0xa9b2b5), color(0x899598), groove.mul(0.5));
  material.colorNode = mix(color(glazed ? 0x647983 : 0x899396), face, upper);
  if (glazed) material.emissiveNode = color(0xa8c9df).mul(sceneUniforms.night).mul(upper).mul(0.14);
  return material;
}

const CBD_GLASS_STYLES = new Set(['pingAnGlass', 'pingAnObservation', 'civicGlass', 'pressTowerGlass']);

export function createLandmarkMaterial(name, programEmission = null) {
  if (Object.hasOwn(styles, name)) {
    return facadeMaterial(styles[name], CBD_GLASS_STYLES.has(name) ? programEmission : null);
  }
  if (name.startsWith('upperhills')) return createUpperhillsMaterial(name);
  if (name.startsWith('nonferrous')) return createNonferrousMaterial(name);
  if (name.startsWith('iec')) return createIecMaterial(name);
  if (name.startsWith('superHq')) return createSuperHqMaterial(name);
  switch (name) {
    case 'qianhaiTiles': return cultureCladding(0xbec3c1, 0x788482, 1.75, 0xa9c4dd, 0.11);
    case 'operaPearl': return cultureCladding(0xcfd1ce, 0x94a09c, 1.25, 0xb6d5e5, 0.045);
    case 'mocapeMetal': return cultureCladding(0xa4aaa8, 0x707c7b, 2.6, 0xb2c8dc, 0.064);
    case 'cultureStone': return new THREE.MeshStandardMaterial({ color: 0xada99d, roughness: 0.86 });
    case 'cultureRoofGarden': return new THREE.MeshStandardMaterial({ color: 0x617448, roughness: 0.91 });
    case 'cultureSkylight': return crownMaterial(0x6686a0, 0.24, 0.27, 0.33);
    case 'operaCopper': return new THREE.MeshStandardMaterial({ color: 0x975d4f, roughness: 0.65, metalness: 0.21 });
    case 'landmarkEdge': return crownMaterial(0xc0c6c7, 0.39, 0.29, 0.15);
    case 'libraryDeck': return new THREE.MeshStandardMaterial({ color: 0xadada1, roughness: 0.86 });
    case 'libraryShell': return libraryShellMaterial();
    case 'djiBrace': return new THREE.MeshStandardMaterial({ color: 0xc4cbd0, metalness: 0.34, roughness: 0.37 });
    case 'djiDeck': return new THREE.MeshStandardMaterial({ color: 0x596570, metalness: 0.36, roughness: 0.62 });
    case 'djiGuard': return new THREE.MeshStandardMaterial({ color: 0x69828c, metalness: 0.48, roughness: 0.36 });
    case 'djiSteel': return new THREE.MeshStandardMaterial({ color: 0x939da5, metalness: 0.48, roughness: 0.39 });
    case 'pingAnSteel': return crownMaterial(0xb2bdc5, 0.28, 0.55, smoothstep(38, 575, positionWorld.y).mul(0.29).add(0.16));
    case 'pingAnCrownEdge': return crownMaterial(0xb4c3cc, 0.29, 0.57, 0.86);
    case 'pingAnCrown': return crownMaterial(0x647d91, 0.24, 0.34, 0.77);
    case 'chunsunSteel': return crownMaterial(0xd1dbdf, 0.32, 0.46, 0.19);
    case 'chunsunEntrySteel': return crownMaterial(0xd2d9d7, 0.35, 0.39, 0.34);
    case 'chunsunCrownSteel': return crownMaterial(0xd5e4e9, 0.27, 0.46, 0.69);
    case 'northRoof': return northStationRoof(false);
    case 'northCanopy': return northStationRoof(true);
    case 'northStone': return new THREE.MeshStandardMaterial({ color: 0xabb1b0, roughness: 0.73 });
    case 'northColumn': return new THREE.MeshStandardMaterial({ color: 0xe1e4df, roughness: 0.44 });
    case 'civicRoofBlue': return roofMaterial(0x507f9c, 0xb6bec1, 0.39, 0.1);
    case 'civicTrim': return crownMaterial(0xd0d9dc, 0.31, 0.34, 0.55);
    case 'civicPillar': return new THREE.MeshStandardMaterial({ color: 0xd2d3cf, metalness: 0.14, roughness: 0.52 });
    case 'civicTowerRed': return new THREE.MeshStandardMaterial({ color: 0xb83425, metalness: 0.09, roughness: 0.53 });
    case 'civicTowerYellow': return new THREE.MeshStandardMaterial({ color: 0xe3a622, metalness: 0.09, roughness: 0.53 });
    case 'civicStone': return new THREE.MeshStandardMaterial({ color: 0xb5b6b5, roughness: 0.76 });
    case 'pressEye': return roofMaterial(0x1e5364, 0x25454e, 0.21);
    case 'stadiumRib': return roofMaterial(0xdde4e5, 0xc5cac9, 0.41, 0.05);
    case 'stadiumGlazing': return roofMaterial(0x71919e, 0x4d6871, 0.29);
    case 'stadiumRoof': return new THREE.MeshStandardMaterial({ color: 0xbbc9ce, metalness: 0.21, roughness: 0.45 });
    case 'stadiumSeats': return new THREE.MeshStandardMaterial({ color: 0x738b98, roughness: 0.64 });
    case 'stadiumDeck': return new THREE.MeshStandardMaterial({ color: 0x9fa5a5, roughness: 0.73 });
    case 'stadiumPaving': return stadiumPavingMaterial();
    case 'stadiumLawn': return stadiumLawnMaterial();
    case 'cultureGranite': return graniteMaterial(false);
    case 'cultureMonolith': return graniteMaterial(true);
    case 'culturePark': return cultureParkMaterial();
    case 'conventionRoof': return conventionCover(false);
    case 'conventionSkylight': return conventionCover(true);
    case 'conventionHall': return new THREE.MeshStandardMaterial({ color: 0x8e9596, metalness: 0.12, roughness: 0.72 });
    case 'conventionRib': return new THREE.MeshStandardMaterial({ color: 0xccd6db, metalness: 0.27, roughness: 0.46 });
    case 'conventionStone': return new THREE.MeshStandardMaterial({ color: 0xbfc2c0, roughness: 0.82 });
    default: throw new Error(`Unknown landmark material: ${name}`);
  }
}
