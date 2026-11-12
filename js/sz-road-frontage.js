import * as THREE from 'three/webgpu';
import { color, fract, fwidth, max, min, positionWorld, smoothstep } from 'three/tsl';
import { createIntersectionControl, signalPhase } from './sz-intersection-control.js';
import { convexHull, createRoadHeightSampler, createRoadPolygonLayout } from './sz-roads.js';

const POLE_RADIUS = 0.135;
const FOOT_RADIUS = 0.24;
const FOOT_HEIGHT = 0.35;
const POLE_SIDES = 12;
const LIGHTS = ['red', 'yellow', 'green'];
const ACTIVE_COLORS = [0xff3024, 0xffbc35, 0x26e771];
const IDLE_COLORS = [0x402321, 0x40331e, 0x173827];

function material(colorValue, bias = 0, roughness = 0.9) {
  return new THREE.MeshStandardNodeMaterial({ color: colorValue, roughness, polygonOffset: bias !== 0,
    polygonOffsetFactor: bias, polygonOffsetUnits: bias });
}

function pavingMaterial() {
  const m = material(0x96948e, -2);
  const grid = positionWorld.xz.div(0.58);
  const tile = fract(grid);
  const pixel = max(fwidth(grid.x), fwidth(grid.y));
  const joint = min(min(tile.x, tile.x.oneMinus()), min(tile.y, tile.y.oneMinus()));
  const grout = smoothstep(0.011, max(0.026, pixel), joint).oneMinus().mul(smoothstep(0.12, 0.42, pixel).oneMinus());
  m.colorNode = color(0x96948e).mul(grout.mul(-0.22).add(1));
  return m;
}

function plantedSurfaceMaterial(base) {
  const m = material(base, 0, 0.97);
  const x = positionWorld.x.mul(2.7).add(positionWorld.z.mul(1.9));
  const z = positionWorld.z.mul(2.3).sub(positionWorld.x.mul(1.4));
  const detail = fract(x).mul(fract(z));
  const fade = smoothstep(0.25, 0.9, max(fwidth(x), fwidth(z))).oneMinus();
  const mottling = positionWorld.x.mul(0.43).sin().mul(positionWorld.z.mul(0.59).sin());
  m.colorNode = color(base).mul(mottling.mul(0.055).add(detail.mul(fade).mul(0.35)).add(0.91));
  return m;
}

function polygonMesh(positions, origin, mat, name) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions instanceof Float32Array ? positions : new Float32Array(positions), 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(origin[0], 0, origin[1]);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

function addCurbWalls(group, feature, groundHeight, mat) {
  if (!feature.outlines.length) return 0;
  const origin = feature.outlines[0].slice(0, 2);
  const vertices = [];
  function quad(ax, az, ay, bx, bz, by) {
    const a = [ax - origin[0], ay, az - origin[1]], b = [bx - origin[0], by, bz - origin[1]];
    const c = [b[0], b[1] + feature.riseM, b[2]], d = [a[0], a[1] + feature.riseM, a[2]];
    vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  for (const ring of feature.outlines) {
    for (let i = 2; i < ring.length; i += 2) {
      const ax = ring[i - 2], az = ring[i - 1], bx = ring[i], bz = ring[i + 1];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.003) continue;
      // 沿真实地面取短断面，边沿侧壁随局部坡度而变。
      const pieces = Math.ceil(length / 1.5);
      let x = ax, z = az, y = groundHeight(x, z);
      for (let j = 1; j <= pieces; j++) {
        const t = j / pieces;
        const nextX = ax + (bx - ax) * t, nextZ = az + (bz - az) * t;
        const nextY = groundHeight(nextX, nextZ);
        if (Number.isFinite(y) && Number.isFinite(nextY)) quad(x, z, y, nextX, nextZ, nextY);
        x = nextX;
        z = nextZ;
        y = nextY;
      }
    }
  }
  if (vertices.length) group.add(polygonMesh(vertices, origin, mat, `${feature.id}:curbs`));
  return vertices.length / 9;
}

function hardwareCollider(geometry, matrix, sourceId, part) {
  const points = [];
  const vertex = new THREE.Vector3();
  const box = new THREE.Box3();
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
    box.expandByPoint(vertex);
    points.push({ x: vertex.x, z: vertex.z });
  }
  return { type: 'signal', sourceId, part, polygon: { outer: convexHull(points), holes: [] },
    minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, minY: box.min.y, maxY: box.max.y };
}

function instance(group, name, geo, mat, matrices) {
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.name = name;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
  return mesh;
}

function signalHardware(group, control, contactHeight, roadHeight) {
  const poles = [], feet = [], arms = [], heads = [], lenses = [[], []];
  const colliders = [];
  const origins = [];
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const junction of control.intersections) {
    for (const a of junction.approaches) {
      if (!a.pole || !Number.isFinite(roadHeight(a.stopX, a.stopZ))) continue;
      const [x, z] = a.pole;
      const y = contactHeight(x, z);
      if (!Number.isFinite(y) || Number.isFinite(roadHeight(x, z))) continue;
      const id = `node/${a.osmNodeId}`;
      const right = new THREE.Vector3(-a.dz, 0, a.dx);
      const across = (x - a.stopX) * right.x + (z - a.stopZ) * right.z;
      const length = across + a.widthM * 0.27;
      let highestRoad = roadHeight(a.stopX, a.stopZ);
      // 逐侧取实际沥青高程，保证深南大道这个样段的坡面仍留出 5.5 米灯箱净空。
      for (let d = 0; d <= length + 0.3; d += 0.24) {
        for (const f of [-0.2, 0, 0.2]) {
          const sample = roadHeight(x - right.x * d + a.dx * f, z - right.z * d + a.dz * f);
          if (Number.isFinite(sample)) highestRoad = Math.max(highestRoad, sample);
        }
      }
      const armY = Math.max(y + 6.18, highestRoad + 6.52);
      const poleHeight = armY + 0.22 - y;
      origins.push({ sourceId: id, x, y, z, minClearanceM: armY - 0.965 - highestRoad });
      poles.push({ id, matrix: new THREE.Matrix4().makeScale(1, poleHeight, 1).setPosition(x, y + poleHeight / 2, z) });
      feet.push({ id, matrix: new THREE.Matrix4().makeTranslation(x, y + FOOT_HEIGHT / 2, z) });
      const armRotation = new THREE.Quaternion().setFromUnitVectors(yAxis, right);
      arms.push({ id, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x - right.x * length / 2, armY, z - right.z * length / 2),
        armRotation, new THREE.Vector3(1, length, 1)) });
      const angle = Math.atan2(-a.dx, -a.dz);
      const headAt = (distance, height, forward = 0) => new THREE.Matrix4().makeRotationY(angle)
        .setPosition(x - right.x * distance - a.dx * forward, height, z - right.z * distance - a.dz * forward);
      for (const distance of [across - a.widthM * 0.24, length - 0.23]) {
        heads.push({ id, matrix: headAt(distance, armY - 0.51) });
        lenses[a.group].push({ id, matrices: LIGHTS.map((_, i) => headAt(distance, armY - 0.22 - i * 0.28, 0.14)) });
      }
    }
  }
  if (!poles.length) return { update() {}, colliders, origins };
  const silver = material(0x757e81, 0, 0.55);
  const install = (name, geometry, mat, rows) => {
    const mesh = instance(group, `signals:${name}`, geometry, mat, rows.map(row => row.matrix));
    const matrix = new THREE.Matrix4();
    rows.forEach(({ id }, i) => {
      mesh.getMatrixAt(i, matrix);
      colliders.push(hardwareCollider(geometry, matrix, id, name));
    });
  };
  install('masts', new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, 1, POLE_SIDES), silver, poles);
  install('feet', new THREE.CylinderGeometry(FOOT_RADIUS, FOOT_RADIUS, FOOT_HEIGHT, POLE_SIDES), material(0x96958e), feet);
  install('arms', new THREE.CylinderGeometry(0.065, 0.09, 1, 8), silver, arms);
  install('housings', new THREE.BoxGeometry(0.37, 0.91, 0.25), material(0x252b2c, 0, 0.72), heads);
  const geometry = new THREE.CylinderGeometry(0.105, 0.105, 0.042, 14).rotateX(Math.PI / 2);
  const lensMaterials = lenses.map((rows, directionGroup) => LIGHTS.map((name, i) => {
    const m = material(IDLE_COLORS[i], 0, 0.34);
    m.emissive.setHex(ACTIVE_COLORS[i]);
    m.emissiveIntensity = 0;
    if (rows.length) install(`${directionGroup}:${name}`, geometry, m, rows.map(({ id, matrices }) => ({ id, matrix: matrices[i] })));
    return m;
  }));
  const phases = [null, null];
  function update(elapsedSeconds) {
    for (let groupIndex = 0; groupIndex < phases.length; groupIndex++) {
      const next = signalPhase(groupIndex, elapsedSeconds);
      if (phases[groupIndex] === next) continue;
      phases[groupIndex] = next;
      lensMaterials[groupIndex].forEach((m, i) => {
        const active = LIGHTS[i] === next;
        m.color.setHex(active ? ACTIVE_COLORS[i] : IDLE_COLORS[i]);
        m.emissiveIntensity = active ? 1.25 : 0;
      });
    }
  }
  update(0);
  return { update, colliders, origins };
}

function addMedianShrubs(group, sites, contactHeight) {
  const matrices = [];
  const tint = new THREE.Color();
  for (const [x, z] of sites) {
    const y = contactHeight(x, z);
    if (!Number.isFinite(y)) continue;
    matrices.push(new THREE.Matrix4().makeScale(1.35, 0.48, 0.68).setPosition(x, y + 0.29, z));
  }
  if (matrices.length) {
    const mesh = instance(group, 'shennan-median:planting-estimate', new THREE.IcosahedronGeometry(1, 1), material(0xffffff), matrices);
    matrices.forEach((_, i) => mesh.setColorAt(i, tint.setHex(i % 3 ? 0x486633 : 0x627a38)));
    mesh.instanceColor.needsUpdate = true;
  }
  return matrices.length;
}

function addShennanFlowerBeds(group, sites, medianHeight, material) {
  const vertices = [];
  const rows = [];
  for (let i = 1; i < sites.length; i += 2) {
    const [x, a] = sites[i - 1], [nextX, b] = sites[i];
    if (x !== nextX || !Number.isFinite(medianHeight(x, (a + b) * 0.5))) continue;
    rows.push({ x, z: (a + b) * 0.5, width: Math.abs(a - b) });
  }
  if (rows.length < 3) return 0;
  const origin = [rows[0].x, rows[0].z];
  let count = 0, lastX = origin[0] - 18;
  for (let i = 1; i < rows.length - 1; i++) {
    const { x, z, width } = rows[i];
    if (x - lastX < 32 + (count % 3) * 7 || width < 4) continue;
    const dx = rows[i + 1].x - rows[i - 1].x, dz = rows[i + 1].z - rows[i - 1].z;
    const angle = Math.atan2(dz, dx);
    const ux = Math.cos(angle), uz = Math.sin(angle);
    const halfLength = 6.8 + (count % 4) * 2.1;
    const halfWidth = width * (0.25 + (count % 3) * 0.025);
    const turn = count % 2 === 0 ? 1 : -1;
    const compact = count % 5 === 2;
    const bed = [];
    // 逐排采样绿带顶面。靠近端头或开口放不下时跳过整块花带。
    for (let j = 0; j <= 14; j++) {
      const t = j / 14;
      const along = (2 * t - 1) * halfLength;
      const bend = Math.sin((compact ? 1 : 2) * Math.PI * t) * halfWidth * 0.54 * turn;
      const span = halfWidth * (0.04 + 0.96 * Math.sin(Math.PI * t) ** 0.8)
        * (0.86 + 0.14 * Math.cos(t * Math.PI * 3 + count));
      for (const side of [-1, 1]) {
        const cross = bend + span * side;
        const px = x + ux * along - uz * cross, pz = z + uz * along + ux * cross;
        const y = medianHeight(px, pz);
        if (Number.isFinite(y)) bed.push([px - origin[0], y + 0.07, pz - origin[1]]);
      }
    }
    if (bed.length !== 30) continue;
    for (let j = 2; j < bed.length; j += 2) {
      vertices.push(...bed[j - 2], ...bed[j - 1], ...bed[j], ...bed[j], ...bed[j - 1], ...bed[j + 1]);
    }
    count++;
    lastX = x;
  }
  if (count) group.add(polygonMesh(vertices, origin, material, 'shennan-median:flower-beds'));
  return count;
}

export function buildSzRoadFrontage(scene, source, graph, terrain, { groundHeight, roadHeight } = {}) {
  const control = createIntersectionControl(source, graph);
  const statistics = { triangleCount: 0, curbTriangles: 0, curbSegments: 0, signals: 0, shrubs: 0, shennanFlowerBeds: 0 };
  const empty = { group: null, control, contactHeight: () => null, shennanMedianHeight: () => null, colliders: [],
    detailedRoadIds: [], statistics, update() {}, dispose() {} };
  if (!source) return empty;
  if (typeof groundHeight !== 'function' || typeof roadHeight !== 'function') throw new Error('Road frontage requires terrain and asphalt contact');

  const group = new THREE.Group();
  group.name = 'shenzhen-road-frontage';
  const paving = pavingMaterial();
  const walls = material(0xa4a39a);
  // 外环和洞沿的源环方向可能相反，双面材料只用于薄路缘侧壁。
  walls.side = THREE.DoubleSide;
  const style = { sidewalk: paving, paving, paint: material(0xf1eee5, -3, 0.84), median: material(0x52673b) };
  const grass = plantedSurfaceMaterial(0x4f762b);
  const flowers = plantedSurfaceMaterial(0x864359);
  const shennanMedians = new Map(source.corridors.filter(row => row.id.startsWith('shennan-')
    && row.medianSource?.positionSource === 'documented-median-between-osm-carriageways')
    .map(row => [`${row.id}:median`, row]));
  const medianSamplers = [];
  const samplers = [];
  for (const feature of source.features) {
    const corridor = shennanMedians.get(feature.id);
    const planted = corridor && feature.kind === 'median'
      && feature.sourceIds.length >= 2 && feature.sourceIds.every(id => /^way\/\d+$/.test(id));
    const mat = planted ? grass : style[feature.kind];
    if (!mat) throw new Error(`Unknown frontage surface: ${feature.kind}`);
    const layout = createRoadPolygonLayout(feature, terrain);
    for (const chunk of layout.chunks) {
      const positions = chunk.positions;
      if (feature.riseM) for (let i = 1; i < positions.length; i += 3) positions[i] += feature.riseM;
      const mesh = polygonMesh(positions, chunk.origin, mat, chunk.id);
      mesh.userData.sourceIds = feature.sourceIds;
      if (planted) mesh.userData.planting = {
        form: corridor.medianSource.planting ?? 'open-lawn-and-low-flower-beds', positionSource: 'visual-estimate'
      };
      mesh.userData.heightSource = feature.riseM ? 'terrain-relative-design-estimate' : 'terrain';
      group.add(mesh);
    }
    if (feature.riseM) {
      const sample = createRoadHeightSampler(layout.chunks, terrain.grid);
      samplers.push(sample);
      if (planted) medianSamplers.push({ bounds: corridor.bounds, sample });
      statistics.curbTriangles += addCurbWalls(group, feature, groundHeight, walls);
    }
    statistics.triangleCount += layout.statistics.triangles;
  }
  statistics.curbSegments = statistics.curbTriangles / 2;
  function shennanMedianHeight(x, z) {
    for (const { bounds: [x0, z0, x1, z1], sample } of medianSamplers) {
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const y = sample(x, z);
      if (y !== null) return y;
    }
    return null;
  }
  function contactHeight(x, z) {
    if (!source.corridors.some(({ bounds }) => x >= bounds[0] && x <= bounds[2] && z >= bounds[1] && z <= bounds[3])) return null;
    let y = null;
    for (const sample of samplers) {
      const next = sample(x, z);
      if (next !== null) y = y === null ? next : Math.max(y, next);
    }
    return y;
  }
  const hardware = signalHardware(group, control, (x, z) => contactHeight(x, z) ?? groundHeight(x, z), roadHeight);
  statistics.signals = hardware.origins.length;
  const sites = source.shrubSites ?? [];
  statistics.shrubs = addMedianShrubs(group, sites.filter(([x, z]) => shennanMedianHeight(x, z) === null), contactHeight);
  statistics.shennanFlowerBeds = addShennanFlowerBeds(group, sites, shennanMedianHeight, flowers);
  scene.add(group);
  return { group, control, contactHeight, shennanMedianHeight, colliders: hardware.colliders, signalOrigins: hardware.origins, statistics,
    detailedRoadIds: [...new Set(source.corridors.flatMap(row => row.roadIds))], update: hardware.update,
    dispose() {
      group.removeFromParent();
      const geometries = new Set(), materials = new Set([...Object.values(style), walls, grass, flowers]);
      group.traverse(mesh => {
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        materials.add(mesh.material);
        if (mesh.isInstancedMesh) mesh.dispose();
      });
      for (const geometry of geometries) geometry.dispose();
      for (const mat of materials) mat.dispose();
    }
  };
}
