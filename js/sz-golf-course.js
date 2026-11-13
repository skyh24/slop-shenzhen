import * as THREE from 'three/webgpu';
import { addFlatPolygon, GeoBuilder } from './sz-geometry.js';
import { createPavingMaterial, pavingMesh } from './sz-paving.js';
import { createRoadHeightSampler, createRoadPolygonLayout } from './sz-roads.js';

const PAVING = { paved: ['concrete', { color: 0x9b9485, tileSizeM: null, roughness: 0.95 }], aggregate: ['park-gravel'] };

function addBank(batch, ring, level) {
  for (let i = 0; i < ring.length; i += 3) {
    const j = (i + 3) % ring.length;
    const [x0, y0, z0] = ring.slice(i, i + 3);
    const [x1, y1, z1] = ring.slice(j, j + 3);
    const dx = x1 - x0, dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) continue;
    const nx = -dz / length, nz = dx / length;
    const top0 = batch.vertex(x0, y0, z0, nx, 0, nz, 0, 1);
    const top1 = batch.vertex(x1, y1, z1, nx, 0, nz, 1, 1);
    const low0 = batch.vertex(x0, level, z0, nx, 0, nz, 0, 0);
    const low1 = batch.vertex(x1, level, z1, nx, 0, nz, 1, 0);
    batch.tri(top0, top1, low0);
    batch.tri(low0, top1, low1);
  }
}

export function buildSzGolfCourse(scene, source, terrain) {
  if (!source) return null;
  const group = new THREE.Group();
  group.name = 'shenzhen-former-golf-course';
  const materials = [];
  const meshFor = (geometry, material, name) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // 按实际地面三角面裁出共面铺装。园路的高度与脚底接触面完全共用。
  const paving = new Map();
  const samplers = source.surfaces.map(feature => {
    const layout = createRoadPolygonLayout(feature, terrain);
    const { material } = feature;
    if (!paving.has(material)) paving.set(material, createPavingMaterial(...PAVING[material]));
    for (const { id, positions, origin } of layout.chunks) group.add(pavingMesh(positions, origin, paving.get(material), id));
    return createRoadHeightSampler(layout.chunks, terrain.grid);
  });

  const water = new GeoBuilder();
  const banks = new GeoBuilder();
  for (const { polygon, heightM, banks: shore } of source.ponds) {
    const rings = [polygon.outer, ...polygon.holes];
    addFlatPolygon(water, rings.map(ring => ring.flatMap(({ x, z }) => [x, z])), heightM);
    for (const ring of shore) addBank(banks, ring, heightM);
  }
  const pondMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x365b64, roughness: 0.29, metalness: 0.14 });
  const bankMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x67704e, roughness: 0.96, side: THREE.DoubleSide });
  materials.push(pondMaterial, bankMaterial);
  meshFor(water.build(), pondMaterial, 'golf-course-ponds');
  meshFor(banks.build(), bankMaterial, 'golf-course-pond-banks');

  scene.add(group);
  return { group, pathAt: (x, z) => samplers.some(sample => sample(x, z) !== null),
    dispose() {
      group.removeFromParent();
      for (const mesh of group.children) mesh.geometry.dispose();
      for (const material of [...materials, ...paving.values()]) material.dispose();
    }
  };
}
