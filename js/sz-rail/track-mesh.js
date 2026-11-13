import * as THREE from 'three/webgpu';
import { GeoBuilder } from '../sz-geometry.js';
import { northRailHeight } from './geometry.js';
import { partCollider, spanPart } from '../sz-landmarks/parts.js';

const railGauge = 1.435;
const unit = new THREE.BoxGeometry();
const CELL = 240;
const cellKey = p => `${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`;
const frameAt = (a, b) => {
  const l = Math.hypot(b.x - a.x, b.z - a.z);
  return { x: (b.z - a.z) / l, z: -(b.x - a.x) / l };
};
const offset = (p, n, dx, dy) => ({ x: p.x + n.x * dx, y: p.y + dy, z: p.z + n.z * dx });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

function face(batch, points) {
  const [a, b, c] = points;
  const n = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z)
    .cross(new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z)).normalize();
  const ids = points.map(p => batch.vertex(p.x, p.y, p.z, n.x, n.y, n.z, p.x, p.z));
  batch.tri(ids[0], ids[1], ids[2]); batch.tri(ids[0], ids[2], ids[3]);
}

function section(batch, a, b, na, nb, profile) {
  const cross = (p, n) => profile.map(([x, y]) => offset(p, n, x, y));
  const left = cross(a, na), right = cross(b, nb);
  for (let i = 1; i < left.length; i++) face(batch, [left[i - 1], right[i - 1], right[i], left[i]]);
}

export function buildTrackMeshes(group, data, layout) {
  const styles = {
    rail: [0x9fa7aa, 0.36, 0.55], bed: [0x625e57, 0.96, 0.03],
    tie: [0xa8a198, 0.84, 0.04], platform: [0xb5b6af, 0.84, 0.04],
    edge: [0xf1d474, 0.8, 0.03], fence: [0x65777d, 0.6, 0.12],
    wire: [0x7d8687, 0.58, 0.25], structure: [0x8b908b, 0.88, 0.04]
  };
  const materials = Object.fromEntries(Object.entries(styles).map(([key, [color, roughness, metalness]]) =>
    [key, new THREE.MeshStandardMaterial({ color, roughness, metalness, side: THREE.DoubleSide })]));
  const cells = new Map();
  const lod = [];
  const colliders = [];
  const dummy = new THREE.Object3D(), direction = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const vertexNeighbors = new Map();
  for (const { points } of layout.segments) {
    for (const [p, q] of [[points[0], points[1]], [points.at(-1), points.at(-2)]]) {
      if (!vertexNeighbors.has(p)) vertexNeighbors.set(p, []);
      vertexNeighbors.get(p).push(q);
    }
  }
  function normalAt(p, n) {
    const neighbors = vertexNeighbors.get(p);
    if (neighbors?.length !== 2) return n;
    const m = frameAt(...neighbors);
    const d = m.x * n.x + m.z * n.z;
    return Math.abs(d) < 0.85 ? n : { x: m.x / d, z: m.z / d };
  }
  function at(p) {
    const key = cellKey(p);
    if (!cells.has(key)) cells.set(key, { x: Math.floor(p.x / CELL) * CELL + CELL / 2,
      z: Math.floor(p.z / CELL) * CELL + CELL / 2, batches: new Map(), detail: new Map() });
    return cells.get(key);
  }
  function batch(p, style) {
    const { batches } = at(p);
    if (!batches.has(style)) batches.set(style, new GeoBuilder());
    return batches.get(style);
  }
  function instance(a, b, width, height, style, range) {
    const center = lerp(a, b, 0.5);
    const { detail } = at(center);
    if (!detail.has(style)) detail.set(style, { matrices: [], range });
    direction.set(b.x - a.x, b.y - a.y, b.z - a.z);
    dummy.position.set(center.x, center.y, center.z);
    dummy.scale.set(width, height, direction.length());
    dummy.quaternion.setFromUnitVectors(zAxis, direction.normalize());
    dummy.updateMatrix();
    detail.get(style).matrices.push(dummy.matrix.clone());
  }
  for (const { points, way } of layout.segments) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], mid = lerp(a, b, 0.5);
      const v = layout.along(mid);
      const n = frameAt(a, b), na = normalAt(a, n), nb = normalAt(b, n);
      // 轨顶就是列车轮缘的运动基准。
      section(batch(mid, 'bed'), a, b, na, nb, [[-2.05, -0.68], [-1.48, -0.27], [1.48, -0.27], [2.05, -0.68]]);
      for (const d of [-railGauge / 2, railGauge / 2]) section(batch(mid, 'rail'), a, b, na, nb,
        [[d - 0.046, -0.17], [d - 0.043, 0], [d + 0.043, 0], [d + 0.046, -0.17]]);
      if ((Math.abs(v) >= 380 && Math.abs(v) <= 800) || (Math.abs(v) >= 110 && Math.abs(v) < 225)) {
        const wireY = Math.abs(v) < 225 ? 5.75 : 6.45;
        section(batch(mid, 'wire'), a, b, na, nb, [[-0.017, wireY], [0.017, wireY]]);
      }
      const count = Math.max(1, Math.round(Math.hypot(a.x - b.x, a.z - b.z) / 0.64));
      for (let j = 0; j < count; j++) {
        const p = lerp(a, b, (j + 0.5) / count);
        instance(offset(p, n, -1.35, -0.225), offset(p, n, 1.35, -0.225), 0.24, 0.13, 'tie', 470);
      }
      if (Math.abs(v) > 720) {
        // 抬升段用薄支承体衔接；源桥位不加可能堵住桥下的通长实墙。
        const profile = [[-2.05, way.bridge ? -1.34 : -3.1], [-2.05, -0.68], [2.05, -0.68],
          [2.05, way.bridge ? -1.34 : -3.1]];
        section(batch(mid, 'structure'), a, b, na, nb, profile);
      }
    }
  }
  for (const { stations } of layout.platforms) {
    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1], b = stations[i];
      const point = (u, v, h) => layout.toWorld(u, v, northRailHeight(v) + h);
      const quad = (style, l0, l1, r0, r1, h0, h1) => {
        const points = [point(l0, a.v, h0), point(l1, b.v, h0), point(r1, b.v, h1), point(r0, a.v, h1)];
        face(batch(points[0], style), points);
      };
      quad('platform', a.left, b.left, a.right, b.right, 1.19, 1.19);
      for (const key of ['left', 'right']) {
        quad('platform', a[key], b[key], a[key], b[key], -0.55, 1.19);
        const d = key === 'left' ? 0.34 : -0.34;
        quad('edge', a[key], b[key], a[key] + d, b[key] + d, 1.194, 1.194);
      }
    }
  }

  const fakeSource = { id: data.stationId, heightSource: 'estimate' };
  for (const end of [-1, 1]) {
    const v = 410 * end;
    // 出站端只封闭地面行人通行；实体线栏在各股道开口保留铁路净空。
    const crossings = layout.segments.flatMap(({ points }) => points.slice(1).flatMap((p, i) => {
      const q = points[i], m = layout.along(q), n = layout.along(p);
      return Math.min(m, n) <= v && v < Math.max(m, n) ? [layout.lateral(lerp(q, p, (v - m) / (n - m)))] : [];
    })).sort((a, b) => a - b);
    for (let i = 0; i <= crossings.length; i++) {
      const l = Math.max(-108, (crossings[i - 1] ?? -111) + 2.65);
      const r = Math.min(113, (crossings[i] ?? 116) - 2.65);
      if (r - l < 0.2) continue;
      const p = layout.toWorld(l, v, 10.42), q = layout.toWorld(r, v, 10.42);
      instance({ ...p, y: 9.25 }, { ...q, y: 9.25 }, 0.09, 2.35, 'fence', 1100);
      colliders.push(partCollider(spanPart(`north:fence-end:${end}:${i}`, fakeSource, p, q, 0.09, 0.09, 2.4, 'northColumn')));
    }
  }
  for (const side of [-1, 1]) {
    // 站场两侧隔离，跨线通廊从栏网上方经过。近处看到网格，远处保留边线。
    const lateral = side > 0 ? 113 : -108;
    for (let v = -420; v < 430; v += 10) {
      const a = layout.toWorld(lateral, v, 9.2), b = layout.toWorld(lateral, v + 10, 9.2);
      const low = layout.toWorld(lateral, v, 8), high = layout.toWorld(lateral, v, 10.45);
      instance(low, high, 0.14, 0.14, 'fence', 1100);
      for (const h of [-0.62, 0.25, 1.18]) instance({ ...a, y: a.y + h }, { ...b, y: b.y + h }, 0.055, 0.055, 'fence', 1100);
      colliders.push(partCollider(spanPart(`north:fence:${side}:${v}`, fakeSource,
        { ...a, y: 10.42 }, { ...b, y: 10.42 }, 0.14, 0.14, 2.45, 'northColumn')));
    }
    // 两端只在股道扇出范围之外布杆，导线及横梁均在车体上缘之外。
    for (const end of [-1, 1]) for (let distance = 365; distance < 780; distance += 66) {
      const v = end * distance;
      const u = distance > 560 ? side * 75 : lateral;
      instance(layout.toWorld(u, v, 7.8), layout.toWorld(u, v, 15.35), 0.32, 0.28, 'wire', 1050);
      if (side === 1) instance(layout.toWorld(-u, v, 15.3), layout.toWorld(u, v, 15.3), 0.23, 0.29, 'wire', 1050);
    }
  }
  for (const { x, z, batches, detail } of cells.values()) {
    for (const [style, geometry] of batches) {
      const mesh = new THREE.Mesh(geometry.build(), materials[style]);
      mesh.name = `north:${style}`;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const [style, { matrices, range }] of detail) {
      const mesh = new THREE.InstancedMesh(unit, materials[style], matrices.length);
      mesh.name = `north:${style}`;
      matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.visible = false;
      group.add(mesh);
      lod.push({ mesh, x, z, range });
    }
  }
  return { colliders, stats: { cells: cells.size, meshes: group.children.length,
    ties: lod.filter(({ mesh }) => mesh.name === 'north:tie').reduce((n, { mesh }) => n + mesh.count, 0) },
  update(camera) {
    for (const { mesh, x, z, range } of lod) mesh.visible = (camera.x - x) ** 2 + (camera.z - z) ** 2 + (camera.y - 10) ** 2 < range ** 2;
  },
  dispose() {
    for (const mesh of group.children) if (mesh.isInstancedMesh) mesh.dispose(); else mesh.geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
  } };
}
