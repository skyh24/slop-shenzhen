import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { roadLinkPoints } from './sz-roads.js';
import { sceneUniforms } from './sz-materials.js';

// 主干道路灯：点位按源路网中心线等距派生，属外观还原参数，不代表逐杆实测位置。
const LAMP_CLASSES = new Set(['trunk', 'trunk_link', 'primary', 'primary_link']);
const SPACING_BY_CLASS = { trunk: 24, trunk_link: 26, primary: 22, primary_link: 24 };
const CURB_OFFSET_M = 0.9; // 灯杆立在路缘外侧
const ARM_LENGTH_M = 2.2;
const HEAD_HEIGHT_M = 7.9;
const POLE_HEIGHT_M = 8.2;
const JUNCTION_MARGIN_M = 14; // 路口附近不放灯杆
const POOL_RADIUS_M = 7.5;
const CHUNK_SIZE_M = 1000;
const MAX_LAMPS = 30000;

function normalAt(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 1e-6)) return null;
  return { dx: dx / length, dz: dz / length };
}

function interpolate(points, distance) {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (travelled + segment >= distance) {
      const t = segment > 1e-6 ? (distance - travelled) / segment : 0;
      const n = normalAt(a, b);
      if (!n) return null;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ...n };
    }
    travelled += segment;
  }
  return null;
}

export function planLampSites(roadGraph, options = {}) {
  if (!Array.isArray(roadGraph?.links) || !Array.isArray(roadGraph?.metadata)
    || roadGraph.links.length === 0 || roadGraph.links.length !== roadGraph.metadata.length
    || !Array.isArray(roadGraph?.nodes)) {
    throw new Error('Road graph is required for street lamp planning');
  }
  const junctionMargin = options.junctionMarginM ?? JUNCTION_MARGIN_M;
  const curbOffset = options.curbOffsetM ?? CURB_OFFSET_M;
  const sites = [];
  const seen = new Set();
  const rejected = { bridgeOrTunnelOrLayer: 0, unsupportedClass: 0, shortLink: 0, noGroundPoint: 0, occupied: 0 };
  for (let index = 0; index < roadGraph.links.length; index++) {
    const link = roadGraph.links[index];
    const metadata = roadGraph.metadata[index];
    if (!metadata) throw new Error(`Missing road metadata: ${index}`);
    if (metadata.heightSource !== 'terrain' || metadata.bridge || metadata.tunnel || metadata.layer) {
      rejected.bridgeOrTunnelOrLayer++;
      continue;
    }
    const kind = metadata.highway;
    if (!LAMP_CLASSES.has(kind)) {
      rejected.unsupportedClass++;
      continue;
    }
    const width = link[3];
    const points = roadLinkPoints(roadGraph, link);
    if (points.length < 2) {
      rejected.shortLink++;
      continue;
    }
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    if (total < junctionMargin * 2 + 8) {
      rejected.shortLink++;
      continue;
    }
    const spacing = options.spacingM ?? SPACING_BY_CLASS[kind] ?? 32;
    const offset = Math.max(0.4, width / 2 + curbOffset);
    for (const side of [1, -1]) {
      // 两侧灯杆错开半个间距，避免正对。
      const phase = side === 1 ? spacing * 0.5 : spacing * 0.25;
      for (let distance = junctionMargin + phase; distance <= total - junctionMargin; distance += spacing) {
        const at = interpolate(points, distance);
        if (!at) continue;
        const x = at.x + at.dz * offset * side;
        const z = at.z - at.dx * offset * side;
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          rejected.noGroundPoint++;
          continue;
        }
        // 同一坐标附近的重复路段只保留一杆；后出现的道路不覆盖先出现的。
        const key = `${Math.round(x * 2)},${Math.round(z * 2)}`;
        if (seen.has(key)) {
          rejected.occupied++;
          continue;
        }
        seen.add(key);
        // 灯臂朝路中心；局部 +X 经绕 Y 旋转后得到世界方向 (cosθ, -sinθ)。
        const inwardXDir = -at.dz * side;
        const inwardZDir = at.dx * side;
        const yaw = Math.atan2(-inwardZDir, inwardXDir);
        const poolX = at.x + inwardXDir * ARM_LENGTH_M * 0.6;
        const poolZ = at.z + inwardZDir * ARM_LENGTH_M * 0.6;
        sites.push({
          x, z, yaw, class: kind, side, linkIndex: index, stationM: distance,
          poolX, poolZ, armLengthM: ARM_LENGTH_M
        });
        if (sites.length >= (options.maxLamps ?? MAX_LAMPS)) return { sites, rejected };
      }
    }
  }
  return { sites, rejected };
}

export function groupLampSites(sites, chunkSize = CHUNK_SIZE_M) {
  const chunks = new Map();
  for (const site of sites) {
    const key = `${Math.floor(site.x / chunkSize)},${Math.floor(site.z / chunkSize)}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(site);
  }
  return chunks;
}

function radialTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,235,205,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,214,158,0.55)');
  gradient.addColorStop(1, 'rgba(255,198,120,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function poleInstances(chunk, group, materials, glow) {
  const count = chunk.length;
  const poleGeometry = new THREE.CylinderGeometry(0.09, 0.14, POLE_HEIGHT_M, 6).translate(0, POLE_HEIGHT_M / 2, 0);
  const armGeometry = new THREE.BoxGeometry(ARM_LENGTH_M, 0.12, 0.12).translate(ARM_LENGTH_M / 2, HEAD_HEIGHT_M - 0.1, 0);
  const headGeometry = new THREE.BoxGeometry(0.8, 0.14, 0.28).translate(ARM_LENGTH_M, HEAD_HEIGHT_M - 0.16, 0);
  const pole = new THREE.InstancedMesh(poleGeometry, materials.pole, count);
  const arm = new THREE.InstancedMesh(armGeometry, materials.arm, count);
  const head = new THREE.InstancedMesh(headGeometry, materials.head, count);
  pole.name = `${group.name}:poles`;
  arm.name = `${group.name}:arms`;
  head.name = `${group.name}:heads`;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  chunk.forEach((site, index) => {
    quaternion.setFromAxisAngle(axis, site.yaw);
    matrix.compose(new THREE.Vector3(site.x, site.y, site.z), quaternion, new THREE.Vector3(1, 1, 1));
    pole.setMatrixAt(index, matrix);
    arm.setMatrixAt(index, matrix);
    head.setMatrixAt(index, matrix);
  });
  for (const mesh of [pole, arm, head]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  glow.visible = true;
  return [poleGeometry, armGeometry, headGeometry];
}

function glowInstances(chunk, group, materials, textures, glow) {
  const count = chunk.length;
  const poolGeometry = new THREE.CircleGeometry(POOL_RADIUS_M, 18).rotateX(-Math.PI / 2);
  const pool = new THREE.InstancedMesh(poolGeometry, materials.pool, count);
  pool.name = `${group.name}:pools`;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const positions = new Float32Array(count * 3);
  chunk.forEach((site, index) => {
    matrix.compose(new THREE.Vector3(site.poolX, site.poolY + 0.06, site.poolZ), quaternion, new THREE.Vector3(1, 1, 1));
    pool.setMatrixAt(index, matrix);
    positions[index * 3] = site.headX;
    positions[index * 3 + 1] = site.headY;
    positions[index * 3 + 2] = site.headZ;
  });
  pool.instanceMatrix.needsUpdate = true;
  pool.frustumCulled = true;
  pool.computeBoundingSphere();
  group.add(pool);
  const haloGeometry = new THREE.BufferGeometry();
  haloGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Points 的视锥剔除读几何包围球，先算出来再打开剔除，否则整块光晕会被误剔。
  haloGeometry.computeBoundingSphere();
  const halo = new THREE.Points(haloGeometry, materials.halo);
  halo.frustumCulled = true;
  halo.name = `${group.name}:halos`;
  group.add(halo);
  return { poolGeometry, haloGeometry, textures };
}

export function buildSzStreetLamps(scene, roadGraph, options = {}) {
  const { groundHeight, roadHeight } = options;
  if (typeof groundHeight !== 'function') throw new Error('Street lamps require a ground height sampler');
  const plan = planLampSites(roadGraph, options);
  const glow = uniform(0);
  const materials = {
    pole: new THREE.MeshStandardNodeMaterial({ color: 0x33373a, roughness: 0.55, metalness: 0.35 }),
    arm: new THREE.MeshStandardNodeMaterial({ color: 0x33373a, roughness: 0.55, metalness: 0.35 }),
    head: new THREE.MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.2,
      emissiveNode: color(0xffd8a6).mul(glow).mul(3.2) }),
    pool: null,
    halo: null
  };
  const textures = {};
  const skipped = { unsupportedGround: 0, roadSurface: 0 };
  const unique = new Set();
  const sites = [];
  for (const site of plan.sites) {
    const key = `${Math.round(site.x * 2)},${Math.round(site.z * 2)}`;
    if (unique.has(key)) continue;
    unique.add(key);
    if (typeof roadHeight === 'function' && roadHeight(site.x, site.z) != null) {
      skipped.roadSurface++;
      continue;
    }
    const y = groundHeight(site.x, site.z);
    if (!Number.isFinite(y)) {
      skipped.unsupportedGround++;
      continue;
    }
    const poolY = typeof roadHeight === 'function' ? (roadHeight(site.poolX, site.poolZ) ?? y) : y;
    sites.push({ ...site, y, poolY,
      headX: site.x + Math.cos(site.yaw) * ARM_LENGTH_M,
      headZ: site.z - Math.sin(site.yaw) * ARM_LENGTH_M,
      headY: y + HEAD_HEIGHT_M - 0.16 });
  }
  // 光晕贴图可注入，便于 Node 里用真实 three 跑运行期测试；默认仍走 canvas 径向渐变。
  const texture = typeof options.createGlowTexture === 'function' ? options.createGlowTexture() : radialTexture();
  textures.main = texture;
  materials.pool = new THREE.MeshBasicMaterial({ map: texture, color: 0xffc98a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false });
  materials.halo = new THREE.PointsMaterial({ map: texture, color: 0xffd7a8, size: 8.0, sizeAttenuation: true,
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const group = new THREE.Group();
  group.name = 'shenzhen-street-lamps';
  const chunkSize = options.chunkSizeM ?? CHUNK_SIZE_M;
  const chunks = groupLampSites(sites, chunkSize);
  const geometries = [];
  const chunkGroups = [];
  for (const [key, chunk] of chunks) {
    const chunkGroup = {
      name: `lamps:${key}`,
      group: new THREE.Group(),
      center: new THREE.Vector3()
    };
    chunkGroup.group.name = chunkGroup.name;
    chunkGroup.center.set(
      chunk.reduce((sum, site) => sum + site.x, 0) / chunk.length,
      0,
      chunk.reduce((sum, site) => sum + site.z, 0) / chunk.length
    );
    geometries.push(...poleInstances(chunk, chunkGroup.group, materials, glow));
    const glowParts = glowInstances(chunk, chunkGroup.group, materials, textures, glow);
    geometries.push(glowParts.poolGeometry, glowParts.haloGeometry);
    chunkGroup.center.y = chunk.reduce((sum, site) => sum + site.y, 0) / chunk.length;
    group.add(chunkGroup.group);
    chunkGroups.push(chunkGroup);
  }
  scene.add(group);
  const statistics = {
    source: 'derived-from-road-centrelines',
    method: 'equal spacing along ground trunk/primary centre lines, both sides, curb offset',
    spacingByClassM: { ...SPACING_BY_CLASS },
    planned: plan.sites.length,
    placed: sites.length,
    chunks: chunkGroups.length,
    skipped,
    rejected: plan.rejected,
    headHeightM: HEAD_HEIGHT_M,
    limitations: ['lamp positions are appearance parameters derived from source road centrelines, not surveyed pole locations',
      'light pools and halos are visual approximations, not photometric simulation']
  };
  return {
    group,
    sites,
    statistics,
    update(cameraPosition) {
      // 日夜系数直接读全局 uniform，入口不再逐个模块转抄。
      const nightValue = sceneUniforms.night.value;
      const night = Number.isFinite(nightValue) ? Math.min(1, Math.max(0, nightValue)) : 0;
      glow.value = night;
      materials.pool.opacity = night * 0.72;
      materials.halo.opacity = night * 0.9;
      if (cameraPosition) {
        for (const chunk of chunkGroups) {
          const distance = Math.hypot(cameraPosition.x - chunk.center.x, cameraPosition.z - chunk.center.z);
          chunk.group.visible = distance < 1600;
        }
      }
    },
    dispose() {
      scene.remove(group);
      for (const geometry of geometries) geometry.dispose();
      for (const material of Object.values(materials)) material?.dispose?.();
      texture.dispose();
    }
  };
}
