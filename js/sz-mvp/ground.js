import * as THREE from 'three/webgpu';
import { decodePoly, decodeRing } from './data.js';
import { GeoBuilder, addFlatPolygon, addRibbon } from './geometry.js';
import { createGroundMaterial, createRoadMaterial, createWaterMaterial } from './materials.js';

// 叠放高度：海面 < 陆地 < 湿地 < 绿地 < 湖面 < 道路，避免深度冲突
const Y = { sea: -0.6, far: -0.3, land: 0, wetland: 0.04, green: 0.06, water: 0.08, road: 0.12 };
const ROAD_Y_STEP = 0.015;

function flatLayer(polys, y, material, name) {
  const b = new GeoBuilder();
  for (const rings of polys) addFlatPolygon(b, decodePoly(rings), y);
  const mesh = new THREE.Mesh(b.build(), material);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildGround(data) {
  const group = new THREE.Group();
  group.name = 'ground';
  const [minx, minz, maxx, maxz] = data.bounds;
  const pad = 30000;

  const water = createWaterMaterial();
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(maxx - minx + pad * 2, maxz - minz + pad * 2), water);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set((minx + maxx) / 2, Y.sea, (minz + maxz) / 2);
  sea.name = 'sea';
  group.add(sea);

  group.add(flatLayer(data.farLand, Y.far, createGroundMaterial(0x8f9a84), 'farLand'));
  group.add(flatLayer(data.land, Y.land, createGroundMaterial(0xb9b6ad), 'land'));
  group.add(flatLayer(data.wetland, Y.wetland, createGroundMaterial(0x3f6a45), 'mangrove'));
  group.add(flatLayer(data.green, Y.green, createGroundMaterial(0x6f9a5a), 'green'));
  group.add(flatLayer(data.water, Y.water, water, 'lakes'));

  const roads = data.roads;
  const b = new GeoBuilder(true);
  const order = roads.cls.map((c, i) => i).sort((a, c) => roads.cls[c] - roads.cls[a]);
  for (const i of order) {
    const cls = roads.cls[i];
    const y = Y.road + (8 - cls) * ROAD_Y_STEP;
    addRibbon(b, decodeRing(roads.pts[i]), roads.width[i], y, [roads.width[i], cls, 0, 0]);
  }
  const roadMesh = new THREE.Mesh(b.build(), createRoadMaterial());
  roadMesh.name = 'roads';
  roadMesh.receiveShadow = true;
  group.add(roadMesh);
  return group;
}
