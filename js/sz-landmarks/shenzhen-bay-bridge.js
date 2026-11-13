import * as THREE from 'three/webgpu';
import { abs, attribute, color, float, fract, fwidth, max, min, mix, positionWorld, smoothstep, step, uv } from 'three/tsl';
import { GeoBuilder } from '../sz-geometry.js';
import { sceneUniforms } from '../sz-materials.js';

const lerp = (a, b, t) => a + (b - a) * t;
const point = (x, y, z) => new THREE.Vector3(x, y, z);

function bridgeFrames(rows, side) {
  const frames = rows.filter(row => side === 'primary' || row.oppositeX != null).map(row => {
    const x = side === 'primary' ? row.x : side === 'opposite' ? row.oppositeX : (row.x + row.oppositeX) / 2;
    const z = side === 'primary' ? row.z : side === 'opposite' ? row.oppositeZ : (row.z + row.oppositeZ) / 2;
    return { s: row.stationM, x, y: row.y, z, lanes: side === 'opposite' ? row.oppositeLanes : row.lanes };
  });
  // 固定采样距离取切线，避免双幅源节点挨得过近时断面翻转。
  for (const frame of frames) {
    const a = interpolateFrame(frames, Math.max(frames[0].s, frame.s - 9));
    const b = interpolateFrame(frames, Math.min(frames.at(-1).s, frame.s + 9));
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    frame.nx = (b.z - a.z) / length;
    frame.nz = (a.x - b.x) / length;
  }
  return frames;
}

function interpolateFrame(frames, s) {
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (frames[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = frames[lo], b = frames[hi];
  const t = (s - a.s) / (b.s - a.s);
  return { s, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
    nx: lerp(a.nx, b.nx, t), nz: lerp(a.nz, b.nz, t) };
}

function sectionAt(frames, s) {
  const frame = interpolateFrame(frames, s);
  const length = Math.hypot(frame.nx, frame.nz);
  return { ...frame, nx: frame.nx / length, nz: frame.nz / length };
}

function sectionPoint(frame, across, height = 0, along = 0) {
  return point(frame.x + frame.nx * across - frame.nz * along,
    frame.y + height, frame.z + frame.nz * across + frame.nx * along);
}

function face(builder, vertices, coords, meta) {
  const [a, b, c] = vertices;
  const n = b.clone().sub(a).cross(c.clone().sub(a));
  if (n.lengthSq() < 1e-12) return;
  n.normalize();
  const first = builder.count;
  vertices.forEach((p, i) => builder.vertex(p.x, p.y, p.z, n.x, n.y, n.z,
    coords?.[i][0] ?? 0, coords?.[i][1] ?? 0, meta));
  for (let i = 1; i + 1 < vertices.length; i++) builder.tri(first, first + i, first + i + 1);
}

// 同一断面首尾闭合。桥面、梁、护栏及柱体都保留真实可见空间。
function loft(builder, rings) {
  if (rings.length < 2) return;
  const sides = rings[0].length;
  for (let i = 1; i < rings.length; i++) {
    const a = rings[i - 1], b = rings[i];
    for (let j = 0; j < sides; j++) {
      const k = (j + 1) % sides;
      face(builder, [a[j], b[j], b[k], a[k]]);
    }
  }
  face(builder, rings[0]);
  face(builder, [...rings.at(-1)].reverse());
}

function deckGirder(builder, frames, width, depth, steel = false) {
  const half = width / 2;
  const lower = half * (steel ? 0.78 : 0.55);
  const profile = [[-half, -0.035], [half, -0.035], [half, -0.5],
    [lower, -depth], [-lower, -depth], [-half, -0.5]];
  loft(builder, frames.map(frame => profile.map(([x, y]) => sectionPoint(frame, x, y))));
}

function addRoadway(builder, frames, width) {
  const left = -width / 2 + 0.22, right = -left;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    face(builder, [sectionPoint(a, left), sectionPoint(b, left), sectionPoint(b, right), sectionPoint(a, right)],
      [[a.s, left], [b.s, left], [b.s, right], [a.s, right]], [a.lanes, 0, 0, 0]);
  }
}

function addParapets(builder, frames, width) {
  for (const side of [-1, 1]) {
    const center = side * (width / 2 - 0.28);
    const profile = [[center - 0.2, 0.95], [center + 0.2, 0.95],
      [center + 0.28, -0.04], [center - 0.28, -0.04]];
    loft(builder, frames.map(frame => profile.map(([x, y]) => sectionPoint(frame, x, y))));
  }
}

function crossSection(frame, width, depth, sides) {
  return sides.map(([u, v]) => sectionPoint(frame, u * width, 0, v * depth));
}

const OVAL = Array.from({ length: 10 }, (_, i) => {
  const a = i * Math.PI * 2 / 10;
  return [0.5 * Math.cos(a), 0.5 * Math.sin(a)];
});
const CHAMFERED = [[-0.4, -0.5], [0.4, -0.5], [0.5, -0.4], [0.5, 0.4],
  [0.4, 0.5], [-0.4, 0.5], [-0.5, 0.4], [-0.5, -0.4]];

function addPier(builder, frame, topY, spec) {
  if (topY < 0.5) return;
  const { pierWidthM: w, pierDepthM: d } = spec;
  const sections = [[0, w, d], [topY - 0.45, w, d], [topY, w * 1.25, d * 1.24]];
  loft(builder, sections.map(([y, width, depth]) => crossSection({ ...frame, y }, width, depth, OVAL)));
}

function tube(builder, a, b, radiusA, radiusB, sides) {
  const direction = b.clone().sub(a).normalize();
  const ref = Math.abs(direction.y) > 0.95 ? point(1, 0, 0) : point(0, 1, 0);
  const u = ref.cross(direction).normalize();
  const v = direction.clone().cross(u);
  const ring = (center, radius) => Array.from({ length: sides }, (_, i) => {
    const angle = -i * Math.PI * 2 / sides;
    return center.clone().addScaledVector(u, Math.cos(angle) * radius).addScaledVector(v, Math.sin(angle) * radius);
  });
  loft(builder, [ring(a, radiusA), ring(b, radiusB)]);
}

function addPylon(concrete, pylons, cables, span, frames) {
  const { tower } = span;
  const onDeck = sectionAt(frames, tower.stationM);
  const pylonFrame = { ...onDeck, x: tower.x, z: tower.z, y: tower.y };
  const rise = tower.topY - tower.y;
  const towerPoint = y => sectionPoint(pylonFrame, 0, y - tower.y, (y - tower.y) * tower.lean);
  const base = tower.baseSectionM ?? [8.7, 11.5];
  const top = tower.topSectionM ?? [4, 6];
  const deck = [lerp(base[0], top[0], 0.64), lerp(base[1], top[1], 0.62)];
  const levels = [[tower.capY, ...base], [tower.y, ...deck], [tower.topY, ...top]];
  loft(pylons, levels.map(([y, width, depth]) => {
    const p = towerPoint(y);
    return crossSection({ ...onDeck, x: p.x, y, z: p.z }, width, depth, CHAMFERED);
  }));
  if (tower.pileCapPlanM) {
    const p = towerPoint(tower.capY);
    const [w, d] = tower.pileCapPlanM;
    loft(concrete, [0, tower.capY].map(y => crossSection({ ...onDeck, x: p.x, y, z: p.z }, w, d, CHAMFERED)));
  }

  // 采用公开的梁上索距。首个锚点、塔上锚点和索径采用远景估计。
  const layout = span.stayLayout;
  for (let i = 0; i < span.stayPairs; i++) {
    const t = i / (span.stayPairs - 1);
    const attach = towerPoint(tower.y + lerp(0.4 * rise, rise - 3.2, t));
    const main = layout ? layout.estimatedFirstMainAnchorM + i * layout.stayMainSpacingM : span.mainSpanM * lerp(0.19, 0.91, t);
    const back = layout ? layout.estimatedLastBackAnchorM - (span.stayPairs - 1 - i) * layout.stayBackSpacingM : span.backSpanM * lerp(0.19, 0.91, t);
    for (const [direction, distance] of [[span.mainDirection, main], [-span.mainDirection, back]]) {
      const anchor = sectionAt(frames, tower.stationM + direction * distance);
      const radius = lerp(0.092, 0.15, t);
      tube(cables, attach, sectionPoint(anchor, 0, 0.45), radius, radius, 5);
    }
  }
}

function addStreetlights(poles, lenses, frames, otherFrames, spec, width) {
  const spacing = spec.designSpacingM ?? spec.estimatedSpacingM;
  const height = spec.designHeightM;
  let count = 0;
  for (let s = Math.ceil(frames[0].s / spacing) * spacing; s < frames.at(-1).s; s += spacing) {
    const frame = sectionAt(frames, s);
    const hasOther = s >= otherFrames[0].s && s <= otherFrames.at(-1).s;
    const other = hasOther ? sectionAt(otherFrames, s) : null;
    const side = !other || (frame.x - other.x) * frame.nx + (frame.z - other.z) * frame.nz >= 0 ? 1 : -1;
    const edge = side * (width / 2 - 0.29);
    const top = sectionPoint(frame, edge, height);
    const arm = sectionPoint(frame, edge - side * 1.25, height + 0.12);
    tube(poles, sectionPoint(frame, edge, 0.85), top, 0.19, 0.073, 5);
    tube(poles, top, arm, 0.073, 0.063, 5);
    const lamp = { ...frame, x: arm.x, y: arm.y, z: arm.z };
    loft(lenses, [crossSection({ ...lamp, y: arm.y - 0.16 }, 1.05, 0.46, CHAMFERED),
      crossSection({ ...lamp, y: arm.y + 0.1 }, 1.05, 0.46, CHAMFERED)]);
    count++;
  }
  return count;
}

function bridgeMaterials() {
  const make = (base, roughness, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color: base, roughness, metalness });
  const asphalt = make(0x3d4345, 0.94);
  const across = uv().y;
  const activeHalfWidth = attribute('bmeta', 'vec4').x.mul(1.825);
  const antialias = max(fwidth(across), 0.006);
  const stripe = distance => float(1).sub(smoothstep(float(0.07).sub(antialias), float(0.07).add(antialias), distance))
    .mul(min(1, float(0.14).div(antialias)));
  const edge = stripe(abs(abs(across).sub(activeHalfWidth)));
  const dividerDistance = abs(fract(across.add(activeHalfWidth).div(3.65).add(0.5)).sub(0.5)).mul(3.65);
  const divider = stripe(dividerDistance).mul(step(abs(across), activeHalfWidth.sub(0.4)))
    .mul(step(fract(uv().x.div(12)), 0.35));
  asphalt.colorNode = mix(color(0x3d4345), color(0xe8e6da), min(edge.add(divider), 1));
  asphalt.emissiveNode = color(0xffe4b9).mul(sceneUniforms.night).mul(0.023);

  const lens = make(0xa8a69d, 0.46);
  lens.emissiveNode = color(0xffdfb7).mul(sceneUniforms.night).mul(5.2);
  const pylon = make(0xbfc6c2, 0.83);
  const flood = smoothstep(13, 38, positionWorld.y).mul(float(1).sub(smoothstep(86, 158, positionWorld.y)));
  pylon.emissiveNode = color(0xdce3e8).mul(sceneUniforms.night).mul(flood).mul(0.6);
  return { concrete: make(0xb3bbb8, 0.88), steel: make(0x79888d, 0.58, 0.15), asphalt,
    parapet: make(0xc0c6bf, 0.79), metal: make(0x9baeb8, 0.49, 0.22), lens, pylon };
}

export function buildShenzhenBayBridge(scene, bridge) {
  if (!bridge) return { group: null, meshes: [], collisionGeometry: [], statistics: null, dispose() {} };
  const { stations, spans, approach, lighting } = bridge;
  const primary = bridgeFrames(stations, 'primary');
  const opposite = bridgeFrames(stations, 'opposite');
  const middle = bridgeFrames(stations, 'middle');
  const builders = { concrete: new GeoBuilder(), steel: new GeoBuilder(), asphalt: new GeoBuilder(true),
    parapet: new GeoBuilder(), metal: new GeoBuilder(), lens: new GeoBuilder(), pylon: new GeoBuilder() };
  const statistics = { pylons: spans.length, stays: 0, piers: 0, streetlights: 0, triangles: 0, meshes: 0 };

  const joints = [primary[0].s, ...spans.flatMap(span => [span.startM, span.endM]), primary.at(-1).s];
  const pier = (frames, s, depth) => {
    if (s < frames[0].s || s > frames.at(-1).s) return;
    const frame = sectionAt(frames, s);
    addPier(builders.concrete, frame, frame.y - depth + 0.025, approach);
    statistics.piers++;
  };
  for (let i = 1; i < joints.length; i += 2) {
    const start = joints[i - 1], end = joints[i];
    for (const frames of [primary, opposite]) {
      deckGirder(builders.concrete, frames.filter(frame => start <= frame.s && frame.s <= end),
        approach.deckWidthM, approach.girderDepthM);
      const first = Math.max(start, frames[0].s), last = Math.min(end, frames.at(-1).s);
      const count = Math.ceil((last - first) / approach.typicalPierSpacingM);
      for (let j = 1; j < count; j++) pier(frames, lerp(first, last, j / count), approach.girderDepthM);
      if (first === frames[0].s) pier(frames, first, approach.girderDepthM);
      if (last === frames.at(-1).s) pier(frames, last, approach.girderDepthM);
    }
  }
  for (const span of spans) {
    const frames = middle.filter(frame => span.startM <= frame.s && frame.s <= span.endM);
    deckGirder(builders.steel, frames, span.deckWidthM, span.girderDepthM, true);
    for (const s of span.supportStationsM) {
      if (s === span.tower.stationM) continue;
      for (const carriageway of [primary, opposite]) pier(carriageway, s, span.girderDepthM);
    }
    addPylon(builders.concrete, builders.pylon, builders.metal, span, middle);
    statistics.stays += span.stayPairs * 2;
  }
  for (const [frames, other] of [[primary, opposite], [opposite, primary]]) {
    addRoadway(builders.asphalt, frames, approach.deckWidthM);
    addParapets(builders.parapet, frames, approach.deckWidthM);
    statistics.streetlights += addStreetlights(builders.metal, builders.lens, frames, other, lighting, approach.deckWidthM);
  }

  const materials = bridgeMaterials();
  const group = new THREE.Group();
  group.name = bridge.id;
  group.userData.source = bridge.source;
  const meshes = Object.entries(builders).map(([name, builder]) => {
    const mesh = new THREE.Mesh(builder.build(), materials[name]);
    mesh.name = `${bridge.id}:${name}`;
    group.add(mesh);
    statistics.triangles += mesh.geometry.index.count / 3;
    return mesh;
  });
  statistics.meshes = meshes.length;
  scene.add(group);
  // 远景阶段只挂场景。将来如开放通行，查询直接读取这些世界坐标渲染缓冲。
  const collisionGeometry = meshes.map(mesh => mesh.geometry);
  return {
    group, meshes, collisionGeometry, statistics,
    dispose() {
      group.removeFromParent();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
  };
}

// 沿江主线按 OSM 双幅分别成形，跨海段只挂远景几何。
export function buildYanjiangExpressway(scene, expressway, replacedWays = new Set()) {
  if (!expressway) return null;
  const concrete = new GeoBuilder();
  const pavement = new GeoBuilder();
  for (const { osmWayId, stations, widthM } of expressway.segments) {
    if (replacedWays.has(osmWayId)) continue;
    const frames = bridgeFrames(stations, 'primary');
    deckGirder(concrete, frames, widthM, 2.35);
    addParapets(concrete, frames, widthM);
    addRoadway(pavement, frames, widthM);
    const length = frames.at(-1).s;
    const intervals = Math.ceil(length / expressway.pierSpacingM);
    for (let i = 0; i < intervals; i++) {
      const frame = sectionAt(frames, length * (i + 0.5) / intervals);
      addPier(concrete, frame, frame.y - 2.3, { pierWidthM: 3.8, pierDepthM: 2.7 });
    }
  }
  const group = new THREE.Group();
  group.name = 'yanjiang-expressway';
  group.userData.source = expressway.source;
  for (const [name, builder, color] of [['concrete', concrete, 0xb3bbb8], ['pavement', pavement, 0x3d4345]]) {
    const material = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.92 });
    const mesh = new THREE.Mesh(builder.build(), material);
    mesh.name = `${group.name}:${name}`;
    group.add(mesh);
  }
  scene.add(group);
  return group;
}
