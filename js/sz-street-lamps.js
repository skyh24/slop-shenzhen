import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { isGroundRoad, roadSectionPoints } from './sz-roads.js';
import { sceneUniforms } from './sz-materials.js';
import { polygonBoxOverlaps } from './building-collision.js';

// 灯位按源道路断面和道路等级派生，属外观估计。
const SPACING_BY_CLASS = {
  trunk: 24, trunk_link: 26, primary: 22, primary_link: 24, secondary: 34, secondary_link: 38,
  tertiary: 42, tertiary_link: 46, residential: 50, unclassified: 50, living_street: 56, service: 56
};
const MAJOR_LAMP_CLASSES = new Set(['trunk', 'primary', 'secondary']);
const MEDIAN_CELL_M = 80;
const MIN_MEDIAN_M = 2.4;
const MAX_INFERRED_MEDIAN_M = 18;
const MAX_MEDIAN_M = 55;
const SHARED_POLE_MEDIAN_M = 8;
const CURB_OFFSET_M = 0.9; // 灯杆立在路缘外侧
const ARM_LENGTH_M = 2.2;
const HEAD_HEIGHT_M = 7.9;
const POLE_HEIGHT_M = HEAD_HEIGHT_M - 0.1;
const POLE_BASE_RADIUS_M = 0.14;
const POLE_TOP_RADIUS_M = 0.09;
const POLE_SIDES = 6;
const JUNCTION_MARGIN_M = 14; // 路口附近不放灯杆
const POOL_RADIUS_M = 7.5;
const CHUNK_SIZE_M = 1000;

function normalAt(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 1e-6)) return null;
  return { dx: dx / length, dz: dz / length };
}

function interpolate(points, distance, width) {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (travelled + segment >= distance) {
      const t = segment > 1e-6 ? (distance - travelled) / segment : 0;
      const n = normalAt(a, b);
      if (!n) return null;
      const aLeft = a.leftM ?? width / 2;
      const bLeft = b.leftM ?? width / 2;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
        left: aLeft + (bLeft - aLeft) * t, ...n };
    }
    travelled += segment;
  }
  return null;
}

function indexCarriageways(graph) {
  const cells = new Map();
  for (const [index, link] of graph.links.entries()) {
    const metadata = graph.metadata[index];
    const [, , name, width, , direction] = link;
    if (!graph.names?.[name] || !direction || width < 6 || !isGroundRoad(metadata)
      || !MAJOR_LAMP_CLASSES.has(metadata.highway)) continue;
    const points = roadSectionPoints(graph, link, metadata);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const n = normalAt(a, b);
      if (!n) continue;
      const segment = { a, b, ...n, index, width, direction, length: Math.hypot(b.x - a.x, b.z - a.z) };
      for (let x = Math.floor(Math.min(a.x, b.x) / MEDIAN_CELL_M); x <= Math.floor(Math.max(a.x, b.x) / MEDIAN_CELL_M); x++) {
        for (let z = Math.floor(Math.min(a.z, b.z) / MEDIAN_CELL_M); z <= Math.floor(Math.max(a.z, b.z) / MEDIAN_CELL_M); z++) {
          const key = `${name}:${x},${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(segment);
        }
      }
    }
  }
  return cells;
}

function oppositeCarriageway(cells, link, index, at, side, medianHeight) {
  const [, , name, width, , direction] = link;
  if (!direction) return null;
  const nx = at.dz * side, nz = -at.dx * side;
  const edge = side === 1 ? at.left : width - at.left;
  const x0 = at.x + nx * edge, z0 = at.z + nz * edge;
  const reach = MAX_MEDIAN_M + 24;
  const ix = Math.floor(x0 / MEDIAN_CELL_M), iz = Math.floor(z0 / MEDIAN_CELL_M);
  const ex = Math.floor((x0 + nx * reach) / MEDIAN_CELL_M), ez = Math.floor((z0 + nz * reach) / MEDIAN_CELL_M);
  let best = null;
  for (let x = Math.min(ix, ex); x <= Math.max(ix, ex); x++) {
    for (let z = Math.min(iz, ez); z <= Math.max(iz, ez); z++) {
      for (const other of cells.get(`${name}:${x},${z}`) ?? []) {
        if (other.index === index || (at.dx * other.dx + at.dz * other.dz) * direction * other.direction > -0.93) continue;
        const toward = nx * other.dz - nz * other.dx;
        const centerDistance = ((other.a.x - x0) * other.dz - (other.a.z - z0) * other.dx) / toward;
        const along = (x0 + nx * centerDistance - other.a.x) * other.dx + (z0 + nz * centerDistance - other.a.z) * other.dz;
        if (along < 0 || along > other.length) continue;
        const t = along / other.length;
        const left = (other.a.leftM ?? other.width / 2) * (1 - t) + (other.b.leftM ?? other.width / 2) * t;
        const otherEdge = toward > 0 ? other.width - left : left;
        const gap = centerDistance - otherEdge / Math.abs(toward);
        if (gap < MIN_MEDIAN_M || gap > MAX_MEDIAN_M) continue;
        const xMid = x0 + nx * gap / 2, zMid = z0 + nz * gap / 2;
        const documented = Number.isFinite(medianHeight?.(xMid, zMid));
        if (!documented && gap > MAX_INFERRED_MEDIAN_M) continue;
        if (!best || (documented && !best.documented) || (documented === best.documented && gap < best.gap)) {
          best = { gap, documented, index: other.index };
        }
      }
    }
  }
  return best;
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
  const carriageways = indexCarriageways(roadGraph);
  const seen = new Set();
  const rejected = { bridgeOrTunnelOrLayer: 0, unsupportedClass: 0, shortLink: 0, noGroundPoint: 0, occupied: 0 };
  for (let index = 0; index < roadGraph.links.length; index++) {
    const link = roadGraph.links[index];
    const metadata = roadGraph.metadata[index];
    if (!metadata) throw new Error(`Missing road metadata: ${index}`);
    if (!isGroundRoad(metadata)) {
      rejected.bridgeOrTunnelOrLayer++;
      continue;
    }
    const kind = metadata.highway;
    if (!Object.hasOwn(SPACING_BY_CLASS, kind)) {
      rejected.unsupportedClass++;
      continue;
    }
    const width = link[3];
    const points = roadSectionPoints(roadGraph, link, metadata);
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
    const spacing = options.spacingM ?? SPACING_BY_CLASS[kind];
    if (!(spacing > 0)) throw new Error('Street lamp spacing must be positive');
    const major = width >= 14 || (width >= 8 && MAJOR_LAMP_CLASSES.has(kind));
    for (const side of [1, -1]) {
      // 两侧灯杆错开半个间距，避免正对。
      const phase = side === 1 ? spacing * 0.5 : spacing * 0.25;
      for (let distance = junctionMargin + phase; distance <= total - junctionMargin; distance += spacing) {
        const at = interpolate(points, distance, width);
        if (!at) continue;
        const median = width >= 6 && MAJOR_LAMP_CLASSES.has(kind)
          ? oppositeCarriageway(carriageways, link, index, at, side, options.medianHeight) : null;
        const shared = median && median.gap <= SHARED_POLE_MEDIAN_M;
        if (shared && index > median.index) continue;
        const offset = Math.max(0.4, (side === 1 ? at.left : width - at.left) + (shared ? median.gap / 2 : curbOffset));
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
        sites.push({
          x, z, yaw, class: kind, side, linkIndex: index, stationM: distance,
          roadName: roadGraph.names?.[link[2]] ?? '',
          style: major || median ? 'T' : 'L',
          median: median ? (median.documented ? 'documented' : 'estimated') : null,
          armLengthM: shared ? median.gap / 2 + 1.25 : ARM_LENGTH_M
        });
        if (sites.length >= (options.maxLamps ?? Infinity)) return { sites, rejected };
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

function poleInstances(chunk, lights, group, materials) {
  const count = chunk.length;
  const poleGeometry = new THREE.CylinderGeometry(POLE_TOP_RADIUS_M, POLE_BASE_RADIUS_M, POLE_HEIGHT_M, POLE_SIDES)
    .translate(0, POLE_HEIGHT_M / 2, 0);
  const armGeometry = new THREE.BoxGeometry(1, 0.12, 0.12);
  const headGeometry = new THREE.BoxGeometry(0.8, 0.14, 0.28);
  const pole = new THREE.InstancedMesh(poleGeometry, materials.pole, count);
  const arm = new THREE.InstancedMesh(armGeometry, materials.arm, count);
  const head = new THREE.InstancedMesh(headGeometry, materials.head, lights.length);
  pole.name = `${group.name}:poles`;
  arm.name = `${group.name}:arms`;
  head.name = `${group.name}:heads`;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  chunk.forEach((site, index) => {
    quaternion.setFromAxisAngle(axis, site.yaw);
    matrix.compose(position.set(site.x, site.y, site.z), quaternion, scale.set(1, 1, 1));
    pole.setMatrixAt(index, matrix);
    const shift = site.style === 'T' ? 0 : site.armLengthM / 2;
    matrix.compose(position.set(site.x + Math.cos(site.yaw) * shift, site.y + POLE_HEIGHT_M, site.z - Math.sin(site.yaw) * shift),
      quaternion, scale.set(site.armLengthM * (site.style === 'T' ? 2 : 1), 1, 1));
    arm.setMatrixAt(index, matrix);
  });
  lights.forEach((light, index) => {
    quaternion.setFromAxisAngle(axis, light.yaw);
    matrix.compose(position.set(light.headX, light.headY, light.headZ), quaternion, scale.set(1, 1, 1));
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
  return [poleGeometry, armGeometry, headGeometry];
}

function glowInstances(chunk, group, materials) {
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
  return [poolGeometry, haloGeometry];
}

function lampLights(site, roadHeight) {
  const dx = Math.cos(site.yaw) * site.armLengthM;
  const dz = -Math.sin(site.yaw) * site.armLengthM;
  return (site.style === 'T' ? [1, -1] : [1]).map(side => {
    const poolX = site.x + side * dx * 0.8, poolZ = site.z + side * dz * 0.8;
    return { yaw: site.yaw, poolX, poolZ, poolY: roadHeight?.(poolX, poolZ) ?? site.y,
      headX: site.x + side * dx, headY: site.y + HEAD_HEIGHT_M - 0.16, headZ: site.z + side * dz };
  });
}

function poleCollider(site) {
  const ring = radius => Array.from({ length: POLE_SIDES }, (_, i) => {
    const angle = i * 2 * Math.PI / POLE_SIDES + site.yaw;
    return { x: site.x + Math.sin(angle) * radius, z: site.z + Math.cos(angle) * radius };
  });
  const lower = ring(POLE_BASE_RADIUS_M), upper = ring(POLE_TOP_RADIUS_M);
  const minY = site.y, maxY = site.y + POLE_HEIGHT_M;
  return { type: 'street-lamp', minY, maxY, sourceId: site.linkIndex,
    minX: site.x - POLE_BASE_RADIUS_M, maxX: site.x + POLE_BASE_RADIUS_M,
    minZ: site.z - POLE_BASE_RADIUS_M, maxZ: site.z + POLE_BASE_RADIUS_M,
    polygon: { outer: lower, holes: [] }, loft: { lower, upper, minY, maxY } };
}

export function buildSzStreetLamps(scene, roadGraph, options = {}) {
  const { groundHeight, heightAt = groundHeight, roadHeight, medianHeight, deckOccupied, walkPlacement } = options;
  if (typeof groundHeight !== 'function') throw new Error('Street lamps require a ground height sampler');
  const plan = planLampSites(roadGraph, options);
  const glow = uniform(0);
  const materials = {
    pole: new THREE.MeshStandardNodeMaterial({ color: 0x859198, roughness: 0.55, metalness: 0.22 }),
    arm: new THREE.MeshStandardNodeMaterial({ color: 0x859198, roughness: 0.55, metalness: 0.22 }),
    head: new THREE.MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.2,
      emissiveNode: color(0xffd8a6).mul(glow).mul(3.2) }),
    pool: null,
    halo: null
  };
  const skipped = { unsupportedGround: 0, roadSurface: 0, deck: 0, reservedWalk: 0 };
  const sites = [];
  const placementRadius = 0.34;
  const edgeProbes = [[0, 0], [placementRadius, 0], [-placementRadius, 0], [0, placementRadius], [0, -placementRadius]];
  const obstacles = walkPlacement ? (options.placementObstacles ?? []).filter(item =>
    item.maxX >= walkPlacement.bounds.minX && item.minX <= walkPlacement.bounds.maxX
    && item.maxZ >= walkPlacement.bounds.minZ && item.minZ <= walkPlacement.bounds.maxZ) : [];
  for (const candidate of plan.sites) {
    const site = options.relocateSite ? options.relocateSite(candidate) : candidate;
    if (!site) continue;
    if (!site.median && Number.isFinite(medianHeight?.(site.x, site.z))) continue;
    if (options.carriagewayOccupied?.(site.x, site.z, placementRadius)
      || (roadHeight && edgeProbes.some(([dx, dz]) => Number.isFinite(roadHeight(site.x + dx, site.z + dz))))) {
      skipped.roadSurface++;
      continue;
    }
    const y = heightAt(site.x, site.z);
    if (!Number.isFinite(y)) {
      skipped.unsupportedGround++;
      continue;
    }
    if (walkPlacement?.inPilot(site.x, site.z) && (
      walkPlacement.reserves(site.x, site.z, placementRadius)
      || obstacles.some(item => item.polygon && item.maxY > y && item.minY < y + HEAD_HEIGHT_M
        && item.minX - placementRadius < site.x && item.maxX + placementRadius > site.x
        && item.minZ - placementRadius < site.z && item.maxZ + placementRadius > site.z
        && polygonBoxOverlaps(item.polygon, site.x, site.z, placementRadius, placementRadius)))) {
      skipped.reservedWalk++;
      continue;
    }
    if (deckOccupied) {
      const head = y + HEAD_HEIGHT_M;
      const dx = Math.cos(site.yaw) * site.armLengthM, dz = -Math.sin(site.yaw) * site.armLengthM;
      if (deckOccupied(site.x, site.z, y, head)
        || deckOccupied(site.x + dx, site.z + dz, head - 0.25, head)
        || (site.style === 'T' && deckOccupied(site.x - dx, site.z - dz, head - 0.25, head))) {
        skipped.deck++;
        continue;
      }
    }
    sites.push({ ...site, y });
  }
  // 光晕贴图可注入，便于 Node 里用真实 three 跑运行期测试；默认仍走 canvas 径向渐变。
  const texture = typeof options.createGlowTexture === 'function' ? options.createGlowTexture() : radialTexture();
  materials.pool = new THREE.MeshBasicMaterial({ map: texture, color: 0xffc98a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false });
  materials.halo = new THREE.PointsMaterial({ map: texture, color: 0xffd7a8, size: 8.0, sizeAttenuation: true,
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const group = new THREE.Group();
  group.name = 'shenzhen-street-lamps';
  const chunkSize = options.chunkSizeM ?? CHUNK_SIZE_M;
  const chunks = groupLampSites(sites, chunkSize);
  const geometries = [];
  const chunkGroups = new Map();
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
    const lights = chunk.flatMap(site => lampLights(site, roadHeight));
    for (const site of chunk) site.chunkKey = key;
    geometries.push(...poleInstances(chunk, lights, chunkGroup.group, materials));
    geometries.push(...glowInstances(lights, chunkGroup.group, materials));
    chunkGroup.center.y = chunk.reduce((sum, site) => sum + site.y, 0) / chunk.length;
    group.add(chunkGroup.group);
    chunkGroups.set(key, chunkGroup);
  }
  scene.add(group);
  const statistics = {
    source: 'derived-from-road-centrelines',
    method: 'section width and paired carriageways determine the lamp shape and median placement',
    spacingByClassM: { ...SPACING_BY_CLASS },
    planned: plan.sites.length,
    placed: sites.length,
    tPoles: sites.filter(site => site.style === 'T').length,
    medianPoles: sites.filter(site => site.median).length,
    chunks: chunkGroups.size,
    skipped,
    rejected: plan.rejected,
    headHeightM: HEAD_HEIGHT_M,
    limitations: ['lamp positions are appearance parameters derived from source road centrelines, not surveyed pole locations',
      'light pools and halos are visual approximations, not photometric simulation']
  };
  return {
    group,
    sites,
    colliders: sites.map(poleCollider),
    statistics,
    chunkVisible(key) { return chunkGroups.get(key)?.group.visible ?? false; },
    update(cameraPosition) {
      // 日夜系数直接读全局 uniform，入口不再逐个模块转抄。
      const nightValue = sceneUniforms.night.value;
      const night = Number.isFinite(nightValue) ? Math.min(1, Math.max(0, nightValue)) : 0;
      glow.value = night;
      materials.pool.opacity = night * 0.72;
      materials.halo.opacity = night * 0.9;
      if (cameraPosition) {
        for (const chunk of chunkGroups.values()) {
          const distance = Math.hypot(cameraPosition.x - chunk.center.x, cameraPosition.z - chunk.center.z);
          chunk.group.visible = distance < 1600;
        }
      }
    },
    dispose() {
      scene.remove(group);
      group.traverse(mesh => { if (mesh.isInstancedMesh) mesh.dispose(); });
      for (const geometry of geometries) geometry.dispose();
      for (const material of Object.values(materials)) material?.dispose?.();
      texture.dispose();
    }
  };
}
