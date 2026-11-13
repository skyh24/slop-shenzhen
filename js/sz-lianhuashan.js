import * as THREE from 'three/webgpu';
import { color, fract, mix, positionWorld } from 'three/tsl';
import source from '../data/source/lianhuashan-summit.json' with { type: 'json' };
import { createPavingMaterial } from './sz-paving.js';
import { polygonContainsInclusive, distanceToRing } from './sz-polygon.js';
import { partCollider, footprintParts } from './sz-landmarks/parts.js';
import { renderLandmark } from './sz-landmarks/render.js';
import { STR } from './sz-strings.js';

export const SUMMIT_DECK_Y = Math.fround(111.2);
export const SUMMIT_SURFACE_ID = 'lianhuashan-summit:plaza:0';
// 铜像 node/1722037599 及观景点 node/2750494256，投影到项目米制坐标。
const STATUE = { x: -18.00, z: -1068.40 };
export const SUMMIT_ARRIVAL = Object.freeze({ x: -18.55, z: -1028.8, y: SUMMIT_DECK_Y, heading: 0,
  surfaceId: SUMMIT_SURFACE_ID });

const points = rows => rows.map(([x, z]) => ({ x, z }));
const rim = points([
  [-49.79, -1056.84], [-49.19, -1050.1], [-47.66, -1044.92], [-45.64, -1040.72],
  [-42.62, -1036.37], [-38, -1031.85], [-34.19, -1029.26], [-27.84, -1026.47],
  [-21.47, -1025.18], [-12.79, -1025.54], [-5.55, -1027.77], [-0.38, -1030.7],
  [4.58, -1034.99], [7.6, -1038.79], [10.73, -1044.64], [12.35, -1050.09], [12.96, -1055.31]
]);
// 南边沿已核广场弧线，北段接至后广场。中段宽度为照片及两侧步道约束下的估计。
const plaza = { outer: [...rim, ...points([
  [12.07, -1064], [1.57, -1082.52], [1.57, -1096.3], [-38.55, -1095.81],
  [-38.48, -1082.16], [-49.3, -1061.73]
])], holes: [] };
const approaches = [
  { id: 'way/386491514', width: 2.6, route: points([[-49.79, -1056.84], [-57.5, -1060.18],
    [-65.89, -1047.29], [-64.35, -1031.69], [-57.49, -1014.2]]) },
  { id: 'way/488708059', width: 2.7, route: points([[12.96, -1055.31], [19.64, -1074.79],
    [22.63, -1081.15], [30.92, -1076.6], [33.82, -1066.55], [37.88, -1050.98]]) }
];

function rect(x, z, width, depth) {
  return { outer: points([[x - width / 2, z - depth / 2], [x + width / 2, z - depth / 2],
    [x + width / 2, z + depth / 2], [x - width / 2, z + depth / 2]]), holes: [] };
}

function strip(a, b, width) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const x = (b.z - a.z) / length * width / 2, z = (a.x - b.x) / length * width / 2;
  return { outer: points([[a.x - x, a.z - z], [b.x - x, b.z - z],
    [b.x + x, b.z + z], [a.x + x, a.z + z]]), holes: [] };
}

export function reviewedParkOmissions(park, buildings) {
  if (park?.osmId !== source.parkId) return new Set();
  const area = park.areas.find(entry => entry.osmId === source.parkId);
  if (!area) return new Set();
  const reviewed = new Set(source.displayReview.omit);
  return new Set(buildings.filter(building => reviewed.has(building.id)
    && building.polygons.every(polygon => polygon.outer.every(p =>
      polygonContainsInclusive(area.polygon, p.x, p.z)))).map(building => building.id));
}

function makeTreads(approach, groundHeight) {
  const { route, width } = approach;
  const stations = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const count = Math.ceil(length / 0.64);
    if (i === 1) {
      // 第一踏伸入平台，桥接栏杆端部与步道中心线的小角度差。
      stations.push({ x: a.x - (b.x - a.x) / length * 1.5, z: a.z - (b.z - a.z) / length * 1.5 });
    }
    for (let j = 0; j < count; j++) {
      // 拐角留下较长踏面，斜接内角不会越过相邻短踏步。
      if (j > 0 && ((i > 1 && j * length / count < 1.7)
        || (i < route.length - 1 && (count - j) * length / count < 1.7))) continue;
      stations.push({ x: a.x + (b.x - a.x) * j / count, z: a.z + (b.z - a.z) * j / count });
    }
  }
  stations.push(route.at(-1));
  const offset = (a, b) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: (b.z - a.z) / length, z: (a.x - b.x) / length };
  };
  const edges = stations.map((point, i) => {
    const left = i > 0 ? offset(stations[i - 1], point) : offset(point, stations[i + 1]);
    const right = i + 1 < stations.length ? offset(point, stations[i + 1]) : left;
    const scale = width / 2 / Math.max(0.65, 1 + left.x * right.x + left.z * right.z);
    const x = (left.x + right.x) * scale, z = (left.z + right.z) * scale;
    return [{ x: point.x - x, z: point.z - z }, { x: point.x + x, z: point.z + z }];
  });
  const treads = edges.slice(1).map(([left, right], i) => {
    const polygon = { outer: [edges[i][0], left, right, edges[i][1]], holes: [] };
    const a = stations[i], b = stations[i + 1];
    const samples = [...polygon.outer, a, b, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }]
      .map(p => groundHeight(p.x, p.z)).filter(Number.isFinite);
    if (!samples.length) throw new Error(`Missing terrain for summit steps: ${approach.id}`);
    return { polygon, ground: Math.max(...samples), bottom: Math.min(...samples) - 0.24 };
  });
  // 各级踏步共享斜接边；用原地形包络选出展示标高，踏步高差不超过0.18米。
  const ends = treads.map((step, i) => Math.max(step.ground + 0.07, SUMMIT_DECK_Y - 0.18 * i));
  for (let i = ends.length - 2; i >= 0; i--) ends[i] = Math.max(ends[i], ends[i + 1] - 0.18);
  for (let i = 1; i < ends.length; i++) ends[i] = Math.max(ends[i], ends[i - 1] - 0.18);
  return treads.map(({ polygon, bottom }, i) => ({ polygon, bottom, top: Math.min(SUMMIT_DECK_Y, ends[i]) }));
}

function makeSculpture(group, y) {
  const bodies = [[], []];
  const shell = (profile, crease = 0, relief = false) => bodies[Number(relief)].push({ profile, crease });
  // 各截面依次为中心 x、标高、中心 z、左右半径、前后半径。衣褶起伏保留前襟和背部轮廓。
  shell([[0.34, 0, 0.92, 0.24, 0.41], [0.34, 0.15, 0.93, 0.28, 0.50],
    [0.34, 0.29, 0.77, 0.24, 0.30], [0.34, 0.43, 0.62, 0.20, 0.23],
    [0.35, 0.96, 0.58, 0.22, 0.22], [0.36, 1.47, 0.51, 0.26, 0.26],
    [0.37, 1.88, 0.43, 0.29, 0.29], [0.34, 2.25, 0.34, 0.29, 0.31],
    [0.29, 2.83, 0.07, 0.35, 0.36], [0.27, 3.15, 0, 0.22, 0.24]], 0.055);
  shell([[-0.37, 0, -0.68, 0.22, 0.35], [-0.37, 0.17, -0.68, 0.25, 0.43],
    [-0.38, 0.33, -0.63, 0.22, 0.30], [-0.4, 0.63, -0.63, 0.22, 0.23],
    [-0.41, 1.15, -0.56, 0.25, 0.25], [-0.42, 1.62, -0.49, 0.27, 0.27],
    [-0.4, 2.01, -0.45, 0.3, 0.28], [-0.35, 2.4, -0.23, 0.34, 0.32],
    [-0.3, 2.87, -0.06, 0.36, 0.39], [-0.29, 3.15, 0, 0.22, 0.24]], 0.065);
  shell([[0, 2.52, -0.13, 0.58, 0.37], [0, 2.7, -0.08, 0.68, 0.43],
    [0, 3.25, 0, 0.70, 0.47], [0, 3.64, 0.06, 0.72, 0.47],
    [0, 4.05, 0.10, 0.77, 0.47], [0, 4.48, 0.13, 0.85, 0.43],
    [0, 4.72, 0.14, 0.80, 0.39], [0, 4.87, 0.16, 0.62, 0.35],
    [0, 5.02, 0.19, 0.28, 0.28]], 0.04);
  for (const side of [-1, 1]) {
    const leading = side < 0;
    shell([[side * 0.55, leading ? 1.93 : 1.76, leading ? -0.34 : -0.60, 0.24, 0.31],
      [side * 0.54, 2.05, -0.40, 0.29, 0.34], [side * 0.52, 2.37, -0.27, 0.34, 0.41],
      [side * 0.46, 2.79, -0.13, 0.36, 0.46], [side * 0.40, 3.25, -0.02, 0.37, 0.48]], 0.13);
    const wrist = leading ? 0.50 : -0.34;
    shell([[side * 0.84, 2.86, wrist, 0.10, 0.10], [side * 0.85, 3.0, wrist, 0.14, 0.15],
      [side * 0.87, 3.18, wrist, 0.15, 0.14], [side * 0.88, 3.29, wrist, 0.19, 0.19],
      [side * 0.9, 3.48, leading ? 0.37 : -0.28, 0.22, 0.22],
      [side * 0.92, 3.76, leading ? 0.29 : -0.19, 0.25, 0.24],
      [side * 0.89, 4.10, 0.05, 0.27, 0.27], [side * 0.82, 4.44, 0.1, 0.28, 0.29],
      [side * 0.70, 4.72, 0.13, 0.19, 0.24]], 0.08);
    shell([[side * 0.12, 3.61, 0.49, 0.05, 0.07], [side * 0.21, 3.96, 0.54, 0.10, 0.08],
      [side * 0.35, 4.42, 0.53, 0.12, 0.08], [side * 0.30, 4.67, 0.47, 0.13, 0.08],
      [side * 0.22, 4.83, 0.43, 0.08, 0.06]], 0.04, true);
    shell([[side * 0.35, 5.37, 0.18, 0.06, 0.066], [side * 0.395, 5.48, 0.16, 0.07, 0.08],
      [side * 0.37, 5.57, 0.19, 0.05, 0.06]], 0, true);
    shell([[side * 0.145, 5.55, 0.53, 0.10, 0.02], [side * 0.145, 5.60, 0.535, 0.12, 0.05],
      [side * 0.15, 5.64, 0.52, 0.08, 0.036]], 0, true);
  }
  shell([[0, 4.82, 0.2, 0.25, 0.24], [0, 5.03, 0.22, 0.25, 0.23],
    [0, 5.13, 0.27, 0.26, 0.24], [0, 5.24, 0.29, 0.30, 0.28],
    [0, 5.40, 0.23, 0.36, 0.34], [0, 5.53, 0.22, 0.39, 0.33],
    [0, 5.68, 0.20, 0.40, 0.36], [0, 5.84, 0.17, 0.36, 0.33],
    [0, 5.95, 0.14, 0.26, 0.26], [0, 6, 0.13, 0.014, 0.014]]);
  shell([[0, 5.39, 0.54, 0.065, 0.066], [0, 5.46, 0.56, 0.093, 0.125],
    [0, 5.55, 0.52, 0.072, 0.10], [0, 5.63, 0.51, 0.04, 0.052]], 0, true);
  shell([[0, 5.30, 0.545, 0.085, 0.030], [0, 5.33, 0.57, 0.13, 0.035],
    [0, 5.36, 0.55, 0.105, 0.028]], 0, true);

  const sides = 28;
  for (const [i, profiles] of bodies.entries()) {
    const vertices = [], faces = [];
    for (const { profile, crease } of profiles) {
      const start = vertices.length / 3;
      for (const [x, dy, z, rx, rz] of profile) {
        for (let j = 0; j < sides; j++) {
          const a = j / sides * Math.PI * 2;
          const fold = 1 + crease * (Math.sin(a * 6 + dy * 1.4) + Math.sin(a * 11 - dy) * 0.31);
          vertices.push(STATUE.x + x + rx * fold * Math.cos(a), y + dy, STATUE.z + z + rz * fold * Math.sin(a));
        }
      }
      for (let j = 0; j < sides; j++) {
        const next = (j + 1) % sides;
        for (let k = 1; k < profile.length; k++) {
          const lower = start + (k - 1) * sides, upper = lower + sides;
          faces.push(lower + j, upper + j, lower + next, lower + next, upper + j, upper + next);
        }
        if (j > 1) {
          const end = start + (profile.length - 1) * sides;
          faces.push(start, start + j - 1, start + j, end, end + j, end + j - 1);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(faces);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ color: i === 0 ? 0x51483e : 0x625347,
      roughness: 0.54, metalness: 0.54, emissive: 0x2e2925, emissiveIntensity: 0.16 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'lianhuashan-summit:bronze';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function addCypressCrowns(group, grove) {
  const pieces = [];
  for (const [x, z, height, spread] of grove) {
    for (let tier = 0; tier < 7; tier++) {
      const fraction = tier / 7;
      const radius = spread * (1 - fraction * 0.88);
      const angle = x * 0.8 + tier * 2.4;
      const y = SUMMIT_DECK_Y + height * (0.29 + fraction * 0.72);
      pieces.push([x, y, z, radius, height * (0.20 - fraction * 0.07), radius, angle]);
      pieces.push([x + Math.cos(angle) * radius * 0.52, y - 0.22, z + Math.sin(angle) * radius * 0.52,
        radius * 0.61, height * 0.125, radius * 0.56, angle + 0.7]);
    }
  }
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.96 });
  const grain = fract(positionWorld.y.mul(17.4).add(positionWorld.x.mul(19.6)).sin().mul(416.13));
  material.colorNode = mix(color(0x64783d), color(0xc0c586), grain.mul(0.65));
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), material, pieces.length);
  const pose = new THREE.Object3D();
  const tint = new THREE.Color();
  pieces.forEach(([x, y, z, sx, sy, sz, angle], i) => {
    pose.position.set(x, y, z);
    pose.rotation.set(0.07 * Math.sin(i), angle, 0.07 * Math.cos(i));
    pose.scale.set(sx, sy, sz);
    pose.updateMatrix();
    crowns.setMatrixAt(i, pose.matrix);
    tint.setHSL(0.25 + (i % 5) * 0.008, 0.22, 0.48 + (i % 7) * 0.025);
    crowns.setColorAt(i, tint);
  });
  crowns.name = 'lianhuashan-summit:cypress';
  crowns.instanceMatrix.needsUpdate = true;
  crowns.instanceColor.needsUpdate = true;
  crowns.computeBoundingSphere();
  crowns.castShadow = true;
  crowns.receiveShadow = true;
  group.add(crowns);
}

function plinthInscription(group, y, z) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 104;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#a37738';
  ctx.font = '600 65px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(STR.program.statue, 256, 54);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardNodeMaterial({ map, transparent: true, depthWrite: false, roughness: 0.75 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.35, 0.68), material);
  mesh.position.set(STATUE.x, y, z);
  group.add(mesh);
}

export function buildLianhuashanSummit(scene, groundHeight, park, style) {
  if (park?.osmId !== source.parkId) return { group: null, surfaces: [], colliders: [], pathAt: () => [] };
  const parts = [];
  const colliders = [];
  const walk = [];
  function solid(id, sourceId, polygon, bottom, top, style, { contact = false } = {}) {
    const [part] = footprintParts({ id: sourceId, polygons: [polygon], heightSource: 'estimate' }, 0, style,
      { id: `lianhuashan-summit:${id}`, min: bottom, max: top, roofContact: contact, derived: true });
    parts.push(part);
    colliders.push(partCollider(part));
    if (contact) walk.push({ polygon, id: part.id });
  }

  solid('plaza', 'way/269925476', plaza, 97, SUMMIT_DECK_Y, 'paving', { contact: true });
  for (const approach of approaches) {
    makeTreads(approach, groundHeight).forEach(({ polygon, bottom, top }, i) =>
      solid(`${approach.id}:tread:${i}`, approach.id, polygon, bottom, top, 'paving',
        { contact: true }));
  }

  for (let i = 2; i < rim.length - 1; i++) {
    const a = rim[i - 1], b = rim[i];
    const inset = p => ({ x: p.x * 0.98 + STATUE.x * 0.02, z: p.z * 0.98 - 1049 * 0.02 });
    const from = inset(a), to = inset(b);
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const count = Math.ceil(length / 2);
    solid(`rail:${i}:coping`, 'way/269925476', strip(from, to, 0.30), SUMMIT_DECK_Y + 0.87, SUMMIT_DECK_Y + 1.03, 'rail');
    solid(`rail:${i}:sill`, 'way/269925476', strip(from, to, 0.38), SUMMIT_DECK_Y, SUMMIT_DECK_Y + 0.23, 'rail');
    for (let j = 0; j < count; j++) {
      const x = from.x + (to.x - from.x) * j / count, z = from.z + (to.z - from.z) * j / count;
      solid(`rail:${i}:post:${j}`, 'way/269925476', rect(x, z, 0.24, 0.24),
        SUMMIT_DECK_Y + 0.22, SUMMIT_DECK_Y + 0.9, 'rail');
      const mid = (j + 0.5) / count;
      solid(`rail:${i}:panel:${j}`, 'way/269925476',
        rect(from.x + (to.x - from.x) * mid, from.z + (to.z - from.z) * mid, 0.16, 0.16),
        SUMMIT_DECK_Y + 0.23, SUMMIT_DECK_Y + 0.88, 'rail');
    }
  }

  // 照片中的龙柏背景按组估计树位，留出后广场通道和两侧山径。
  const grove = [[-41.6, -1074.4, 8.2, 2.8], [-38, -1078.5, 9.1, 3.1],
    [-34.2, -1080.8, 9.8, 2.9], [-29.5, -1081, 10.1, 2.7], [-24.3, -1083.5, 9.7, 3.2],
    [-19.6, -1082.3, 11.2, 3.3], [-14, -1082.5, 10.1, 3.1], [-9.2, -1081.7, 8.9, 3.1],
    [-4.3, -1080.5, 10.6, 3.2], [0.6, -1077.1, 9.4, 2.7], [4.7, -1073, 7.7, 2.8]];
  for (const [i, [x, z, height]] of grove.entries()) {
    solid(`cypress:${i}`, source.statue.id, rect(x, z, 0.33, 0.33),
      SUMMIT_DECK_Y, SUMMIT_DECK_Y + height * 0.27, 'bark');
  }

  const base = SUMMIT_DECK_Y + 0.17;
  solid('statue-apron', source.statue.id, rect(STATUE.x, STATUE.z, 13.4, 10.8), SUMMIT_DECK_Y, base,
    'border', { contact: true });
  solid('plinth-base', source.statue.id, rect(STATUE.x, STATUE.z, 5.0, 4.1), base, base + 0.24, 'granite');
  solid('plinth', source.statue.id, rect(STATUE.x, STATUE.z, 4.8, 3.9), base + 0.24, base + 3.57, 'granite');
  solid('plinth-cap', source.statue.id, rect(STATUE.x, STATUE.z, 4.9, 4.0), base + 3.57, base + 3.68, 'granite');
  solid('inscription-wall', source.statue.id, rect(STATUE.x, STATUE.z - 7.8, 13, 1.1), SUMMIT_DECK_Y,
    SUMMIT_DECK_Y + 4.35, 'granite');
  const masonry = (tint, light) => new THREE.MeshStandardNodeMaterial({ color: tint, roughness: 0.91,
    emissive: tint, emissiveIntensity: light });
  const granite = masonry(0xc5b9a8, 0.085);
  const fleck = fract(positionWorld.x.mul(31.7).add(positionWorld.y.mul(49.1)).add(positionWorld.z.mul(11.7)).sin().mul(338.4));
  granite.colorNode = mix(color(0xa99987), color(0xcfc3b2), fleck);
  const defaults = { surfaceStyle: 'summit-stone' };
  const { surfaceStyle } = style?.resolve(defaults, { regionId: `osm:${park.osmId}` }) ?? defaults;
  const palette = {
    paving: createPavingMaterial(surfaceStyle), rail: masonry(0xd0c7b9, 0.055), border: masonry(0x8d6653, 0.04),
    granite, bark: masonry(0x574434, 0.02)
  };
  const result = renderLandmark({ id: 'lianhuashan-summit', parts }, name => palette[name]);
  for (const surface of result.surfaces) surface.climbableFromGround = true;
  addCypressCrowns(result.group, grove);
  makeSculpture(result.group, base + 3.68);
  plinthInscription(result.group, base + 2.05, STATUE.z + 1.956);
  scene.add(result.group);
  const paths = (x, z) => x < -69 || x > 41 || z < -1100 || z > -1010 ? []
    : walk.filter(({ polygon }) => polygonContainsInclusive(polygon, x, z)
      || distanceToRing(polygon.outer, x, z) < 1.2);
  return { ...result, colliders, pathAt: paths };
}
