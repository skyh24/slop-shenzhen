import * as THREE from 'three/webgpu';
import { GEO, REAL_BUILDINGS, CITY_PAYLOAD } from './sz-geodata.js';
import { GeoBuilder, addWalls, addFlatPolygon } from './sz-geometry.js';
import { createBuildingMaterial } from './sz-materials.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';

export const BUILDING_RENDER_CHUNK_SIZE = 1000;
const flatRing = ring => ring.flatMap(p => [p.x, p.z]);

export function buildCityBlocks(scene, options = {}) {
  const buildings = options.buildings ?? REAL_BUILDINGS;
  const terrain = options.terrain ?? GEO.terrain;
  const skipIds = options.skipIds ?? new Set();
  const renderChunkSize = options.renderChunkSize ?? BUILDING_RENDER_CHUNK_SIZE;
  const group = new THREE.Group();
  group.name = 'ShenzhenCityBlocks';
  const batches = new Map();
  const colliders = [];
  const allBlocks = [];
  for (const building of buildings) {
    if (skipIds.has(building.id)) continue;
    const placement = buildingPlacement(building, terrain);
    const key = `${Math.floor(building.cx / renderChunkSize)},${Math.floor(building.cz / renderChunkSize)}`;
    if (!batches.has(key)) batches.set(key, new GeoBuilder(true));
    const batch = batches.get(key);
    const facade = CITY_PAYLOAD.enums.facade.indexOf(building.facade);
    if (facade < 0) throw new Error(`Unknown building facade: ${building.facade}`);
    // 普通超高层不自动套同一种灯光秀，地标灯光由各自模型负责。
    const meta = [facade, buildingSeed(building.id) * 10, 0, building.height];
    for (const polygon of building.polygons) {
      const rings = [polygon.outer, ...polygon.holes].map(flatRing);
      addWalls(batch, rings, placement.minY, placement.maxY, meta, placement.baseY);
      addFlatPolygon(batch, rings, placement.maxY, meta);
    }
    colliders.push(...placement.colliders);
    allBlocks.push({ ...building, baseY: placement.baseY, minY: placement.minY, maxY: placement.maxY });
  }
  const material = createBuildingMaterial();
  for (const [key, batch] of batches) {
    const mesh = new THREE.Mesh(batch.build(), material);
    mesh.name = `ShenzhenBuildings:${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  scene.add(group);
  return { group, colliders, allBlocks, update() {},
    dispose() {
      group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      material.dispose();
      scene.remove(group);
    }
  };
}
