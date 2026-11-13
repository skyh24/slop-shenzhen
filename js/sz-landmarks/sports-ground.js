import * as THREE from 'three/webgpu';
import { GeoBuilder, triangulateFootprint } from '../sz-geometry.js';

// 场地只换地面的外观：把草地、跑道和白线裁到正式地面三角面上。
// 顶点沿原三角面插值，不另设一套接触高度，也不覆盖道路的几何或碰撞。
const rank = {
  sportsApron: 0, sportsInfield: 1, sportsTrack: 1,
  sportsTurf: 2, sportsTurfLight: 2, sportsTrackLine: 3, sportsPitchLine: 3
};
const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const bounds = ring => [Math.min(...ring.map(p => p.x)), Math.min(...ring.map(p => p.z)),
  Math.max(...ring.map(p => p.x)), Math.max(...ring.map(p => p.z))];
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function clip(ground, mask) {
  let ring = ground;
  for (let i = 0; i < 3 && ring.length; i++) {
    const a = mask[i], b = mask[(i + 1) % 3];
    const next = [];
    for (let j = 0; j < ring.length; j++) {
      const p = ring[j], q = ring[(j + 1) % ring.length], pd = cross(a, b, p), qd = cross(a, b, q);
      if (pd >= 0) next.push(p);
      if ((pd < 0 && qd > 0) || (pd > 0 && qd < 0)) {
        const t = pd / (pd - qd);
        next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
      }
    }
    ring = next;
  }
  return ring;
}

function venueTriangles(surface, area) {
  const { grid, chunkSize } = surface;
  const result = [];
  for (const chunk of surface.chunks) {
    const [ox, oz] = chunk.origin;
    if (!overlaps(area, [ox - grid.step, oz - grid.step, ox + chunkSize + grid.step, oz + chunkSize + grid.step])) continue;
    const { positions, indices } = chunk;
    for (let j = 0; j < indices.length; j += 3) {
      const points = [0, 1, 2].map(i => {
        const k = indices[j + i] * 3;
        return { x: ox + positions[k], y: positions[k + 1], z: oz + positions[k + 2] };
      });
      const extent = bounds(points);
      if (overlaps(area, extent) && Math.abs(cross(...points)) > 1e-7) result.push({ points, extent });
    }
  }
  return result;
}

export function planSportsGround(patches, surface) {
  if (!patches.length || !surface) return [];
  const ground = venueTriangles(surface, bounds(patches.flatMap(p => p.ring)));
  const result = [];
  for (const { ring, style } of patches) {
    for (const triangle of triangulateFootprint({ outer: ring })) {
      const extent = bounds(triangle);
      for (const { points, extent: groundBounds } of ground) {
        if (!overlaps(extent, groundBounds)) continue;
        const clipped = clip(points, triangle);
        for (let i = 2; i < clipped.length; i++) {
          const a = clipped[0], b = clipped[i - 1], c = clipped[i];
          const area = cross(a, b, c);
          if (Math.abs(area) < 1e-7) continue;
          result.push({ style, points: area < 0 ? [a, b, c] : [a, c, b] });
        }
      }
    }
  }
  return result;
}

export function addSportsGround(group, patches, surface, materialFor) {
  const batches = new Map();
  for (const { style, points } of planSportsGround(patches, surface)) {
    if (!batches.has(style)) batches.set(style, new GeoBuilder());
    const batch = batches.get(style);
    const [a, b, c] = points;
    const normal = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z)
      .cross(new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z)).normalize();
    batch.tri(...points.map(p => batch.vertex(p.x, p.y, p.z, normal.x, normal.y, normal.z, p.x, p.z)));
  }
  for (const [style, batch] of batches) {
    const mesh = new THREE.Mesh(batch.build(), materialFor(style));
    mesh.name = style;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1 + rank[style];
    group.add(mesh);
  }
}
