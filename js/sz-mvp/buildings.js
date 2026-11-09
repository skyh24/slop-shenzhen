import * as THREE from 'three/webgpu';
import { decodePoly } from './data.js';
import { GeoBuilder, addFlatPolygon, addWalls } from './geometry.js';
import { createBuildingMaterial } from './materials.js';

const CHUNK = 1000;
const TALL = 150;

function hash01(i) {
  let h = (i * 2654435761) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  return (h >>> 8) / 16777216;
}

// 按 1 公里分块合并建筑，交给视锥剔除；返回分块和地标最高点
export function buildBuildings(data, skip = () => false) {
  const B = data.buildings;
  const chunks = new Map();
  const landmarkTops = new Map();
  for (let i = 0; i < B.h.length; i++) {
    if (skip(i)) continue;
    const rings = decodePoly(B.rings[i]);
    const outer = rings[0];
    if (outer.length < 6) continue;
    const cx = outer[0], cz = outer[1];
    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    let b = chunks.get(key);
    if (!b) chunks.set(key, (b = new GeoBuilder(true)));
    const h = B.h[i];
    const y0 = Math.max(0, B.minH[i]);
    const meta = [B.facade[i], hash01(i) * 10, h >= TALL ? 1 : 0, h];
    addWalls(b, rings, y0, h, meta);
    addFlatPolygon(b, rings, h, meta);
    const lm = B.lm[i];
    if (lm >= 0) {
      const prev = landmarkTops.get(lm);
      if (!prev || h > prev.h) landmarkTops.set(lm, { h, x: cx, z: cz });
    }
  }

  const material = createBuildingMaterial({ showLandmarkLights: true });
  const group = new THREE.Group();
  group.name = 'buildings';
  for (const [key, b] of chunks) {
    const mesh = new THREE.Mesh(b.build(), material);
    mesh.name = `buildings:${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, landmarkTops };
}
