import * as THREE from 'three/webgpu';
import { GEO, REAL_BUILDINGS, CITY_PAYLOAD } from './sz-geodata.js';
import { GeoBuilder, addWalls, addFlatPolygon } from './sz-geometry.js';
import { createBuildingMaterial } from './sz-materials.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';

export const BUILDING_RENDER_CHUNK_SIZE = 1000;
// 普通高层按“塔楼 + 裙房”两级表达：裙房由塔楼足迹向外放大生成，是显示估计，
// 不是测绘裙房；高度取 16% 塔高并封顶 20 m，裙房碰撞体与显示共用同一轮廓。
const PODIUM_MIN_TOWER_HEIGHT_M = 100;
const PODIUM_MIN_AREA_M2 = 1500;
const PODIUM_EXPAND_FRACTION = 0.16;
const PODIUM_EXPAND_MIN_M = 4;
const PODIUM_EXPAND_MAX_M = 9;
const PODIUM_HEIGHT_FRACTION = 0.16;
const PODIUM_HEIGHT_MAX_M = 20;
const PODIUM_MIN_HEIGHT_M = 6;
const flatRing = ring => ring.flatMap(p => [p.x, p.z]);

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].z - ring[i].z);
  }
  return Math.abs(area) / 2;
}

function expandRing(ring, expand) {
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p.x; cz += p.z; }
  cx /= ring.length; cz /= ring.length;
  const radius = Math.sqrt(ringArea(ring) / Math.PI);
  const scale = 1 + expand / Math.max(radius, 6);
  return ring.map(p => ({ x: cx + (p.x - cx) * scale, z: cz + (p.z - cz) * scale }));
}

function podiumPlan(building) {
  if (building.minHeight > 0 || building.height < PODIUM_MIN_TOWER_HEIGHT_M) return null;
  const polygon = building.polygons[0];
  if (!polygon) return null;
  const area = ringArea(polygon.outer);
  if (area < PODIUM_MIN_AREA_M2) return null;
  const expand = Math.min(PODIUM_EXPAND_MAX_M, Math.max(PODIUM_EXPAND_MIN_M,
    Math.sqrt(area) * PODIUM_EXPAND_FRACTION));
  const top = Math.min(PODIUM_HEIGHT_MAX_M, Math.max(PODIUM_MIN_HEIGHT_M,
    building.height * PODIUM_HEIGHT_FRACTION));
  if (building.height - top < 30) return null;
  return { outer: expandRing(polygon.outer, expand), holes: polygon.holes ?? [], height: top };
}

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
      if (building.minHeight > 0) addFlatPolygon(batch, rings, placement.minY, meta, 1, -1);
    }
    colliders.push(...placement.colliders);
    const podium = podiumPlan(building);
    if (podium) {
      const rings = [podium.outer, ...podium.holes].map(flatRing);
      const top = placement.minY + podium.height;
      addWalls(batch, rings, placement.minY, top, meta, placement.baseY);
      addFlatPolygon(batch, rings, top, meta);
      colliders.push({
        type: 'building-podium', name: `${building.id}:podium`, sourceId: building.id,
        polygon: { outer: podium.outer, holes: podium.holes },
        minX: Math.min(...podium.outer.map(p => p.x)), maxX: Math.max(...podium.outer.map(p => p.x)),
        minZ: Math.min(...podium.outer.map(p => p.z)), maxZ: Math.max(...podium.outer.map(p => p.z)),
        minY: placement.minY, maxY: top, heightSource: 'estimate', baseSource: 'dem-footprint-bounds-center'
      });
      allBlocks.push({ ...building, id: `${building.id}:podium`, isPodium: true,
        baseY: placement.baseY, minY: placement.minY, maxY: top });
    }
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
