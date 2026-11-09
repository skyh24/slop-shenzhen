import * as THREE from 'three/webgpu';
import { convexHull, polygonContains } from '../building-collision.js';
import { terrainHeight } from '../sz-terrain.js';
import { baseAt, loftPart, point, roofPanelPart } from './parts.js';

const SITE = 'way/1441599159';

// MAD 首层图按 1500 像素宽取样，60 米标尺约 163 像素。长轴沿源地块旋转矩形的北偏东 15.12°。
const PLAN_ORIGIN = [705, 399];
const METRES_PER_PIXEL = 60 / 163;
const PLAN_ANGLE = 15.12 * Math.PI / 180;
const PLAN_SIN = Math.sin(PLAN_ANGLE);
const PLAN_COS = Math.cos(PLAN_ANGLE);
const ROOF_MAP = { minU: 105, minV: 178, width: 1165, height: 605, columns: 512, rows: 266 };

// 根据已配准的屋顶平面取主要环线和支路，局部宽度与控制点为图面近似。
const ROOF_PATHS = [
  [3.4, [[161, 274], [210, 286], [252, 334], [310, 343], [342, 312], [395, 281], [454, 257], [522, 259], [574, 286], [625, 302]]],
  [2.6, [[285, 340], [274, 400], [288, 447], [329, 477], [365, 507], [424, 535], [480, 531], [504, 496]]],
  [3.1, [[373, 343], [402, 334], [449, 340], [477, 368], [494, 412], [478, 459], [431, 474], [393, 455], [368, 413], [366, 369], [373, 343]]],
  [3.5, [[604, 252], [654, 228], [686, 230], [729, 265], [784, 282], [851, 261], [937, 259], [1031, 259], [1109, 279], [1162, 314]]],
  [2.8, [[1162, 314], [1192, 368], [1178, 446], [1137, 480], [1074, 511], [1037, 545], [983, 546], [943, 528]]],
  [3.3, [[814, 325], [866, 317], [929, 330], [982, 345], [1026, 384], [1044, 433], [1032, 471], [990, 494], [939, 499], [889, 472], [850, 435], [818, 404]]],
  [2.7, [[744, 503], [784, 524], [835, 540], [865, 574], [920, 599], [996, 593], [1039, 563], [1090, 553], [1143, 569], [1198, 620]]]
];

// 体量中心取配准平面，尺寸及偏心由剖面比例尺、轴测和建成照片派生。
const STONES = [
  { id: 'south-outlying', source: 'way/1441599158', base: 2.4, top: 15.8, profile: 'low', drift: [2, -1] },
  { id: 'south-dome', source: 'way/1441599154', base: 3.1, top: 27.5, profile: 'dome', drift: [-7, -11] },
  { id: 'south-cap', plan: [510, 371], radii: [11.8, 8.4], rotation: 0.6, base: 23.5, top: 32.5, profile: 'pebble', drift: [1.8, -1] },
  { id: 'south-connector', plan: [489, 430], radii: [7.4, 11.3], rotation: -0.18, base: 1.5, top: 16.2, profile: 'pebble', drift: [5, -7] },
  { id: 'south-low-east', plan: [441, 507], radii: [8.3, 6.2], rotation: 0.55, base: 1.1, top: 8.7, profile: 'low', drift: [-0.9, -2.0] },
  { id: 'north-monolith', source: 'way/1441599156', base: 0, top: 52.1, profile: 'tall', drift: [-16, -7], skylight: true },
  { id: 'north-leaning', source: 'way/1441599157', base: 2.1, top: 28.1, profile: 'leaning', drift: [24, -3], offset: [-11, 1.3] },
  { id: 'north-foot', plan: [862, 536], radii: [7.2, 5.5], rotation: 0.31, base: 0.7, top: 7.4, profile: 'low', drift: [0.2, -1] },
  { id: 'north-outlying', source: 'way/1441599155', base: 2.5, top: 18.4, profile: 'low', drift: [-1.6, -1.1] }
];
export const sourceIds = [SITE, ...STONES.flatMap(stone => stone.source ? [stone.source] : [])];

function centroid(ring) {
  let area2 = 0, x = 0, z = 0;
  const o = ring[0];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const px = p.x - o.x, pz = p.z - o.z, qx = q.x - o.x, qz = q.z - o.z;
    const cross = px * qz - qx * pz;
    area2 += cross;
    x += (px + qx) * cross;
    z += (pz + qz) * cross;
  }
  if (Math.abs(area2) < 1) throw new Error(`Invalid cultural square outline: ${SITE}`);
  return point(o.x + x / (3 * area2), o.z + z / (3 * area2));
}

function siteFrame(source) {
  const anchor = centroid(source.polygons[0].outer);
  function project(u, v) {
    return point(anchor.x + u * PLAN_SIN + v * PLAN_COS, anchor.z - u * PLAN_COS + v * PLAN_SIN);
  }
  function locate([u, v]) {
    return [(u - PLAN_ORIGIN[0]) * METRES_PER_PIXEL, (v - PLAN_ORIGIN[1]) * METRES_PER_PIXEL];
  }
  function roofUv(p) {
    const x = p.x - anchor.x, z = p.z - anchor.z;
    const u = PLAN_ORIGIN[0] + (x * PLAN_SIN - z * PLAN_COS) / METRES_PER_PIXEL;
    const v = PLAN_ORIGIN[1] + (x * PLAN_COS + z * PLAN_SIN) / METRES_PER_PIXEL;
    return [(u - ROOF_MAP.minU) / ROOF_MAP.width, (v - ROOF_MAP.minV) / ROOF_MAP.height];
  }
  return { project, locate, roofUv };
}

function radiusProfile(profile, h) {
  let radius;
  switch (profile) {
    case 'tall': radius = Math.sqrt(1 - h ** 3.8) * (0.78 + 0.21 * Math.sin(h * Math.PI * 0.79)); break;
    case 'dome': radius = Math.sqrt(1 - h ** 2.5) * (0.76 + 0.25 * Math.sin(h * Math.PI * 0.94)); break;
    case 'pebble': radius = Math.sqrt(1 - (2 * h - 1) ** 2) * 0.73 + 0.26 * (1 - h); break;
    case 'leaning': radius = Math.sqrt(1 - (2 * h - 1) ** 2) * 0.58 + 0.31 * (1 - h); break;
    case 'low': radius = (1 - h ** 1.8) ** 0.56 * (0.87 + 0.13 * Math.sin(h * Math.PI)); break;
    default: throw new Error(`Unknown cultural square stone profile: ${profile}`);
  }
  return Math.hypot(radius, 0.018);
}

function diagramOutline(stone, frame) {
  const [x, z] = frame.locate(stone.plan);
  const sin = Math.sin(stone.rotation), cos = Math.cos(stone.rotation);
  return Array.from({ length: 36 }, (_, i) => {
    const a = i * Math.PI / 18;
    const radius = 1 + 0.06 * Math.cos(a * 3 + stone.rotation);
    const u = Math.cos(a) * radius * stone.radii[0];
    const v = Math.sin(a) * radius * stone.radii[1];
    return frame.project(x + u * cos - v * sin, z + u * sin + v * cos);
  });
}

function roundedHull(ring) {
  return ring.flatMap((p, i) => {
    const next = ring[(i + 1) % ring.length];
    return [0.16, 0.84].map(t => point(p.x + (next.x - p.x) * t, p.z + (next.z - p.z) * t));
  });
}

function skinCoordinates(outline, center) {
  const distances = [0];
  let waterSide = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i], q = outline[(i + 1) % outline.length];
    distances.push(distances[i] + Math.hypot(q.x - p.x, q.z - p.z));
    const towardLake = (p.x - center.x) * PLAN_COS + (p.z - center.z) * PLAN_SIN;
    const best = outline[waterSide];
    if (towardLake > (best.x - center.x) * PLAN_COS + (best.z - center.z) * PLAN_SIN) waterSide = i;
  }
  const perimeter = distances.at(-1);
  const shift = 0.5 - distances[waterSide] / perimeter;
  return distances.map(distance => distance / perimeter + shift);
}

function surfaceNormals(rings) {
  return rings.map(({ ring }, i) => {
    const a = rings[Math.max(0, i - 1)], b = rings[Math.min(rings.length - 1, i + 1)];
    return ring.map((_, j) => {
      const prev = ring[(j - 1 + ring.length) % ring.length], next = ring[(j + 1) % ring.length];
      const around = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z);
      const rise = new THREE.Vector3(b.ring[j].x - a.ring[j].x, b.y - a.y, b.ring[j].z - a.ring[j].z);
      return rise.cross(around).normalize();
    });
  });
}

function stoneParts(source, site, frame, base, stone) {
  const footprint = stone.source ? convexHull(source.polygons[0].outer) : diagramOutline(stone, frame);
  const outline = stone.source ? roundedHull(footprint) : footprint;
  const center = centroid(footprint);
  const [offsetU, offsetV] = stone.offset ?? [0, 0];
  const drift = (u, v) => point(u * PLAN_SIN + v * PLAN_COS, -u * PLAN_COS + v * PLAN_SIN);
  const ringSteps = stone.source ? 22 : 14;
  const rings = Array.from({ length: ringSteps + 1 }, (_, i) => {
    const t = (1 - Math.cos(Math.PI * i / ringSteps)) / 2;
    const radius = radiusProfile(stone.profile, t);
    const lean = t * t * (3 - 2 * t);
    const offset = drift(offsetU + stone.drift[0] * lean, offsetV + stone.drift[1] * lean);
    return { t, y: base + stone.base + (stone.top - stone.base) * t,
      ring: outline.map(p => point(center.x + (p.x - center.x) * radius + offset.x,
        center.z + (p.z - center.z) * radius + offset.z)) };
  });
  const u = skinCoordinates(outline, center);
  const normals = surfaceNormals(rings);
  const style = stone.skylight ? 'cultureMonolith' : 'cultureGranite';
  return rings.slice(0, -1).map(({ t, y, ring }, i) => {
    const next = rings[i + 1];
    const part = loftPart(`${source.id}:${stone.id}:${i}`, source, ring, next.ring, y, next.y, style,
      { smoothSides: true, baseSourceId: site.id });
    return { ...part, loftSkin: { u, v: [t, next.t], lower: normals[i], upper: normals[i + 1], bottom: i === 0, top: i === ringSteps - 1 } };
  });
}

function squaredDistanceToEdge(p, a, b) {
  const x = b.x - a.x, z = b.z - a.z;
  const length2 = x * x + z * z;
  const t = length2 ? Math.min(1, Math.max(0, ((p.x - a.x) * x + (p.z - a.z) * z) / length2)) : 0;
  return (p.x - a.x - x * t) ** 2 + (p.z - a.z - z * t) ** 2;
}

export function createCulturePavingMask() {
  const { columns, rows, minU, minV, width, height } = ROOF_MAP;
  const pixels = new Uint8Array(columns * rows);
  const texel = Math.max(width / columns, height / rows);
  for (const [metres, controls] of ROOF_PATHS) {
    const path = new THREE.SplineCurve(controls.map(([u, v]) => new THREE.Vector2(u, v)))
      .getPoints((controls.length - 1) * 6).map(p => point(p.x, p.y));
    const radius = metres / (2 * METRES_PER_PIXEL);
    const margin = radius + texel;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - margin - minU) * columns / width));
      const x1 = Math.min(columns - 1, Math.ceil((Math.max(a.x, b.x) + margin - minU) * columns / width));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - margin - minV) * rows / height));
      const z1 = Math.min(rows - 1, Math.ceil((Math.max(a.z, b.z) + margin - minV) * rows / height));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const p = point(minU + (x + 0.5) * width / columns, minV + (z + 0.5) * height / rows);
        const coverage = Math.max(0, Math.min(1, 0.5 + (radius - Math.sqrt(squaredDistanceToEdge(p, a, b))) / texel));
        const index = z * columns + x;
        pixels[index] = Math.max(pixels[index], Math.round(coverage * 255));
      }
    }
  }
  const texture = new THREE.DataTexture(pixels, columns, rows, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function parkSkin(panels, frame, boundary) {
  const normals = new Map();
  const vertexKey = p => `${p.x}:${p.z}`;
  for (const { roofPanel: { outer, top } } of panels) {
    const [a, b, c] = outer;
    const ab = new THREE.Vector3(b.x - a.x, top[1] - top[0], b.z - a.z);
    const ac = new THREE.Vector3(c.x - a.x, top[2] - top[0], c.z - a.z);
    const normal = ac.cross(ab);
    for (const p of outer) {
      const key = vertexKey(p);
      if (!normals.has(key)) normals.set(key, new THREE.Vector3());
      normals.get(key).add(normal);
    }
  }
  for (const normal of normals.values()) normal.normalize();
  return panels.map(part => {
    const ring = part.roofPanel.outer;
    const walls = ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      // 只绘制外缘和庭院边墙。共边薄板内侧的重叠面会产生暗线。
      return boundary.some(([a, b]) => squaredDistanceToEdge(p, a, b) < 4e-6 && squaredDistanceToEdge(q, a, b) < 4e-6);
    });
    return { ...part, roofSkin: { uv: ring.map(frame.roofUv), normals: ring.map(p => normals.get(vertexKey(p))), walls } };
  });
}

function roofPark(source, terrain, frame) {
  const shape = source.polygons[0];
  const courtyard = (plan, uRadius, vRadius) => {
    const [u, v] = frame.locate(plan);
    return Array.from({ length: 22 }, (_, i) => frame.project(u + Math.cos(i * Math.PI / 11) * uRadius,
      v + Math.sin(i * Math.PI / 11) * vRadius));
  };
  // 两处庭院按平面落位。低矮盖板沿源建筑外缘收回，外部地形和下穿道保持原数据。
  const holes = [courtyard([435, 406], 16, 17), courtyard([962, 421], 19, 22)]
    .filter(ring => ring.every(p => polygonContains(shape, p.x, p.z)));
  const rings = [shape.outer, ...shape.holes, ...holes];
  const contour = ring => ring.map(p => new THREE.Vector2(p.x, p.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour(rings[0]), rings.slice(1).map(contour));
  const vertices = rings.flat();
  const edges = rings.flatMap(ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]));
  const sampled = new Map();
  function sample(p) {
    const key = `${p.x}:${p.z}`;
    if (sampled.has(key)) return sampled.get(key);
    const grade = terrainHeight(terrain, p.x, p.z);
    if (grade === null) throw new Error(`Missing cultural square roof terrain: ${SITE}`);
    const distance = Math.sqrt(edges.reduce((d, [a, b]) => Math.min(d, squaredDistanceToEdge(p, a, b)), Infinity));
    const t = Math.min(1, distance / 32);
    const rise = 5.8 * t * t * (3 - 2 * t);
    const vertex = { ...p, y: grade + 0.08 + rise, depth: 0.4 + rise };
    sampled.set(key, vertex);
    return vertex;
  }
  const output = [];
  function subdivide(triangle) {
    const lengths = triangle.map((a, i) => {
      const b = triangle[(i + 1) % 3];
      return Math.hypot(a.x - b.x, a.z - b.z);
    });
    const span = Math.max(...lengths);
    if (span > 29) {
      const longest = lengths.indexOf(span);
      const a = triangle[longest], b = triangle[(longest + 1) % 3], c = triangle[(longest + 2) % 3];
      const m = point((a.x + b.x) / 2, (a.z + b.z) / 2);
      subdivide([a, m, c]);
      subdivide([m, b, c]);
      return;
    }
    const tri = triangle.map(sample);
    output.push(roofPanelPart(`${source.id}:roof-park:${output.length}`, source, tri, tri.map(p => p.depth), 'culturePark',
      { baseSource: 'dem-roof-point-samples' }));
  }
  for (const [a, b, c] of faces) subdivide([vertices[a], vertices[b], vertices[c]]);
  return parkSkin(output, frame, edges);
}

export function build(buildings, terrain) {
  const source = buildings.get(SITE);
  const frame = siteFrame(source);
  const base = baseAt(source, terrain);
  return [...roofPark(source, terrain, frame), ...STONES.flatMap(stone =>
    stoneParts(stone.source ? buildings.get(stone.source) : source, source, frame, base, stone))];
}
