// 深圳国际交流中心一期。场馆使用 2026-10-27 OSM 足迹；几何依据及许可口径见 HANDOFF。
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, max, mix, normalWorldGeometry,
  positionWorld, sin, smoothstep, step, uv, vec2 } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { terrainHeight } from '../sz-terrain.js';
import { footprintParts, loftPart, point } from './parts.js';

export const siteId = 'iec-xiangmihu';
const [SOUTH, NORTH, HOTEL, COURT_LINK, LAKE_HALL, COURT, HOTEL_LINK] = [
  'way/1431482482', 'way/1431482483', 'way/1431884285', 'way/1572116213',
  'way/1572116214', 'way/1572116215', 'way/1572116216'
];
export const sourceIds = [SOUTH, NORTH, HOTEL, COURT_LINK, LAKE_HALL, COURT, HOTEL_LINK];

// 总图中被一期建设取代的工地内旧足迹。没有明确落在新楼/前场/施工场地的对象继续保留。
export const optionalSkipIds = [
  'overture/c62d7299-0efa-4c4c-9e81-69aab128f95c', 'overture/705a6399-8375-438e-885e-2b8e13841fe0',
  'overture/05f1882c-2117-4db5-bee1-82083bcb8cf5', 'overture/c87b7838-ac1d-47c4-8f6e-2d3413d312cf',
  'overture/a4da00e6-7d03-444a-a79b-480796eac8c8', 'overture/ca8e0099-46d0-434d-98db-c4b528c16b81',
  'overture/2c61ffe5-b5d0-45a9-8e7a-45907229fdf6', 'overture/ebcc46a6-aae6-43ae-aead-11b6b37d01fe',
  'overture/d56e5bf6-e80c-4027-af1e-454123446bc4', 'overture/8156a63f-cb6a-4faf-9ba0-58a78d94c78b',
  'overture/2f62fd12-9f55-42a7-a703-d73dd3086e4f', 'overture/8a590566-9588-4073-b4e1-14c030df64f6',
  'overture/67738848-c5a0-4b73-901f-89308567d646', 'overture/e316beed-eab5-4a6f-a134-f4f604e1d8f7',
  'globfp/26310', 'globfp/26334', 'globfp/26355'
];

const prefix = siteId + ':';
const design = { wing: 43.57, hotelPodium: 26.3, hotelEave: 99.9, hotelFrame: 105.95 };
const ringArea = ring => ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length];
  return sum + p.x * q.z - q.x * p.z;
}, 0);
const ccw = ring => ringArea(ring) < 0 ? [...ring].reverse() : ring;

function inset(ring, center, ratio) {
  return ring.map(({ x, z }) => point(center.x + (x - center.x) * ratio, center.z + (z - center.z) * ratio));
}

function solid(source, name, outer, low, high, style, options = {}) {
  const id = prefix + name;
  const [part] = footprintParts({ ...source, polygons: [{ outer: ccw(outer), holes: options.holes ?? [] }] },
    low, style, { id, min: 0, max: high - low, derived: true, roofContact: options.contact });
  return { ...part, heightSource: options.heightSource ?? 'estimate', baseSource: 'terrain-local-sample',
    layoutSource: options.sourceOutline ? 'osm-footprint' : 'derived' };
}

function sourceHeights(source, sample) {
  const values = source.polygons[0].outer.map(p => sample(p.x, p.z)).filter(Number.isFinite);
  const center = sample(source.cx, source.cz);
  if (!Number.isFinite(center) || !values.length) return null;
  return { base: center, footing: Math.min(center, ...values) - 0.5 };
}

function wingParts(source, levels, role, north) {
  const outer = ccw(source.polygons[0].outer);
  const center = point(source.cx, source.cz);
  const { base, footing } = levels;
  const eave = base + (north ? 35.5 : 36.8);
  const roof = base + design.wing;
  // 航拍可辨双翼宽檐、抬高的内屋盖和连续采光带。各翼局部檐高与退进为估计。
  const glazing = inset(outer, center, 0.93);
  const shoulder = inset(outer, center, north ? 0.82 : 0.84);
  const crown = inset(outer, center, north ? 0.66 : 0.71);
  return [
    solid(source, role + ':plinth', glazing, footing, base + 4, 'iecStone'),
    solid(source, role + ':curtain-wall', glazing, base + 4, eave, 'iecGlass'),
    solid(source, role + ':eave', outer, eave - 0.7, eave + 1.35, 'iecRoof', { sourceOutline: true }),
    loftPart(prefix + role + ':raised-roof', source, shoulder, crown, eave + 1.35, roof - 1.25, 'iecSkylight'),
    solid(source, role + ':crown', crown, roof - 1.25, roof, 'iecSkylight',
      { heightSource: north ? 'estimate' : 'design' })
  ];
}

function hotelParts(source, { base, footing }) {
  const center = point(source.cx, source.cz);
  const outer = source.polygons[0].outer;
  const stack = inset(outer, center, 0.95);
  const [podium, eave, top] = [design.hotelPodium, design.hotelEave, design.hotelFrame].map(h => base + h);
  const rows = [
    solid(source, 'hotel:podium', outer, footing, podium - 0.9, 'iecHotel', { sourceOutline: true, heightSource: 'design' }),
    solid(source, 'hotel:podium-eave', outer, podium - 0.9, podium, 'iecRoof'),
    solid(source, 'hotel:guestroom-bar', stack, podium, eave - 1.15, 'iecHotel'),
    solid(source, 'hotel:upper-eave', outer, eave - 1.15, eave, 'iecRoof', { heightSource: 'design' }),
    solid(source, 'hotel:roof-pavilion', inset(outer, center, 0.82), eave, top - 0.95, 'iecHotel'),
    solid(source, 'hotel:roof-frame', outer, top - 0.95, top, 'iecRoof', { heightSource: 'design' })
  ];
  return rows;
}

// 南翼红荔西路一侧的建筑入口挑檐。轴线随 OSM 南边，入口宽度、柱距及高程均为外观估计。
export const entry = Object.freeze({ x: -3056.5, z: 43.0, yaw: Math.atan2(0.168, 0.986) });
const along = { x: 0.986, z: -0.168 };
const outward = { x: 0.168, z: 0.986 };
export function entryPoint(u, v) {
  return point(entry.x + along.x * u + outward.x * v, entry.z + along.z * u + outward.z * v);
}

function entryRing(u0, u1, v0, v1) {
  return [entryPoint(u0, v0), entryPoint(u1, v0), entryPoint(u1, v1), entryPoint(u0, v1)];
}

function entryParts(source, sample) {
  const mid = entryPoint(0, 6);
  const level = sample(mid.x, mid.z);
  if (!Number.isFinite(level)) return [];
  const canopy = level + 9.8;
  const parts = [
    solid(source, 'entry:canopy', entryRing(-24, 24, -5, 11), canopy - 0.85, canopy, 'iecRoof'),
    solid(source, 'entry:soffit', entryRing(-23.7, 23.7, -4.7, 10.7), canopy - 0.95, canopy - 0.85, 'iecSoffit')
  ];
  for (const u of [-22, -14, 14, 22]) {
    const center = entryPoint(u, 8.5);
    const bottom = sample(center.x, center.z);
    if (Number.isFinite(bottom)) parts.push(solid(source, 'entry:column:' + u,
      entryRing(u - 0.43, u + 0.43, 8, 9), bottom - 0.25, canopy - 0.93, 'iecStone'));
  }
  const door = entryPoint(0, -5.45);
  const doorBase = sample(door.x, door.z);
  if (Number.isFinite(doorBase)) {
    parts.push(solid(source, 'entry:doors', entryRing(-6.5, 6.5, -5.8, -5.35),
      doorBase - 0.25, doorBase + 4.7, 'iecGlass'));
    parts.push(solid(source, 'entry:transom', entryRing(-6.9, 6.9, -5.9, -5.32),
      doorBase + 4.5, doorBase + 4.85, 'iecSoffit'));
  }
  return parts;
}

// 玻璃中庭、环湖侧独立体量及跨地面连廊以各自源轮廓组装。无功能平面图时保留中庭/厅的外部几何。
function middleParts(source, levels) {
  const parts = [];
  for (const [id, role, lift, height] of [
    [COURT, 'court', 0, 15.5], [COURT_LINK, 'court-upper-link', 15.5, 5.5],
    [LAKE_HALL, 'lake-hall', 0, 23], [HOTEL_LINK, 'hotel-link', 4.9, 4.5]
  ]) {
    const row = source.get(id);
    const { base, footing } = id === COURT_LINK ? levels.get(COURT) : levels.get(id);
    const low = lift ? base + lift : footing;
    const top = base + lift + height;
    const outer = row.polygons[0].outer;
    parts.push(solid(row, role + ':volume', outer, low, top - 0.75, 'iecGlass', { sourceOutline: true }));
    parts.push(solid(row, role + ':roof', outer, top - 0.75, top, 'iecRoof'));
  }
  return parts;
}

export function build(source, terrain, { sites, groundHeight } = {}) {
  if (!sites?.site?.polygons?.length || !terrain || !sourceIds.every(id => source?.get(id)?.polygons?.[0]?.outer?.length)) return [];
  const sample = groundHeight ?? ((x, z) => terrainHeight(terrain, x, z));
  const levels = new Map(sourceIds.map(id => [id, sourceHeights(source.get(id), sample)]));
  if ([...levels.values()].some(level => !level)) return [];
  return [
    ...wingParts(source.get(SOUTH), levels.get(SOUTH), 'south-wing', false),
    ...wingParts(source.get(NORTH), levels.get(NORTH), 'north-wing', true),
    ...hotelParts(source.get(HOTEL), levels.get(HOTEL)),
    ...middleParts(source, levels),
    ...entryParts(source.get(SOUTH), sample)
  ];
}

export const IEC_STYLES = Object.freeze([
  'iecRoof', 'iecGlass', 'iecStone', 'iecPlaza', 'iecHotel', 'iecGreen', 'iecSkylight', 'iecSoffit'
]);

function facadeStyle(style) {
  const material = new THREE.MeshStandardNodeMaterial();
  const coord = uv();
  const bay = coord.x.div(style.bay);
  const level = coord.y.div(style.floor);
  const x = abs(fract(bay).sub(0.5));
  const y = abs(fract(level).sub(0.5));
  const wX = max(fwidth(bay), 0.004);
  const wY = max(fwidth(level), 0.004);
  const detail = smoothstep(0.2, 0.75, max(wX, wY)).oneMinus();
  const pane = mix(float((1 - style.fin) * (1 - style.sill)),
    smoothstep(float(0.5 - style.fin / 2).sub(wX), wX.add(0.5 - style.fin / 2), x).oneMinus()
      .mul(smoothstep(float(0.5 - style.sill / 2).sub(wY), wY.add(0.5 - style.sill / 2), y).oneMinus()), detail);
  const noise = fract(sin(dot(vec2(floor(bay), floor(level)), vec2(12.9898, 78.233))).mul(43758.5453));
  const wall = smoothstep(0.15, 0.65, abs(normalWorldGeometry.y)).oneMinus();
  const view = cameraPosition.sub(positionWorld).normalize();
  const fresnel = abs(dot(view, normalWorldGeometry)).oneMinus().pow(2.4);
  const tint = color(style.glass).mul(mix(float(0.95), noise.mul(0.2).add(0.85), detail));
  const glazing = mix(tint, color(0xa6becd), fresnel.mul(sceneUniforms.night.oneMinus()).mul(0.3));
  const facade = mix(color(style.frame), glazing, pane);
  // 酒店层间挑板用幕墙坐标模拟，远处随像素覆盖率衰减。
  const slab = style.slab ? smoothstep(0.31, 0.43, y).mul(detail) : float(0);
  material.colorNode = mix(color(style.roof), mix(facade, color(0xbab5a6), slab), wall);
  material.metalnessNode = mix(float(0.12), mix(float(0.34), float(0.22), pane), wall);
  material.roughnessNode = mix(float(0.74), mix(float(0.42), float(style.rough ?? 0.24), pane), wall);
  const lit = mix(float(style.lit * 0.24), step(noise, style.lit), detail).mul(0.5);
  material.emissiveNode = color(style.glow).mul(lit).mul(pane).mul(wall).mul(sceneUniforms.night);
  return material;
}

function skylightMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0.23 });
  const u = positionWorld.x.mul(0.986).sub(positionWorld.z.mul(0.168)).div(5.4);
  const v = positionWorld.z.mul(0.986).add(positionWorld.x.mul(0.168)).div(2.2);
  const rail = cell => smoothstep(0.445, 0.5, abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.1, 0.55, fwidth(cell)).oneMinus());
  const ribs = max(rail(u), rail(v));
  material.colorNode = mix(color(0x7898ab), color(0xc6cbc9), ribs);
  return material;
}

function plazaMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.04 });
  const gx = positionWorld.x.div(3.2);
  const gz = positionWorld.z.div(3.2);
  const joint = cell => smoothstep(0.455, 0.5, abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.12, 0.6, fwidth(cell)).oneMinus());
  const seam = max(joint(gx), joint(gz));
  const upper = smoothstep(0.1, 0.5, normalWorldGeometry.y);
  material.colorNode = mix(color(0x9a9b95), mix(color(0xcac9c1), color(0xa9aaa2), seam), upper);
  material.roughnessNode = mix(float(0.86), mix(float(0.8), float(0.62), seam), upper);
  return material;
}

function roofMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.44, metalness: 0.32 });
  const along = positionWorld.x.mul(0.986).add(positionWorld.z.mul(-0.168)).div(1.15);
  const rib = smoothstep(0.42, 0.5, abs(fract(along).sub(0.5)))
    .mul(smoothstep(0.15, 0.62, fwidth(along)).oneMinus());
  const upper = smoothstep(0.05, 0.5, normalWorldGeometry.y);
  material.colorNode = mix(color(0x8f989b), mix(color(0xdfe3e2), color(0xb4bab9), rib), upper);
  material.roughnessNode = mix(float(0.7), float(0.38), upper);
  material.emissiveNode = color(0xa9c8de).mul(upper).mul(sceneUniforms.night).mul(0.08);
  return material;
}

function greenMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.02 });
  const stripes = sin(positionWorld.x.mul(0.36).add(positionWorld.z.mul(0.21))).mul(0.5).add(0.5);
  material.colorNode = mix(color(0x38502f), color(0x5d7a3c), stripes.mul(0.7).add(0.3));
  return material;
}

/** 解析：国际交流中心材质分派（iecRoof/iecGlass/iecStone/iecPlaza/iecHotel/iecGreen/iecFlag）。
 *  输入：样式名。
 *  输出：对应 MeshStandardNodeMaterial；未知名抛错。 */
export function createIecMaterial(name) {
  switch (name) {
    case 'iecRoof':
      return roofMaterial();
    case 'iecGlass':
      return facadeStyle({ frame: 0x7d8f97, glass: 0x46606d, roof: 0x7a888b, bay: 2.6, floor: 6.4,
        fin: 0.09, sill: 0.06, lit: 0.1, rough: 0.2, glow: 0xeedfc5 });
    case 'iecStone':
      return new THREE.MeshStandardNodeMaterial({ color: 0xc3c2ba, roughness: 0.76, metalness: 0.03 });
    case 'iecPlaza':
      return plazaMaterial();
    case 'iecHotel':
      return facadeStyle({ frame: 0x9aa2a0, glass: 0x4d6570, roof: 0x848b88, bay: 3.4, floor: 3.6,
        fin: 0.07, sill: 0.23, slab: true, lit: 0.13, rough: 0.3, glow: 0xffd8a8 });
    case 'iecGreen':
      return greenMaterial();
    case 'iecSkylight':
      return skylightMaterial();
    case 'iecSoffit':
      return new THREE.MeshStandardNodeMaterial({ color: 0x725e4a, roughness: 0.7,
        emissiveNode: color(0xffbd80).mul(sceneUniforms.night).mul(0.22) });
    default:
      throw new Error(`Unknown IEC material: ${name}`);
  }
}
