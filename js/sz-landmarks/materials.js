import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, max, mix, normalWorldGeometry, positionWorld,
  sin, smoothstep, step, uniform, uv, vec2 } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';

const styles = {
  tencentTower: { metal: 0xc9d0d5, glass: 0x60819c, roof: 0x879096, bay: 1.58, floor: 4.87, fin: 0.22, sill: 0.092, lit: 0.15, rough: 0.16, glow: 0xeeeaf2 },
  tencentPodium: { metal: 0xaab2af, glass: 0x556d79, roof: 0x697371, bay: 3.1, floor: 6.9, fin: 0.12, sill: 0.065, lit: 0.1, rough: 0.24, glow: 0xffca97 },
  tencentCopper: { metal: 0xb87543, glass: 0x93603f, roof: 0x776454, bay: 1.38, floor: 5.4, fin: 0.24, sill: 0.095, lit: 0.21, rough: 0.26, glow: 0xffb179 },
  djiCore: { metal: 0xadb5ba, glass: 0x5f6c75, roof: 0x8d959a, bay: 0.67, floor: 4.5, fin: 0.54, sill: 0.04, lit: 0.045, rough: 0.3, glow: 0xe9eff5 },
  djiWing: { metal: 0x9faeb9, glass: 0x385666, roof: 0x828f89, bay: 1.54, floor: 4.5, fin: 0.052, sill: 0.065, lit: 0.14, rough: 0.125, glow: 0xe6f1ff },
  pingAnGlass: { metal: 0x7e929c, glass: 0x455b6d, roof: 0x67737c, bay: 1.56, floor: 4.45, fin: 0.09, sill: 0.11, lit: 0.075, rough: 0.19, glow: 0xd5e9fa },
  pingAnObservation: { metal: 0xaebfc6, glass: 0x435a6d, roof: 0x66717e, bay: 1.07, floor: 5.8, fin: 0.28, sill: 0.082, lit: 0.075, rough: 0.24, glow: 0xd8eeff, wash: 0.085 },
  pingAnLobby: { metal: 0x657076, glass: 0x857359, roof: 0x6c7376, bay: 2.6, floor: 7.9, fin: 0.12, sill: 0.16, lit: 0.16, rough: 0.22, glow: 0xffd095, wash: 0.18 },
  pingAnMallBase: { metal: 0x706562, glass: 0x6d6462, roof: 0x6c7071, bay: 3.7, floor: 6.8, fin: 0.14, sill: 0.17, lit: 0.12, rough: 0.3, glow: 0xffd5a0, wash: 0.09 },
  pingAnMall: { metal: 0xa4a6a6, glass: 0x535a62, roof: 0x7f8586, bay: 1.8, floor: 2.35, fin: 0.045, sill: 0.26, lit: 0.08, rough: 0.28, glow: 0xeed1aa },
  chunsunGlass: { metal: 0x7d8990, glass: 0x4c697b, roof: 0x7e919d, bay: 1.8, floor: 4.95, fin: 0.045, sill: 0.11, lit: 0.075, rough: 0.16, glow: 0xddefff },
  chunsunLobby: { metal: 0x7b8387, glass: 0x6c858e, roof: 0x8b9597, bay: 2.12, floor: 7.0, fin: 0.06, sill: 0.06, lit: 0.085, rough: 0.22, glow: 0xf2d9ae, wash: 0.18 },
  chunsunCrown: { metal: 0xaebfc9, glass: 0x648599, roof: 0xa4b4bd, bay: 1.5, floor: 5.2, fin: 0.06, sill: 0.1, lit: 0.05, rough: 0.18, glow: 0xceeaff, wash: 0.32 }
};

function facadeMaterial(style) {
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
  material.emissiveNode = uniform(new THREE.Color(style.glow)).mul(office.add(style.wash ?? 0))
    .mul(pane).mul(wall).mul(sceneUniforms.night);
  return material;
}

function crownMaterial(tint, roughness, metalness, strength) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, roughness, metalness });
  material.emissiveNode = color(0xc0def7).mul(sceneUniforms.night).mul(strength);
  return material;
}

function roofMaterial(top, bottom, roughness) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0.14 });
  material.colorNode = mix(color(bottom), color(top), smoothstep(-0.26, 0.42, normalWorldGeometry.y));
  return material;
}

export function createLandmarkMaterial(name) {
  if (Object.hasOwn(styles, name)) return facadeMaterial(styles[name]);
  switch (name) {
    case 'djiBrace': return new THREE.MeshStandardMaterial({ color: 0xc4cbd0, metalness: 0.34, roughness: 0.37 });
    case 'djiDeck': return new THREE.MeshStandardMaterial({ color: 0x596570, metalness: 0.36, roughness: 0.62 });
    case 'djiGuard': return new THREE.MeshStandardMaterial({ color: 0x69828c, metalness: 0.48, roughness: 0.36 });
    case 'djiSteel': return new THREE.MeshStandardMaterial({ color: 0x939da5, metalness: 0.48, roughness: 0.39 });
    case 'pingAnSteel': return new THREE.MeshStandardMaterial({ color: 0xb2bdc5, metalness: 0.55, roughness: 0.28 });
    case 'pingAnCrownEdge': return crownMaterial(0xb4c3cc, 0.29, 0.57, 0.32);
    case 'pingAnCrown': return crownMaterial(0x647d91, 0.24, 0.34, 0.24);
    case 'chunsunSteel': return crownMaterial(0xd1dbdf, 0.32, 0.46, 0.06);
    case 'chunsunEntrySteel': return crownMaterial(0xd2d9d7, 0.35, 0.39, 0.13);
    case 'chunsunCrownSteel': return crownMaterial(0xd5e4e9, 0.27, 0.46, 0.28);
    case 'civicRoof': return roofMaterial(0xd6dfdf, 0xd9b88e, 0.54);
    case 'civicRoofBlue': return roofMaterial(0x538ab0, 0x9aa6a7, 0.33);
    case 'civicPillar': return new THREE.MeshStandardMaterial({ color: 0xd2d3cf, metalness: 0.14, roughness: 0.52 });
    case 'civicTowerRed': return new THREE.MeshStandardMaterial({ color: 0xc84d37, metalness: 0.09, roughness: 0.53 });
    case 'civicTowerYellow': return new THREE.MeshStandardMaterial({ color: 0xf0bc58, metalness: 0.09, roughness: 0.53 });
    case 'civicStone': return new THREE.MeshStandardMaterial({ color: 0xb5b6b5, roughness: 0.76 });
    case 'stadiumRib': return new THREE.MeshStandardMaterial({ color: 0xdde4e5, metalness: 0.19, roughness: 0.4 });
    case 'stadiumGlazing': return roofMaterial(0x8ba7b3, 0x667981, 0.29);
    default: throw new Error(`Unknown landmark material: ${name}`);
  }
}
