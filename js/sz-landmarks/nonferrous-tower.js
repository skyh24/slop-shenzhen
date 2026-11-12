import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, length, max, mix, normalWorldGeometry,
  positionWorld, sin, smoothstep, step, uv, vec2 } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { baseAt, blend, footprintParts, point } from './parts.js';

export const sourceIds = ['way/1163682856', 'way/1163682857', 'way/1163682858'];
export const optionalSkipIds = ['way/135907001', 'overture/decad456-eee1-4bc4-8917-76bb0aab35e8'];

const samePoint = (a, b) => a.x === b.x && a.z === b.z;

function face(a, b, inside) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
  const side = Math.sign((inside.x - a.x) * -uz + (inside.z - a.z) * ux);
  const nx = -uz * side, nz = ux * side;
  return { length, along: p => (p.x - a.x) * ux + (p.z - a.z) * uz,
    depth: p => (p.x - a.x) * nx + (p.z - a.z) * nz,
    at: (u, v) => point(a.x + u * ux + v * nx, a.z + u * uz + v * nz) };
}

// 两件源轮廓的共边锁定西南曲面，首末各一段是玻璃塔翼的端部。
function sharedFront(tower, podium) {
  const matches = tower.map(p => podium.some(q => samePoint(p, q)));
  const start = matches.findIndex((v, i) => v && !matches[(i + matches.length - 1) % matches.length]);
  if (start < 0) return null;
  const ring = [...tower.slice(start), ...tower.slice(0, start)];
  const shared = ring.findIndex(p => !podium.some(q => samePoint(p, q)));
  const corners = podium.filter(p => !tower.some(q => samePoint(p, q)));
  if (shared < 7 || corners.length !== 1 || podium.length !== shared + 1) return null;
  return { ring, shared, corner: corners[0] };
}

function arcProfile(points, inside) {
  const axis = face(points[0], points.at(-1), inside);
  const stations = points.map(p => ({ p, u: axis.along(p), v: axis.depth(p) }));
  if (stations.some((s, i) => i > 0 && s.u <= stations[i - 1].u)) return null;
  const sag = -Math.min(...stations.map(s => s.v));
  if (sag <= 0.1) return null;
  const radius = axis.length ** 2 / (8 * sag) + sag / 2;
  function depth(u) {
    const index = stations.findIndex(s => s.u >= u);
    if (index <= 0) return index === 0 ? stations[0].v : stations.at(-1).v;
    const a = stations[index - 1], b = stations[index];
    return blend(a.v, b.v, (u - a.u) / (b.u - a.u));
  }
  const arc = u => radius - sag - Math.sqrt(radius ** 2 - (u - axis.length / 2) ** 2);
  return { axis, stations, depth, arc };
}

function recess(front, profile, width, setback) {
  const { axis, stations, depth } = profile;
  const low = axis.length * (1 - width) / 2, high = axis.length - low;
  const joints = [low, ...stations.filter(s => s.u > low && s.u < high).map(s => s.u), high];
  const rear = joints.map(s => axis.at(s, depth(s) + setback));
  const outer = [front.ring[0], ...stations.filter(s => s.u < low).map(s => s.p),
    axis.at(low, depth(low)), ...rear, axis.at(high, depth(high)),
    ...stations.filter(s => s.u > high).map(s => s.p), ...front.ring.slice(front.shared - 1)];
  return { outer, joints, rear };
}

function insideStrip(ring, distance) {
  const clipped = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const da = distance(a), db = distance(b);
    if (da >= 0) clipped.push(a);
    if ((da < 0) === (db < 0)) continue;
    const t = da / (da - db);
    clipped.push(point(blend(a.x, b.x, t), blend(a.z, b.z, t)));
  }
  return clipped;
}

function volume(source, base, id, outer, min, max, style) {
  const [part] = footprintParts({ ...source, polygons: [{ outer, holes: [] }] }, base, style,
    { id: `nonferrous:${id}`, min, max, derived: true });
  // 相对顶部和地面锚点沿用源包。细分尺寸与曲面均为照片拟合。
  return { ...part, shapeSource: 'visual-estimate', heightSource: max === source.height ? source.heightSource : 'estimate' };
}

function towerParts(source, base, front, profile) {
  const h = source.height;
  const middle = recess(front, profile, 0.58, 4.2);
  const upper = recess(front, profile, 0.91, 7.1);
  const middleY = h * 0.337, upperY = h * 0.531;
  const crown = h - 1.15;
  const add = (id, ring, low, high, style) => volume(source, base, id, ring, low, high, style);
  const parts = [
    add('tower-base', front.ring, source.minHeight, middleY, 'nonferrousTowerGlass'),
    add('tower-middle-recess', middle.outer, middleY, upperY, 'nonferrousTowerGlass'),
    add('tower-upper-recess', upper.outer, upperY, crown, 'nonferrousTowerGlass'),
    add('tower-crown', upper.outer, crown, h, 'nonferrousPaleStone')
  ];

  // 低段的直栏板与高段的弧阳台分别成体，露出两翼之间的真实可见缝隙。
  for (const [label, cut, low, high, count] of [
    ['middle', middle, middleY + 2.0, upperY - 1.5, 4], ['upper', upper, upperY + 2.1, crown - 2.2, 11]
  ]) {
    const curved = label === 'upper';
    const chord = Math.max(...cut.joints.map(profile.depth)) + 0.55;
    // 圆弧前缘逐段采样，直栏板和折线后缘只保留改变方向的点。
    const stations = curved ? cut.joints.flatMap((start, i) => {
      if (i === cut.joints.length - 1) return [start];
      const end = cut.joints[i + 1], count = Math.ceil((end - start) / 1.5);
      return Array.from({ length: count }, (_, k) => blend(start, end, k / count));
    }) : [cut.joints[0], cut.joints.at(-1)];
    for (let i = 0; i < count; i++) {
      const y = blend(low, high, i / (count - 1));
      const retreat = curved ? Math.max(0, i - count + 3) * 0.43 : 0;
      const depth = u => curved ? Math.max(profile.arc(u) + 0.65 + retreat, profile.depth(u) + 0.19) : chord;
      const edge = offset => stations.map(u => profile.axis.at(u, depth(u) + offset));
      parts.push(add(`${label}-balcony:${i}`, [...edge(0), ...cut.rear.slice().reverse()], y - 0.29, y, 'nonferrousPaleStone'));
      parts.push(add(`${label}-rail:${i}`, [...edge(0.095), ...edge(0.24).reverse()], y, y + 0.80, 'nonferrousRail'));
    }
  }
  return parts;
}

function podiumParts(northeast, southwest, bases, front) {
  const [northBase, southBase] = bases;
  const northRing = northeast.polygons[0].outer, southRing = southwest.polygons[0].outer;
  const ends = [front.ring[0], front.ring[front.shared - 1]];
  const faces = ends.map(end => face(front.corner, end, ends.find(p => p !== end)));
  const galleryDepth = 3.1, galleryTop = 5.1;
  const lobby = faces.reduce((ring, frame) => insideStrip(ring, p => frame.depth(p) - galleryDepth), southRing);
  if (lobby.length < 3) return [];
  const parts = [
    volume(northeast, northBase, 'north-podium-base', northRing, northeast.minHeight, 1.35, 'nonferrousPaleStone'),
    volume(northeast, northBase, 'north-podium-glass', northRing, 1.35, northeast.height - 0.72, 'nonferrousPodiumGlass'),
    volume(northeast, northBase, 'north-podium-crown', northRing, northeast.height - 0.72, northeast.height, 'nonferrousPaleStone'),
    volume(southwest, southBase, 'south-gallery-lobby', lobby, southwest.minHeight, galleryTop, 'nonferrousLobbyGlass'),
    volume(southwest, southBase, 'south-gallery-soffit', southRing, galleryTop, galleryTop + 0.62, 'nonferrousGallerySoffit'),
    volume(southwest, southBase, 'south-podium-glass', southRing, galleryTop + 0.62, southwest.height - 0.72, 'nonferrousPodiumGlass'),
    volume(southwest, southBase, 'south-podium-crown', southRing, southwest.height - 0.72, southwest.height, 'nonferrousPaleStone')
  ];
  // 只打开照片可见的转角窄带。保留后部实体门厅和落在原基底的柱列。
  for (const [side, frame] of faces.entries()) {
    const stations = side === 0 ? [0.08, 0.31, 0.55, 0.79] : [0.31, 0.55, 0.79];
    for (const [i, t] of stations.entries()) {
      const u = t * frame.length, w = 0.67;
      const pier = [frame.at(u - w, 0.62), frame.at(u + w, 0.62), frame.at(u + w, 1.95), frame.at(u - w, 1.95)];
      parts.push(volume(southwest, southBase, `south-gallery-pier:${side}:${i}`, pier,
        southwest.minHeight, galleryTop, 'nonferrousGalleryPier'));
    }
  }
  return parts;
}

export function build(source, terrain) {
  const [tower, northeast, southwest] = sourceIds.map(id => source.get(id));
  if (![tower, northeast, southwest].every(b => b?.polygons.length === 1 && b.polygons[0].holes.length === 0)) return [];
  if (tower.minHeight !== 0 || northeast.minHeight !== 0 || southwest.minHeight !== 0
    || tower.height < 60 || Math.min(northeast.height, southwest.height) < 10) return [];
  const front = sharedFront(tower.polygons[0].outer, southwest.polygons[0].outer);
  if (!front) return [];
  const profile = arcProfile(front.ring.slice(1, front.shared - 1), point(tower.cx, tower.cz));
  if (!profile || profile.axis.length < 16) return [];
  const podia = podiumParts(northeast, southwest, [baseAt(northeast, terrain), baseAt(southwest, terrain)], front);
  return podia.length ? [...towerParts(tower, baseAt(tower, terrain), front, profile), ...podia] : [];
}

const glazing = {
  nonferrousTowerGlass: { frame: 0xa7aeb0, tint: 0x52758e, top: 0x838988, bay: 1.48, floor: 3.2, sill: 0.47, lit: 0.105 },
  nonferrousPodiumGlass: { frame: 0x9da8a8, tint: 0x465d66, top: 0x878984, bay: 2.2, floor: 1.08, sill: 0.417, lit: 0.04 },
  nonferrousLobbyGlass: { frame: 0x7d8682, tint: 0x384a50, top: 0x6d726b, bay: 1.8, floor: 2.65, sill: 0.466, lit: 0.12 }
};

function galleryStone(soffit) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.73, metalness: 0.04 });
  const coord = uv();
  const stone = color(0xaeb2ac);
  if (!soffit) {
    // 墙面 UV 的纵轴以柱底为零。入口照片中的深色柱脚高度按 0.48 米拟合。
    const abovePlinth = smoothstep(0.46, 0.50, coord.y);
    const side = smoothstep(0.14, 0.57, abs(normalWorldGeometry.y)).oneMinus();
    material.colorNode = mix(stone, color(0x515451), side.mul(abovePlinth.oneMinus()));
    return material;
  }
  // 檐底沿裙房外边方向排板。平面 UV 为世界米制坐标，侧边与顶面保持浅色石材。
  const across = dot(coord, vec2(0.9824, -0.1867)), along = dot(coord, vec2(0.1867, 0.9824));
  const tile = vec2(across, along).div(1.2);
  const seamDistance = abs(fract(tile).sub(0.5));
  const seam = max(seamDistance.x, seamDistance.y);
  const detail = smoothstep(0.08, 0.33, max(fwidth(tile.x), fwidth(tile.y))).oneMinus();
  const underside = step(0.9, normalWorldGeometry.y.negate());
  const joint = smoothstep(0.46, 0.50, seam).mul(detail);
  const lampDistance = length(fract(tile.div(2)).sub(0.5));
  const lamp = smoothstep(0.029, 0.047, lampDistance).oneMinus().mul(detail);
  const panel = mix(mix(color(0x898e8d), color(0x4e5353), joint), color(0xbfc0b4), lamp);
  material.colorNode = mix(stone, panel, underside);
  material.emissiveNode = color(0xffe4b8).mul(0.85).mul(lamp).mul(underside).mul(sceneUniforms.night);
  return material;
}

export function createNonferrousMaterial(name) {
  if (name === 'nonferrousPaleStone') return new THREE.MeshStandardNodeMaterial({ color: 0xaeb2ac, roughness: 0.73, metalness: 0.04 });
  if (name === 'nonferrousRail') return new THREE.MeshStandardNodeMaterial({ color: 0x57716f, roughness: 0.32, metalness: 0.2 });
  if (name === 'nonferrousGalleryPier') return galleryStone(false);
  if (name === 'nonferrousGallerySoffit') return galleryStone(true);
  const style = glazing[name];
  if (!style) throw new Error(`Unknown Nonferrous Tower material: ${name}`);
  const material = new THREE.MeshStandardNodeMaterial();
  const coord = uv(), u = coord.x.div(style.bay), v = coord.y.div(style.floor);
  const soften = cell => max(fwidth(cell), 0.004);
  const pane = (cell, edge) => smoothstep(float(edge).sub(soften(cell)), float(edge).add(soften(cell)),
    abs(fract(cell).sub(0.5))).oneMinus();
  const detail = smoothstep(0.18, 0.73, max(soften(u), soften(v))).oneMinus();
  const glass = mix(float(0.79), pane(u, 0.455).mul(pane(v, style.sill)), detail);
  const wall = smoothstep(0.14, 0.57, abs(normalWorldGeometry.y)).oneMinus();
  const cell = fract(sin(dot(vec2(floor(u), floor(v)), vec2(16.843, 57.193))).mul(43758.5453));
  const tint = color(style.tint).mul(mix(float(1), cell.mul(0.17).add(0.91), detail));
  const reflect = abs(dot(cameraPosition.sub(positionWorld).normalize(), normalWorldGeometry)).oneMinus().pow(2.4);
  let window = mix(tint, color(0xa2bbca), reflect.mul(sceneUniforms.night.oneMinus()).mul(0.34));
  let lit = mix(float(style.lit * 0.21), step(cell, style.lit).mul(0.43), detail);
  if (name === 'nonferrousLobbyGlass') {
    // 低处门厅玻璃和上方深色高窗分区。分界高度为照片拟合，门厅仍为实体边界。
    const transom = smoothstep(2.61, 2.69, coord.y);
    window = mix(window, color(0x23323a), transom.mul(0.84));
    lit = mix(lit.mul(0.25).add(0.065), float(0.012), transom);
  }
  material.colorNode = mix(color(style.top), mix(color(style.frame), window, glass), wall);
  material.roughnessNode = mix(float(0.7), float(0.22), wall.mul(glass));
  material.metalnessNode = wall.mul(glass).mul(0.25);
  material.emissiveNode = color(0xebd6b2).mul(lit).mul(wall).mul(glass).mul(sceneUniforms.night);
  return material;
}
