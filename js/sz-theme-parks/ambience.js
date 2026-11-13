import * as THREE from 'three/webgpu';
import { length, smoothstep, uv } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { signedRingArea } from '../sz-polygon.js';
import { createRoadPolygonLayout } from '../sz-roads.js';
import { disk, parkParts, rectangle } from './parts.js';
import { EDGE_OPENINGS } from './sites.js';

const WALLS = {
  world: { width: 0.46, finish: 'perimeterSand', metal: 0x34383a },
  china: { width: 0.50, finish: 'perimeterRed', metal: 0x352e2c },
  valley: { width: 0.44, finish: 'perimeterBlue', metal: 0x304254 },
  expo: { width: 0.46, finish: 'perimeterSand', metal: 0x303d36 }
};

export const parkNight = smoothstep(0.10, 0.82, sceneUniforms.night);

export function planPerimeter(key, boundary, ground, canPlace, walkAt) {
  const id = `theme-${key}-perimeter`;
  const p = parkParts(id, ground);
  const { width, finish } = WALLS[key];
  const height = 3;
  const bays = [];
  const { outer } = boundary;
  const side = Math.sign(signedRingArea(outer));
  const normal = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const scale = side / Math.hypot(dx, dz);
    return { x: -dz * scale, z: dx * scale };
  };
  // 向园内退 1.7 米；保留外侧车行、道路边缘和入口净空。
  const inset = outer.map((b, i) => {
    const a = outer[(i + outer.length - 1) % outer.length], c = outer[(i + 1) % outer.length];
    const m = normal(a, b), n = normal(b, c);
    const scale = 1.7 / Math.max(0.55, 1 + m.x * n.x + m.z * n.z);
    return { x: b.x + (m.x + n.x) * scale, z: b.z + (m.z + n.z) * scale };
  });
  const openings = EDGE_OPENINGS[key];
  const blocked = (x, z, r) => walkAt(x, z, r + 1)
    || openings.some(([gx, gz, radius]) => (x - gx) ** 2 + (z - gz) ** 2 < (radius + r) ** 2);
  let segments = 0, lengthM = 0;
  for (let i = 0; i < inset.length; i++) {
    const a = inset[i], b = inset[(i + 1) % inset.length];
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < 0.2) continue;
    const count = Math.ceil(length / 5.5);
    const at = t => ({ x: a.x + t * dx, z: a.z + t * dz });
    const angle = Math.atan2(dz, dx);
    for (let j = 0; j < count; j++) {
      const c = at(j / count), d = at((j + 1) / count), mid = at((j + 0.5) / count);
      const span = length / count;
      if (blocked(mid.x, mid.z, span / 2 + width)) continue;
      const cy = ground(c.x, c.z), dy = ground(d.x, d.z);
      if (!Number.isFinite(cy) || !Number.isFinite(dy)) continue;
      const ring = rectangle(mid.x, mid.z, span + 0.07, width + 0.16, angle);
      const low = Math.min(cy, dy) - 0.25;
      if (!canPlace(ring, low, Math.max(cy, dy) + height, 0.35, 1.15)) continue;
      const bottom = p.limits(ring)[0] - 0.22;
      const expand = 0.035 / length;
      const start = { ...at(j / count - expand), y: cy + height };
      const end = { ...at((j + 1) / count + expand), y: dy + height };
      const depth = Math.max(start.y, end.y) - bottom;
      // 栅条净隙小于角色宽度；这一带状碰撞包络随整段格栅坡度走，不封入口。
      p.span(start, end, width, depth, finish);
      p.parts.at(-1).collisionOnly = true;
      const plinth = Math.max(cy, dy) + 0.44 - bottom;
      p.span({ ...start, y: cy + 0.44 }, { ...end, y: dy + 0.44 }, width, plinth, finish);
      bays.push({ a: c, b: d, cy, dy, length: span, angle });
      segments++;
      lengthM += span;
    }
  }
  return { id, parts: p.parts, segments, lengthM, bays };
}

export function planPathLamps(key, walks, ground, canPlace, walkAt) {
  const id = `theme-${key}-path-lamps`;
  const p = parkParts(id, ground);
  const lamps = [];
  for (const { line, halfWidth } of walks) {
    let offset = 6;
    for (let i = 1; i < line.length; i++) {
      const [x, z] = line[i - 1], [bx, bz] = line[i];
      const dx = bx - x, dz = bz - z, l = Math.hypot(dx, dz);
      for (; offset < l; offset += 18) {
        const cx = x + dx * offset / l, cz = z + dz * offset / l;
        for (const side of [lamps.length % 2 ? 1 : -1, lamps.length % 2 ? -1 : 1]) {
          const margin = (halfWidth + 0.83) * side;
          const px = cx - dz / l * margin, pz = cz + dx / l * margin;
          const y = ground(px, pz), r = 0.46;
          if (!Number.isFinite(y) || walkAt(px, pz, r) || lamps.some(a => Math.hypot(a.x - px, a.z - pz) < 7)
            || !canPlace(disk(px, pz, r, 8), y - 0.18, y + 3.35, 0.25, 1)) continue;
          const base = p.footing(disk(px, pz, 0.22, 8), 0.11, 'perimeterCap');
          p.loft(disk(px, pz, 0.084, 8), disk(px, pz, 0.055, 8), base, base + 2.72, 'lampSteel');
          p.loft(disk(px, pz, 0.17, 8), disk(px, pz, 0.27, 8), base + 2.72, base + 3.04, 'lampGlass');
          p.loft(disk(px, pz, 0.3, 8), disk(px, pz, 0.07, 8), base + 3.04, base + 3.23, 'lampSteel');
          lamps.push({ x: px, z: pz, poolX: (cx + px) / 2, poolZ: (cz + pz) / 2 });
          break;
        }
      }
      offset -= l;
    }
  }
  return { id, parts: p.parts, lamps };
}

export function createParkPoolMaterial() {
  const fade = smoothstep(0.08, 1, length(uv().mul(2).sub(1))).oneMinus();
  return new THREE.MeshBasicNodeMaterial({
    color: 0xffbd6c, opacityNode: fade.mul(fade).mul(parkNight).mul(0.46),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  });
}

export function buildPathPools(park, terrain, material) {
  const r = 4.2;
  const positions = [], uvs = [];
  for (const { poolX: x, poolZ: z } of park.lanterns.lamps) {
    const ring = disk(x, z, r, 12);
    const trianglesXZ = ring.flatMap((a, i) => {
      const b = ring[(i + 1) % ring.length];
      return [x, z, a.x, a.z, b.x, b.z];
    });
    const { chunks } = createRoadPolygonLayout({ id: park.lanterns.id, trianglesXZ, sourceIds: [park.id] }, terrain);
    for (const { positions: local, origin } of chunks) {
      for (let i = 0; i < local.length; i += 3) {
        const wx = local[i] + origin[0], wz = local[i + 2] + origin[1];
        positions.push(wx, local[i + 1] + 0.027, wz);
        uvs.push(0.5 + (wx - x) / (2 * r), 0.5 + (wz - z) / (2 * r));
      }
    }
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `theme-${park.key}-path-light-pools`;
  return mesh;
}

// 同一钢材实例批次画横档、栅条、门柱和尖饰，按空间分块剔除。
export function buildFenceMetal(group, park) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardNodeMaterial({ color: WALLS[park.key].metal, metalness: 0.22, roughness: 0.64 });
  const batches = new Map();
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), direction = new THREE.Vector3();
  const quaternion = new THREE.Quaternion(), matrix = new THREE.Matrix4();
  const axis = new THREE.Vector3(1, 0, 0);
  for (const { a, b, cy, dy, length, angle } of park.perimeter.bays) {
    const key = `${Math.floor(a.x / 130)},${Math.floor(a.z / 130)}`;
    let matrices = batches.get(key);
    if (!matrices) batches.set(key, matrices = []);
    const groundY = t => cy + t * (dy - cy);
    const place = (t, h, w, tall, d, tilt = 0) => {
      position.set(a.x + (b.x - a.x) * t, groundY(t) + h, a.z + (b.z - a.z) * t);
      quaternion.setFromEuler(new THREE.Euler(0, -angle, tilt));
      matrices.push(matrix.compose(position, quaternion, scale.set(w, tall, d)).clone());
    };
    for (const h of [0.59, 1.04, 2.43, 2.67]) {
      direction.set(b.x - a.x, dy - cy, b.z - a.z);
      quaternion.setFromUnitVectors(axis, direction.clone().normalize());
      matrices.push(matrix.compose(position.set((a.x + b.x) / 2, (cy + dy) / 2 + h, (a.z + b.z) / 2),
        quaternion, scale.set(direction.length() + 0.08, h === 2.67 ? 0.105 : 0.078, 0.094)).clone());
    }
    for (const end of [0.012, 0.988]) {
      place(end, 1.61, 0.21, 2.45, 0.21);
      place(end, 2.82, 0.22, 0.12, 0.23);
    }
    const bars = Math.ceil(length / 0.38);
    for (let i = 1; i < bars; i++) {
      place(i / bars, 1.57, 0.065, 2.32, 0.065);
      place(i / bars, 2.879, 0.17, 0.17, 0.072, Math.PI / 4);
    }
  }
  let pipeline;
  for (const [key, matrices] of batches) {
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    mesh.name = `${park.perimeter.id}:iron:${key}`;
    if (pipeline) mesh.userData.sharesPipelineWith = pipeline;
    else pipeline = mesh;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return { geometry, material };
}
