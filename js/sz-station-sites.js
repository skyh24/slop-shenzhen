// 福田站地面部分与深圳西丽站在建工地。
// 福田站是地下高铁站，本模块只做地面出入口、采光天窗和站名标识；西丽站按在建工地表达，
// 围挡、塔吊、基坑和临时道路的尺寸都是展示估计（heightSource = estimate），不建假站房。
import * as THREE from 'three/webgpu';
import { polygonBoxOverlaps, polygonContains } from './building-collision.js';

export const FUTIAN_PAVILION_COUNT = 6;
export const FUTIAN_SKYLIGHT_COUNT = 2;
export const FUTIAN_INSET_M = 6;
export const XILI_HOARDING_HEIGHT_M = 3;
export const XILI_HOARDING_THICKNESS_M = 0.25;
export const XILI_PIT_INSET_M = 18;
export const XILI_PIT_DEPTH_M = 6;
export const XILI_CRANE_COUNT = 2;
// 地形网格覆盖全城；土色面略高于地形再加 polygonOffset，否则会被地形本身遮住。
const SURFACE_LIFT_M = 0.04;
const SIGN_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function emptyResult(reason) {
  return { group: null, colliders: [], entrances: [], skylights: [], parts: [],
    statistics: { source: null, entrances: 0, skylights: 0, hoardingLengthM: 0, cranes: 0,
      pitAreaM2: 0, heightSource: 'estimate', missingReason: reason, skipped: [] },
    update() {}, dispose() {} };
}
// ---------- 几何与多边形通用工具 ----------

function outerRings(site) {
  const rings = [];
  for (const polygon of site?.polygons ?? []) {
    if (Array.isArray(polygon?.outer) && polygon.outer.length >= 3
      && polygon.outer.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.z))) {
      rings.push(polygon.outer);
    }
  }
  return rings;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

function ringPerimeter(ring) {
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return length;
}

function ringCentroid(ring) {
  let x = 0, z = 0, weight = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const cross = a.x * b.z - b.x * a.z;
    weight += cross;
    x += (a.x + b.x) * cross;
    z += (a.z + b.z) * cross;
  }
  if (Math.abs(weight) < 1e-9) {
    return { x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
      z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length };
  }
  return { x: x / (3 * weight), z: z / (3 * weight) };
}

function pointInRing(ring, x, z) {
  return polygonContains({ outer: ring, holes: [] }, x, z);
}

function distanceToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

function sampleRing(ring, t) {
  const perimeter = ringPerimeter(ring);
  let target = (((t % 1) + 1) % 1) * perimeter;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (target <= length || i === ring.length - 1) {
      const u = length > 1e-9 ? Math.min(1, target / length) : 0;
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u,
        dx: length > 1e-9 ? (b.x - a.x) / length : 0, dz: length > 1e-9 ? (b.z - a.z) / length : 0 };
    }
    target -= length;
  }
  const a = ring[0], b = ring[1];
  return { x: a.x, z: a.z, dx: b.x - a.x, dz: b.z - a.z };
}

function rotateLocal(x, z, yaw, lx, lz) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return { x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos };
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function canvasTexture(width, height, draw, repeatX = false) {
  if (typeof document === 'undefined') {
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeatX) texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

function mergeParts(parts) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    const position = part.geometry.getAttribute('position');
    vertexCount += position.count;
    indexCount += part.geometry.index ? part.geometry.index.count : position.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colours = new Float32Array(vertexCount * 3);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const colour = new THREE.Color();
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    const geometry = part.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const index = geometry.index;
    positions.set(position.array, vertexOffset * 3);
    if (normal) normals.set(normal.array, vertexOffset * 3);
    if (uv) uvs.set(uv.array, vertexOffset * 2);
    colour.setHex(part.colour ?? 0xffffff).convertSRGBToLinear();
    for (let i = 0; i < position.count; i++) {
      colours[(vertexOffset + i) * 3] = colour.r;
      colours[(vertexOffset + i) * 3 + 1] = colour.g;
      colours[(vertexOffset + i) * 3 + 2] = colour.b;
    }
    if (index) {
      for (let i = 0; i < index.count; i++) indices[indexOffset + i] = index.array[i] + vertexOffset;
      indexOffset += index.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexOffset + i] = i + vertexOffset;
      indexOffset += position.count;
    }
    vertexOffset += position.count;
    geometry.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function boxPart(width, height, depth, x, y, z, colour, yaw = 0) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  if (yaw) geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
  geometry.translate(x, y, z);
  return { geometry, colour };
}

function barPart(ax, ay, az, bx, by, bz, thickness, colour) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-6)) return null;
  const geometry = new THREE.BoxGeometry(1, thickness, thickness);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(dx / length, dy / length, dz / length));
  geometry.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), quaternion, new THREE.Vector3(length, 1, 1)));
  return { geometry, colour };
}

function quadPart(a, b, c, d, normal, colour) {
  const positions = [a, b, c, d].flatMap(point => [point.x, point.y, point.z]);
  const normals = [0, 1, 2, 3].flatMap(() => [normal.x, normal.y, normal.z]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(8), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return { geometry, colour };
}

function ringFanPart(ring, y, colour) {
  const centre = ringCentroid(ring);
  const positions = [], normals = [], uvs = [], indices = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const base = positions.length / 3;
    positions.push(centre.x, y, centre.z, a.x, y, a.z, b.x, y, b.z);
    for (let j = 0; j < 3; j++) { normals.push(0, 1, 0); uvs.push(0, 0); }
    indices.push(base, base + 1, base + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return { geometry, colour };
}

function groundProbes(groundHeight, x, z, yaw, halfX, halfZ) {
  const probes = [[0, 0], [halfX, halfZ], [-halfX, halfZ], [halfX, -halfZ], [-halfX, -halfZ]]
    .map(([lx, lz]) => rotateLocal(x, z, yaw, lx, lz));
  const heights = probes.map(probe => groundHeight(probe.x, probe.z));
  return heights.every(Number.isFinite) ? heights : null;
}

function colliderHit(colliders, x, z, minY, maxY, halfX, halfZ) {
  for (const collider of colliders) {
    if (!Number.isFinite(collider?.minX) || !Number.isFinite(collider?.minY)) continue;
    if (!(collider.minY < maxY && collider.maxY > minY)) continue;
    if (!(collider.minX < x + halfX && collider.maxX > x - halfX
      && collider.minZ < z + halfZ && collider.maxZ > z - halfZ)) continue;
    if (!collider.polygon || polygonBoxOverlaps(collider.polygon, x, z, halfX, halfZ)) return true;
  }
  return false;
}

function ringBounds(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of ring) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return { minX, minZ, maxX, maxZ };
}

function largestRing(rings) {
  let best = rings[0];
  for (const ring of rings) if (ringArea(ring) > ringArea(best)) best = ring;
  return best;
}

function rotatedRectCollider(type, name, x, z, yaw, halfX, halfZ, minY, maxY, sourceId) {
  const outer = [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]]
    .map(([lx, lz]) => rotateLocal(x, z, yaw, lx, lz));
  return {
    type, name, sourceId: sourceId ?? null, heightSource: 'estimate', polygon: { outer, holes: [] },
    minX: Math.min(...outer.map(point => point.x)), maxX: Math.max(...outer.map(point => point.x)),
    minZ: Math.min(...outer.map(point => point.z)), maxZ: Math.max(...outer.map(point => point.z)),
    minY, maxY
  };
}

// ---------- 福田站地面部分 ----------

function futianSignTexture() {
  return canvasTexture(512, 128, (context, width, height) => {
    context.fillStyle = '#12352c';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = 'rgba(255,255,255,0.55)';
    context.lineWidth = 4;
    context.strokeRect(6, 6, width - 12, height - 12);
    context.fillStyle = '#f2f5f1';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `bold 54px ${SIGN_FONT}`;
    context.fillText('福田站', width / 2, height * 0.4);
    context.fillStyle = '#c9a24a';
    context.fillRect(width * 0.2, height * 0.64, width * 0.6, 3);
    context.fillStyle = '#d7e4dc';
    context.font = `bold 23px ${SIGN_FONT}`;
    context.fillText('广深港高铁 · 地下站', width / 2, height * 0.8);
  });
}

function futianBaseGeometry() {
  return mergeParts([
    boxPart(7.8, 0.16, 5.8, 0, 0.08, 0, 0xffffff),
    boxPart(7.0, 0.34, 5.0, 0, 0.2, 0, 0xffffff)
  ]);
}

function futianFrameGeometry() {
  const parts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(boxPart(0.22, 3.0, 0.22, sx * 3.1, 1.85, sz * 2.1, 0x3c4448));
  }
  parts.push(boxPart(7.0, 0.18, 0.18, 0, 3.34, 2.28, 0x3c4448));
  parts.push(boxPart(7.0, 0.18, 0.18, 0, 3.34, -2.28, 0x3c4448));
  parts.push(boxPart(0.18, 0.18, 4.7, 3.28, 3.34, 0, 0x3c4448));
  parts.push(boxPart(0.18, 0.18, 4.7, -3.28, 3.34, 0, 0x3c4448));
  // 入口暗面朝站外，表示下行楼梯口。
  parts.push(boxPart(3.4, 2.55, 0.08, 0, 1.62, 2.5, 0x121619));
  parts.push(boxPart(0.12, 0.55, 0.12, -2.1, 3.62, 2.48, 0x3c4448));
  parts.push(boxPart(0.12, 0.55, 0.12, 2.1, 3.62, 2.48, 0x3c4448));
  return mergeParts(parts);
}

function futianGlassGeometry() {
  return mergeParts([
    boxPart(7.2, 0.1, 5.2, 0, 3.28, 0, 0xffffff),
    boxPart(7.0, 2.8, 0.06, 0, 1.7, -2.44, 0xffffff),
    boxPart(0.06, 2.8, 4.8, 3.42, 1.7, 0, 0xffffff),
    boxPart(0.06, 2.8, 4.8, -3.42, 1.7, 0, 0xffffff)
  ]);
}

function futianSignGeometry(pavilions) {
  const positions = [], normals = [], uvs = [], indices = [];
  const bottom = 2.82, top = 3.6, z = 2.62;
  const frontUv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const backUv = [[1, 0], [1, 1], [0, 1], [0, 0]];
  for (const pavilion of pavilions) {
    const yaw = pavilion.yaw;
    const front = [Math.sin(yaw), 0, Math.cos(yaw)];
    const back = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    const corners = [[-2.1, bottom], [2.1, bottom], [2.1, top], [-2.1, top]].map(([lx, ly]) => {
      const point = rotateLocal(pavilion.x, pavilion.z, yaw, lx, z);
      return [point.x, pavilion.y + ly, point.z];
    });
    let base = positions.length / 3;
    corners.forEach((corner, index) => {
      positions.push(...corner);
      normals.push(...front);
      uvs.push(...frontUv[index]);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base = positions.length / 3;
    [corners[0], corners[3], corners[2], corners[1]].forEach((corner, index) => {
      positions.push(...corner);
      normals.push(...back);
      uvs.push(...backUv[index]);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function placeFutianPavilions(ring, groundHeight, colliders) {
  const centroid = ringCentroid(ring);
  const found = [];
  const tryPoint = (at, inset) => {
    const left = { x: -at.dz, z: at.dx };
    const inward = (centroid.x - at.x) * left.x + (centroid.z - at.z) * left.z >= 0 ? left : { x: -left.x, z: -left.z };
    const x = at.x + inward.x * inset, z = at.z + inward.z * inset;
    if (!pointInRing(ring, x, z) || distanceToRing(ring, x, z) < 4.2) return false;
    const yaw = Math.atan2(-inward.x, -inward.z);
    const corners = [[-3.5, -2.5], [3.5, -2.5], [3.5, 2.5], [-3.5, 2.5]]
      .map(([lx, lz]) => rotateLocal(x, z, yaw, lx, lz));
    if (!corners.every(corner => pointInRing(ring, corner.x, corner.z))) return false;
    const heights = groundProbes(groundHeight, x, z, yaw, 3.8, 2.8);
    if (!heights) return false;
    const y = Math.min(...heights);
    if (colliderHit(colliders, x, z, y, y + 4.4, 3.8, 2.8)) return false;
    if (found.some(pavilion => Math.hypot(pavilion.x - x, pavilion.z - z) < 32)) return false;
    found.push({ x, z, y, yaw, insetM: inset, facingSource: 'station-footprint-outward-estimate' });
    return true;
  };
  for (let attempt = 0; attempt < 24 && found.length < FUTIAN_PAVILION_COUNT; attempt++) {
    for (let index = 0; index < FUTIAN_PAVILION_COUNT && found.length < FUTIAN_PAVILION_COUNT; index++) {
      const at = sampleRing(ring, (index + 0.5) / FUTIAN_PAVILION_COUNT + attempt * 0.031);
      for (const inset of [FUTIAN_INSET_M, FUTIAN_INSET_M + 2, FUTIAN_INSET_M + 4, FUTIAN_INSET_M + 8]) {
        if (tryPoint(at, inset)) break;
      }
    }
  }
  if (found.length < FUTIAN_PAVILION_COUNT) {
    const bounds = ringBounds(ring);
    for (let z = bounds.minZ + 12; z < bounds.maxZ && found.length < FUTIAN_PAVILION_COUNT; z += 12) {
      for (let x = bounds.minX + 12; x < bounds.maxX && found.length < FUTIAN_PAVILION_COUNT; x += 12) {
        if (distanceToRing(ring, x, z) < 8) continue;
        if (found.some(pavilion => Math.hypot(pavilion.x - x, pavilion.z - z) < 28)) continue;
        const yaw = Math.atan2(centroid.x - x, centroid.z - z);
        const corners = [[-3.5, -2.5], [3.5, -2.5], [3.5, 2.5], [-3.5, 2.5]]
          .map(([lx, lz]) => rotateLocal(x, z, yaw, lx, lz));
        if (!corners.every(corner => pointInRing(ring, corner.x, corner.z))) continue;
        const heights = groundProbes(groundHeight, x, z, yaw, 3.8, 2.8);
        if (!heights) continue;
        const y = Math.min(...heights);
        if (colliderHit(colliders, x, z, y, y + 4.4, 3.8, 2.8)) continue;
        found.push({ x, z, y, yaw, insetM: null, facingSource: 'station-footprint-grid-estimate' });
      }
    }
  }
  return found;
}

function placeFutianSkylights(ring, pavilions, groundHeight, colliders) {
  const centroid = ringCentroid(ring);
  const bounds = ringBounds(ring);
  const candidates = [];
  for (let attempt = 0; attempt < 16; attempt++) {
    const at = sampleRing(ring, 0.11 + attempt * 0.047);
    const left = { x: -at.dz, z: at.dx };
    const inward = (centroid.x - at.x) * left.x + (centroid.z - at.z) * left.z >= 0 ? left : { x: -left.x, z: -left.z };
    for (const inset of [16, 20, 24, 28]) {
      candidates.push({ x: at.x + inward.x * inset, z: at.z + inward.z * inset, yaw: Math.atan2(-inward.x, -inward.z) });
    }
  }
  for (let z = bounds.minZ + 14; z < bounds.maxZ; z += 14) {
    for (let x = bounds.minX + 14; x < bounds.maxX; x += 14) {
      candidates.push({ x, z, yaw: Math.atan2(centroid.x - x, centroid.z - z) });
    }
  }
  const found = [];
  for (const candidate of candidates) {
    if (found.length >= FUTIAN_SKYLIGHT_COUNT) break;
    const { x, z, yaw } = candidate;
    if (!pointInRing(ring, x, z) || distanceToRing(ring, x, z) < 7) continue;
    const halfX = 6.3, halfZ = 4.3;
    const corners = [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]]
      .map(([lx, lz]) => rotateLocal(x, z, yaw, lx, lz));
    if (!corners.every(corner => pointInRing(ring, corner.x, corner.z))) continue;
    if (pavilions.some(pavilion => Math.hypot(pavilion.x - x, pavilion.z - z) < 34)) continue;
    if (found.some(skylight => Math.hypot(skylight.x - x, skylight.z - z) < 30)) continue;
    const heights = groundProbes(groundHeight, x, z, yaw, halfX, halfZ);
    if (!heights) continue;
    const y = Math.min(...heights);
    if (colliderHit(colliders, x, z, y, y + 1.0, halfX, halfZ)) continue;
    found.push({ x, z, y, yaw, sizeM: { width: 12, depth: 8 } });
  }
  return found;
}

export function buildFutianStation(scene, stationSite, options = {}) {
  const rings = outerRings(stationSite);
  if (rings.length === 0) return emptyResult('missing-site');
  const ring = largestRing(rings);
  const groundHeight = typeof options.groundHeight === 'function' ? options.groundHeight : () => null;
  const colliders = options.colliders ?? [];
  const pavilions = placeFutianPavilions(ring, groundHeight, colliders);
  const skylights = placeFutianSkylights(ring, pavilions, groundHeight, colliders);
  if (pavilions.length === 0 && skylights.length === 0) {
    return { ...emptyResult('no-placeable-ground'), statistics: { ...emptyResult('no-placeable-ground').statistics,
      source: stationSite.osmId ?? null } };
  }
  const group = new THREE.Group();
  group.name = 'shenzhen-futian-station-ground';
  const stoneMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xb6b1a6, roughness: 0.82 });
  const frameMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.22 });
  const glassMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xa9c8d6, transparent: true, opacity: 0.36,
    roughness: 0.12, metalness: 0.06, depthWrite: false, side: THREE.DoubleSide });
  const geometries = { base: futianBaseGeometry(), frame: futianFrameGeometry(), glass: futianGlassGeometry(),
    skylightFrame: mergeParts([boxPart(12, 0.5, 8, 0, 0.25, 0, 0xffffff)]),
    skylightGlass: mergeParts([boxPart(11.4, 0.24, 7.4, 0, 0.5, 0, 0xffffff)]) };
  const signTexture = futianSignTexture();
  const signGeometry = futianSignGeometry(pavilions);
  const signMaterial = new THREE.MeshBasicNodeMaterial({ map: signTexture });
  const matrix = new THREE.Matrix4();
  for (const [geometry, material, items, name] of [
    [geometries.base, stoneMaterial, pavilions, 'futian-pavilion-bases'],
    [geometries.frame, frameMaterial, pavilions, 'futian-pavilion-frames'],
    [geometries.glass, glassMaterial, pavilions, 'futian-pavilion-glass'],
    [geometries.skylightFrame, stoneMaterial, skylights, 'futian-skylight-frames'],
    [geometries.skylightGlass, glassMaterial, skylights, 'futian-skylight-glass']
  ]) {
    if (items.length === 0) continue;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.name = name;
    items.forEach((item, index) => {
      matrix.compose(new THREE.Vector3(item.x, item.y, item.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.yaw), new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  const signMesh = new THREE.Mesh(signGeometry, signMaterial);
  signMesh.name = 'futian-station-sign';
  signMesh.castShadow = false;
  group.add(signMesh);
  scene.add(group);

  const entranceColliders = pavilions.map((pavilion, index) =>
    rotatedRectCollider('futian-station-entrance', `futian-station-entrance:${index}`, pavilion.x, pavilion.z,
      pavilion.yaw, 3.5, 2.5, pavilion.y, pavilion.y + 3.6, stationSite.osmId));
  const skylightColliders = skylights.map((skylight, index) =>
    rotatedRectCollider('futian-station-skylight', `futian-station-skylight:${index}`, skylight.x, skylight.z,
      skylight.yaw, 6, 4, skylight.y, skylight.y + 0.8, stationSite.osmId));
  const allColliders = [...entranceColliders, ...skylightColliders];
  const centre = ringCentroid(ring);
  const statistics = {
    source: `osm-${stationSite.osmId ?? 'unknown'}`,
    siteOsmId: stationSite.osmId ?? null,
    footprintAreaM2: Math.round(ringArea(ring)),
    footprintPerimeterM: Math.round(ringPerimeter(ring)),
    entrances: pavilions.length,
    skylights: skylights.length,
    colliders: allColliders.length,
    drawCallsEstimate: 6,
    heightSource: 'estimate',
    pavilionSizeM: { width: 7, depth: 5, height: 3.6 },
    limitations: [
      '福田站是地下高铁站：这里只建地面出入口、采光天窗和站名标识，不建站房、站台或轨道',
      '地面亭沿 OSM 站体足迹等距内退布置，位置和朝向是展示参数，不是逐座实测',
      '玻璃亭和采光天窗的样式按常见高铁站地面设施简化，缺逐口影像和设计图纸对照'
    ],
    parts: [
      ...pavilions.map((pavilion, index) => ({ id: `futian-entrance:${index}`, kind: 'entrance', heightSource: 'estimate' })),
      ...skylights.map((skylight, index) => ({ id: `futian-skylight:${index}`, kind: 'skylight', heightSource: 'estimate' }))
    ]
  };
  return {
    group, colliders: allColliders, statistics, entrances: pavilions, skylights,
    parts: statistics.parts,
    update(cameraPositionValue) {
      if (!cameraPositionValue) return;
      signMesh.visible = Math.hypot(cameraPositionValue.x - centre.x,
        cameraPositionValue.z - centre.z) < 1600;
    },
    dispose() {
      scene.remove(group);
      for (const geometry of Object.values(geometries)) geometry.dispose();
      signGeometry.dispose();
      signTexture.dispose();
      stoneMaterial.dispose();
      frameMaterial.dispose();
      glassMaterial.dispose();
      signMaterial.dispose();
    }
  };
}

// ---------- 西丽站在建工地 ----------

function xiliHoardingTexture() {
  return canvasTexture(512, 128, (context, width, height) => {
    context.fillStyle = '#f0efe9';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#1d6fa5';
    context.fillRect(0, height - 18, width, 18);
    context.fillStyle = '#1d6fa5';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `bold 48px ${SIGN_FONT}`;
    context.fillText('深圳西丽站  在建', width / 2, height * 0.4);
    context.fillStyle = '#47525a';
    context.font = `bold 21px ${SIGN_FONT}`;
    context.fillText('施工重地  谢绝入内', width / 2, height * 0.74);
  }, true);
}

function offsetRing(ring, distance) {
  const centroid = ringCentroid(ring);
  const lines = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!(length > 1e-9)) return null;
    const left = { x: -dz / length, z: dx / length };
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const inward = (centroid.x - mx) * left.x + (centroid.z - mz) * left.z >= 0 ? left : { x: -left.x, z: -left.z };
    lines.push({ px: a.x + inward.x * distance, pz: a.z + inward.z * distance, dx, dz });
  }
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[(i + lines.length - 1) % lines.length];
    const second = lines[i];
    const cross = first.dx * second.dz - first.dz * second.dx;
    if (Math.abs(cross) < 1e-9) return null;
    const t = ((second.px - first.px) * second.dz - (second.pz - first.pz) * second.dx) / cross;
    result.push({ x: first.px + first.dx * t, z: first.pz + first.dz * t });
  }
  if (result.length < 3 || ringArea(result) < ringArea(ring) * 0.12) return null;
  if (!result.every(point => pointInRing(ring, point.x, point.z))) return null;
  return result;
}

function craneParts(x, z, y, seed) {
  const tower = 55 + (seed % 11);
  const jib = 40 + (seed % 11);
  const counter = 14 + (seed % 3) * 2;
  const yaw = ((seed >> 5) % 360) * Math.PI / 180;
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
  const parts = [
    boxPart(5.0, 0.6, 5.0, 0, 0.3, 0, 0x8d8a83),
    boxPart(3.2, 0.9, 3.2, 0, tower + 0.45, 0, 0x6f7377)
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(boxPart(0.2, tower, 0.2, sx * 1.1, tower / 2 + 0.6, sz * 1.1, 0xd08a2e));
  }
  for (let h = 5; h < tower; h += 6) {
    parts.push(boxPart(2.4, 0.12, 0.12, 0, h, 1.1, 0xd08a2e));
    parts.push(boxPart(2.4, 0.12, 0.12, 0, h, -1.1, 0xd08a2e));
    parts.push(boxPart(0.12, 0.12, 2.4, 1.1, h, 0, 0xd08a2e));
    parts.push(boxPart(0.12, 0.12, 2.4, -1.1, h, 0, 0xd08a2e));
  }
  parts.push(boxPart(2.2, 1.7, 1.6, 2.0, tower + 1.2, 0, 0xdcdcd6));
  parts.push(boxPart(jib, 0.28, 0.28, jib / 2 - 1, tower + 1.4, 0, 0xd08a2e));
  parts.push(boxPart(jib * 0.92, 0.16, 0.16, jib * 0.46 - 1, tower + 2.5, 0, 0xd08a2e));
  for (let d = 6; d < jib - 4; d += 8) parts.push(boxPart(0.12, 1.2, 0.12, d, tower + 1.9, 0, 0xd08a2e));
  parts.push(boxPart(counter, 0.28, 0.28, -counter / 2 + 1, tower + 1.4, 0, 0xd08a2e));
  parts.push(boxPart(2.4, 2.2, 2.8, -counter + 0.5, tower + 1.1, 0, 0x8d8a83));
  const pendant = barPart(0, tower + 2.9, 0, jib - 2, tower + 2.5, 0, 0.1, 0x4c5053);
  if (pendant) parts.push(pendant);
  const trolley = jib * 0.68;
  parts.push(boxPart(1.1, 0.45, 0.9, trolley, tower + 1.25, 0, 0x6f7377));
  const cable = barPart(trolley, tower + 1.0, 0, trolley, tower - 12, 0, 0.07, 0x3d4144);
  if (cable) parts.push(cable);
  parts.push(boxPart(0.9, 1.1, 0.8, trolley, tower - 13, 0, 0x50565a));
  for (const part of parts) part.geometry.applyMatrix4(matrix);
  return { parts, towerM: tower, jibM: jib, counterJibM: counter, hookHeightM: tower - 13 };
}

function placeCranes(ring, pitRing, count) {
  const bounds = ringBounds(ring);
  const candidates = [];
  for (let z = bounds.minZ + 6; z <= bounds.maxZ - 6; z += 4) {
    for (let x = bounds.minX + 6; x <= bounds.maxX - 6; x += 4) {
      if (!pointInRing(ring, x, z)) continue;
      const clearance = distanceToRing(ring, x, z);
      if (clearance < 8) continue;
      if (pitRing && (pointInRing(pitRing, x, z) || distanceToRing(pitRing, x, z) < 7)) continue;
      candidates.push({ x, z, clearance });
    }
  }
  candidates.sort((a, b) => b.clearance - a.clearance || a.x - b.x || a.z - b.z);
  const chosen = [];
  for (const separation of [90, 60, 35]) {
    for (const candidate of candidates) {
      if (chosen.length >= count) break;
      if (chosen.every(other => Math.hypot(other.x - candidate.x, other.z - candidate.z) >= separation)) {
        chosen.push(candidate);
      }
    }
  }
  return chosen.slice(0, count);
}

export function buildXiliConstruction(scene, xiliSite, options = {}) {
  const rings = outerRings(xiliSite);
  if (rings.length === 0) return emptyResult('missing-site');
  const ring = largestRing(rings);
  const groundHeight = typeof options.groundHeight === 'function' ? options.groundHeight : () => null;
  const isWater = typeof options.isWater === 'function' ? options.isWater : null;
  const siteId = xiliSite.osmId ?? null;
  const centre = ringCentroid(ring);
  const ringHeights = ring.map(point => groundHeight(point.x, point.z));
  const minGround = ringHeights.every(Number.isFinite) ? Math.min(...ringHeights) : 0;
  const pitRing = offsetRing(ring, XILI_PIT_INSET_M);
  const pitAreaM2 = pitRing ? ringArea(pitRing) : 0;
  const skipped = [];
  const group = new THREE.Group();
  group.name = 'shenzhen-xili-construction-site';
  const geometries = [];
  const materials = [];
  const textures = [];
  const meshes = [];

  // 1. 场地土色面：外环三角化，略高于地形并加深度偏移。
  const surfaceParts = [];
  for (const outer of rings) {
    const heights = outer.map(point => groundHeight(point.x, point.z));
    if (!heights.every(Number.isFinite)) {
      skipped.push({ part: 'surface', reason: 'unsupported-ground' });
      continue;
    }
    const lifted = outer.map((point, index) => ({ x: point.x, z: point.z, y: heights[index] + SURFACE_LIFT_M }));
    const centreY = groundHeight(centre.x, centre.z);
    if (!Number.isFinite(centreY)) continue;
    const ringGeometry = { positions: [], normals: [], uvs: [], indices: [] };
    for (let i = 0; i < lifted.length; i++) {
      const a = lifted[i], b = lifted[(i + 1) % lifted.length];
      const base = ringGeometry.positions.length / 3;
      ringGeometry.positions.push(centre.x, centreY + SURFACE_LIFT_M, centre.z, a.x, a.y, a.z, b.x, b.y, b.z);
      for (let j = 0; j < 3; j++) { ringGeometry.normals.push(0, 1, 0); ringGeometry.uvs.push(0, 0); }
      ringGeometry.indices.push(base, base + 1, base + 2);
    }
    surfaceParts.push({ geometry: new THREE.BufferGeometry(), colour: 0x7a6a52 });
    const geometry = surfaceParts.at(-1).geometry;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(ringGeometry.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(ringGeometry.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(ringGeometry.uvs, 2));
    geometry.setIndex(ringGeometry.indices);
  }
  const surfaceGeometry = surfaceParts.length ? mergeParts(surfaceParts) : null;
  if (surfaceGeometry) {
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.97, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(surfaceGeometry, material);
    mesh.name = 'xili-temporary-dirt-surface';
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(surfaceGeometry);
    materials.push(material);
    meshes.push(mesh);
  }

  // 2. 围挡：沿足迹外环分段，最长边中央留大门。
  const gateEdge = ring.reduce((best, point, index) => {
    const next = ring[(index + 1) % ring.length];
    const length = Math.hypot(next.x - point.x, next.z - point.z);
    return length > best.length ? { index, length, a: point, b: next } : best;
  }, { index: -1, length: -1 });
  const gate = gateEdge.index >= 0
    ? { x: (gateEdge.a.x + gateEdge.b.x) / 2, z: (gateEdge.a.z + gateEdge.b.z) / 2, width: 9 }
    : null;
  const hoardingParts = [];
  const textParts = [];
  let hoardingLengthM = 0;
  let hoardingSegments = 0;
  const hoardingColliders = [];
  const hoardingTexture = xiliHoardingTexture();
  for (let edge = 0; edge < ring.length; edge++) {
    const a = ring[edge], b = ring[(edge + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (!(length > 0.5)) continue;
    const count = Math.max(1, Math.ceil(length / 16));
    const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
    const left = { x: -dz, z: dx };
    const inward = (centre.x - (a.x + b.x) / 2) * left.x + (centre.z - (a.z + b.z) / 2) * left.z >= 0
      ? left : { x: -left.x, z: -left.z };
    const yaw = Math.atan2(-dz, dx);
    for (let index = 0; index < count; index++) {
      const start = { x: a.x + (b.x - a.x) * index / count, z: a.z + (b.z - a.z) * index / count };
      const end = { x: a.x + (b.x - a.x) * (index + 1) / count, z: a.z + (b.z - a.z) * (index + 1) / count };
      const middle = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
      if (gate && Math.hypot(middle.x - gate.x, middle.z - gate.z) < gate.width / 2 + 1) {
        skipped.push({ part: 'hoarding', reason: 'gate-opening' });
        continue;
      }
      const groundA = groundHeight(start.x, start.z);
      const groundB = groundHeight(end.x, end.z);
      if (!Number.isFinite(groundA) || !Number.isFinite(groundB)) {
        skipped.push({ part: 'hoarding', reason: 'unsupported-ground' });
        continue;
      }
      const segmentLength = length / count;
      const bottom = Math.min(groundA, groundB) - 0.12;
      hoardingParts.push(boxPart(segmentLength + 0.04, XILI_HOARDING_HEIGHT_M - 0.5, XILI_HOARDING_THICKNESS_M,
        middle.x, bottom + 0.5 + (XILI_HOARDING_HEIGHT_M - 0.5) / 2, middle.z, 0xe8e6df, yaw));
      hoardingParts.push(boxPart(segmentLength + 0.04, 0.5, XILI_HOARDING_THICKNESS_M,
        middle.x, bottom + 0.25, middle.z, 0x1d6fa5, yaw));
      const textGeometry = new THREE.PlaneGeometry(segmentLength - 0.3, 2.0);
      const uv = textGeometry.getAttribute('uv');
      const repeat = Math.max(1, Math.round(segmentLength / 8));
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * repeat);
      textGeometry.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(inward.x, inward.z)));
      textGeometry.translate(middle.x + inward.x * (XILI_HOARDING_THICKNESS_M / 2 + 0.02),
        bottom + 1.55, middle.z + inward.z * (XILI_HOARDING_THICKNESS_M / 2 + 0.02));
      textParts.push({ geometry: textGeometry, colour: 0xffffff });
      hoardingLengthM += segmentLength;
      hoardingSegments++;
      hoardingColliders.push(rotatedRectCollider('xili-hoarding', `xili-hoarding:${edge}:${index}`, middle.x, middle.z,
        yaw, segmentLength / 2, XILI_HOARDING_THICKNESS_M / 2, bottom, bottom + XILI_HOARDING_HEIGHT_M, siteId));
    }
  }
  if (gate) {
    const direction = { x: centre.x - gate.x, z: centre.z - gate.z };
    const length = Math.hypot(direction.x, direction.z) || 1;
    for (const side of [-1, 1]) {
      const x = gate.x - direction.z / length * side * (gate.width / 2 + 0.3);
      const z = gate.z + direction.x / length * side * (gate.width / 2 + 0.3);
      const y = groundHeight(x, z);
      hoardingParts.push(boxPart(0.6, 3.4, 0.6, x, (Number.isFinite(y) ? y : minGround) + 1.7, z, 0x3d4448));
    }
  }
  const hoardingGeometry = mergeParts(hoardingParts);
  const hoardingMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05, side: THREE.DoubleSide });
  const hoardingMesh = new THREE.Mesh(hoardingGeometry, hoardingMaterial);
  hoardingMesh.name = 'xili-hoarding-walls';
  hoardingMesh.castShadow = true;
  hoardingMesh.receiveShadow = true;
  group.add(hoardingMesh);
  geometries.push(hoardingGeometry);
  materials.push(hoardingMaterial);
  meshes.push(hoardingMesh);
  if (textParts.length) {
    const textGeometry = mergeParts(textParts);
    const textMaterial = new THREE.MeshBasicNodeMaterial({ map: hoardingTexture, side: THREE.DoubleSide });
    const textMesh = new THREE.Mesh(textGeometry, textMaterial);
    textMesh.name = 'xili-hoarding-text';
    group.add(textMesh);
    geometries.push(textGeometry);
    materials.push(textMaterial);
    meshes.push(textMesh);
  }
  textures.push(hoardingTexture);

  // 3. 塔吊：多边形内切净距最大点 + 确定性布点。
  const cranePartsAll = [];
  const craneSpecs = [];
  for (const [index, crane] of placeCranes(ring, pitRing, XILI_CRANE_COUNT).entries()) {
    const y = groundHeight(crane.x, crane.z);
    if (!Number.isFinite(y)) {
      skipped.push({ part: 'crane', reason: 'unsupported-ground', index });
      continue;
    }
    if (isWater && isWater(crane.x, crane.z)) {
      skipped.push({ part: 'crane', reason: 'water-conflict', index });
      continue;
    }
    const craneData = craneParts(crane.x, crane.z, y, hashSeed(`xili-crane:${index}`));
    cranePartsAll.push(...craneData.parts);
    craneSpecs.push({ index, x: crane.x, z: crane.z, baseY: y, towerM: craneData.towerM, jibM: craneData.jibM,
      counterJibM: craneData.counterJibM, hookHeightM: craneData.hookHeightM, heightSource: 'estimate' });
  }
  if (cranePartsAll.length) {
    const craneGeometry = mergeParts(cranePartsAll);
    const craneMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.32 });
    const craneMesh = new THREE.Mesh(craneGeometry, craneMaterial);
    craneMesh.name = 'xili-tower-cranes';
    craneMesh.castShadow = true;
    craneMesh.receiveShadow = true;
    group.add(craneMesh);
    geometries.push(craneGeometry);
    materials.push(craneMaterial);
    meshes.push(craneMesh);
  }

  // 4. 基坑：内缩 18 m 平台下沉 6 m，配挡土墙；地形未裁洞，另用坑口钢板桩和深色开挖面表达深度。
  const pitParts = [];
  const pitColliders = [];
  if (pitRing && pitAreaM2 > 300) {
    const pitBottom = minGround - XILI_PIT_DEPTH_M;
    pitParts.push(ringFanPart(pitRing, pitBottom, 0x2a2118));
    // 坑口钢板桩，高出地面 1.8 m。
    for (let i = 0; i < pitRing.length; i++) {
      const a = pitRing[i], b = pitRing[(i + 1) % pitRing.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (!(length > 0.5)) continue;
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const ground = groundHeight(m.x, m.z);
      const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
      pitParts.push(boxPart(length, 1.8, 0.18, m.x, (Number.isFinite(ground) ? ground : minGround) + 0.9, m.z, 0x5c6166, yaw));
      pitColliders.push(rotatedRectCollider('xili-pit-sheet-pile', `xili-pit-sheet-pile:${i}`, m.x, m.z, yaw,
        length / 2, 0.09, pitBottom, (Number.isFinite(ground) ? ground : minGround) + 1.8, siteId));
    }
    // 深色开挖面：贴地形略高，表达坑内土面。
    const floorY = (groundHeight(centre.x, centre.z) ?? minGround) + SURFACE_LIFT_M + 0.04;
    pitParts.push(ringFanPart(pitRing, floorY, 0x292018));
    // 桩基：坑内确定性网格露出的混凝土桩头。
    const bounds = ringBounds(pitRing);
    const step = Math.max(10, Math.sqrt(pitAreaM2 / 14));
    let piles = 0;
    for (let z = bounds.minZ + step / 2; z < bounds.maxZ && piles < 16; z += step) {
      for (let x = bounds.minX + step / 2; x < bounds.maxX && piles < 16; x += step) {
        if (!pointInRing(pitRing, x, z) || distanceToRing(pitRing, x, z) < 5) continue;
        const ground = groundHeight(x, z);
        if (!Number.isFinite(ground)) continue;
        const height = Math.max(1, ground - pitBottom + 0.35);
        const geometry = new THREE.CylinderGeometry(0.55, 0.55, height, 8);
        geometry.translate(x, pitBottom + height / 2, z);
        pitParts.push({ geometry, colour: 0x8f8b80 });
        piles++;
      }
    }
    // 挡土墙：四边从坑底到坑口。
    for (let i = 0; i < pitRing.length; i++) {
      const a = pitRing[i], b = pitRing[(i + 1) % pitRing.length];
      const topA = (groundHeight(a.x, a.z) ?? minGround) + 0.05;
      const topB = (groundHeight(b.x, b.z) ?? minGround) + 0.05;
      pitParts.push(quadPart(
        { x: a.x, y: topA, z: a.z }, { x: a.x, y: pitBottom, z: a.z },
        { x: b.x, y: pitBottom, z: b.z }, { x: b.x, y: topB, z: b.z },
        { x: (b.z - a.z) / Math.max(1, Math.hypot(b.x - a.x, b.z - a.z)), y: 0, z: -(b.x - a.x) / Math.max(1, Math.hypot(b.x - a.x, b.z - a.z)) },
        0x726d64));
    }
  }
  if (pitParts.length) {
    const pitGeometry = mergeParts(pitParts);
    const pitMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.04, side: THREE.DoubleSide });
    const pitMesh = new THREE.Mesh(pitGeometry, pitMaterial);
    pitMesh.name = 'xili-excavation-pit';
    pitMesh.receiveShadow = true;
    group.add(pitMesh);
    geometries.push(pitGeometry);
    materials.push(pitMaterial);
    meshes.push(pitMesh);
  }

  // 5. 临时道路：从大门接入基坑方向。
  let temporaryRoadLengthM = 0;
  if (gate && pitRing) {
    const direction = { x: centre.x - gate.x, z: centre.z - gate.z };
    const length = Math.hypot(direction.x, direction.z) || 1;
    const unit = { x: direction.x / length, z: direction.z / length };
    const distance = Math.min(55, length * 0.6);
    const target = { x: gate.x + unit.x * distance, z: gate.z + unit.z * distance };
    const half = 3;
    const side = { x: -unit.z, z: unit.x };
    const points = [
      { x: gate.x + side.x * half, z: gate.z + side.z * half },
      { x: gate.x - side.x * half, z: gate.z - side.z * half },
      { x: target.x - side.x * half, z: target.z - side.z * half },
      { x: target.x + side.x * half, z: target.z + side.z * half }
    ];
    const positions = [], normals = [], uvs = [], indices = [];
    points.forEach(point => {
      const y = (groundHeight(point.x, point.z) ?? minGround) + SURFACE_LIFT_M + 0.05;
      positions.push(point.x, y, point.z);
      normals.push(0, 1, 0);
      uvs.push(0, 0);
    });
    indices.push(0, 1, 2, 0, 2, 3);
    const roadGeometry = new THREE.BufferGeometry();
    roadGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    roadGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeometry.setIndex(indices);
    roadGeometry.computeBoundingSphere();
    const roadMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x8a8174, roughness: 0.98, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
    roadMesh.name = 'xili-temporary-road';
    roadMesh.receiveShadow = true;
    group.add(roadMesh);
    geometries.push(roadGeometry);
    materials.push(roadMaterial);
    meshes.push(roadMesh);
    temporaryRoadLengthM = distance;
  }
  scene.add(group);

  const colliders = [...hoardingColliders, ...craneSpecs.map(crane => rotatedRectCollider('xili-crane',
    `xili-crane:${crane.index}`, crane.x, crane.z, 0, 2.5, 2.5, crane.baseY, crane.baseY + crane.towerM, siteId)),
    ...pitColliders];
  const parts = [
    { id: 'xili-hoarding', kind: 'hoarding', heightSource: 'estimate' },
    ...craneSpecs.map(crane => ({ id: `xili-crane:${crane.index}`, kind: 'crane', heightSource: 'estimate' })),
    { id: 'xili-pit', kind: 'pit', heightSource: 'estimate' },
    { id: 'xili-temporary-road', kind: 'road', heightSource: 'estimate' },
    { id: 'xili-dirt-surface', kind: 'surface', heightSource: 'estimate' }
  ];
  const statistics = {
    source: `osm-${siteId ?? 'unknown'}`,
    siteOsmId: siteId,
    siteAreaM2: Math.round(ringArea(ring)),
    footprintPerimeterM: Math.round(ringPerimeter(ring)),
    hoardingLengthM: Math.round(hoardingLengthM * 10) / 10,
    hoardingSegments,
    hoardingHeightM: XILI_HOARDING_HEIGHT_M,
    gateWidthM: gate?.width ?? 0,
    cranes: craneSpecs.length,
    craneSpecs,
    craneMaxHeightM: Math.max(...craneSpecs.map(crane => crane.towerM), 0),
    pitAreaM2: Math.round(pitAreaM2),
    pitDepthM: XILI_PIT_DEPTH_M,
    temporaryRoadLengthM: Math.round(temporaryRoadLengthM * 10) / 10,
    colliders: colliders.length,
    drawCallsEstimate: meshes.length,
    heightSource: 'estimate',
    skipped,
    limitations: [
      '西丽站仍在施工：这里只做围挡、塔吊、基坑和临时道路，不生成站房或建成形态',
      '围挡总长、塔吊高度/臂长、基坑范围和临时道路走向都是展示估计，缺施工组织图纸对照',
      '共享地形没有为基坑裁洞；6 m 坑壁与坑底已建模，画面用坑口钢板桩和深色开挖面表达深度，真坑壁要等地形排除后才能露出',
      'APEC 期间围挡公益广告、施工工期和围挡样式需要 2026-11 之后重新核实'
    ],
    parts
  };
  return {
    group, colliders, statistics, cranes: craneSpecs, parts,
    update() {},
    dispose() {
      scene.remove(group);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      for (const mesh of meshes) mesh.dispose?.();
    }
  };
}
