import * as THREE from 'three/webgpu';
import { GeoBuilder, addFlatPolygon, addWalls, readTriangles } from '../sz-geometry.js';

const flatten = ring => ring.flatMap(p => [p.x, p.z]);

function addBottom(batch, rings, y) {
  const firstVertex = batch.count;
  const firstIndex = batch.idx.length;
  addFlatPolygon(batch, rings, y);
  const normals = batch.nrm.data;
  for (let i = firstVertex * 3 + 1; i < batch.nrm.length; i += 3) normals[i] = -1;
  const indices = batch.idx.data;
  for (let i = firstIndex; i < batch.idx.length; i += 3) {
    const last = indices[i + 2];
    indices[i + 2] = indices[i + 1];
    indices[i + 1] = last;
  }
}

const quadUv = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

function faceNormal([a, b, c]) {
  const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const ac = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
  return ab.cross(ac).normalize();
}

function addFace(batch, corners, uv, normals) {
  const face = normals ? null : faceNormal(corners);
  const ids = corners.map((p, i) => {
    const n = normals ? normals[i] : face;
    return batch.vertex(p.x, p.y, p.z, n.x, n.y, n.z, ...uv[i]);
  });
  batch.tri(ids[0], ids[1], ids[2]);
  if (ids.length === 4) batch.tri(ids[0], ids[2], ids[3]);
}

function addSpan(batch, part) {
  const points = part.polygon.outer;
  const low = points.map((p, i) => ({ ...p, y: part.bottom[i] }));
  const high = points.map((p, i) => ({ ...p, y: part.top[i] }));
  const w = Math.hypot(points[0].x - points[1].x, points[0].z - points[1].z);
  const h = Math.hypot(points[0].x - points[3].x, points[0].z - points[3].z);
  addFace(batch, [...low].reverse(), quadUv(w, h));
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    addFace(batch, [low[i], low[j], high[j], high[i]],
      quadUv(Math.hypot(low[i].x - low[j].x, low[i].z - low[j].z), high[i].y - low[i].y));
  }
  const firstIndex = batch.idx.length;
  addFace(batch, high, quadUv(w, h));
  return part.roofContact ? readTriangles(batch, firstIndex) : null;
}

function addLoft(batch, part) {
  const { lower, upper, minY, maxY } = part.loft;
  const skin = part.loftSkin;
  if (part.bottomFace !== false && skin?.bottom !== false) addBottom(batch, [flatten(lower)], minY);
  const y0 = minY - part.uvOriginY;
  const y1 = maxY - part.uvOriginY;
  const sides = lower.map((p, i) => {
    const j = (i + 1) % lower.length;
    return [{ ...p, y: minY }, { ...upper[i], y: maxY }, { ...upper[j], y: maxY }, { ...lower[j], y: minY }];
  });
  const faceNormals = part.smoothSides && !skin ? sides.map(faceNormal) : null;
  const smooth = faceNormals?.map((n, i) => n.clone().add(faceNormals[(i - 1 + lower.length) % lower.length]).normalize());
  let u0 = 0, u1 = 0;
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    const lowWidth = Math.hypot(lower[j].x - lower[i].x, lower[j].z - lower[i].z);
    const highWidth = Math.hypot(upper[j].x - upper[i].x, upper[j].z - upper[i].z);
    const coords = skin ? [[skin.u[i], skin.v[0]], [skin.u[i], skin.v[1]],
      [skin.u[i + 1], skin.v[1]], [skin.u[i + 1], skin.v[0]]]
      : [[u0, y0], [u1, y1], [u1 + highWidth, y1], [u0 + lowWidth, y0]];
    const normals = skin ? [skin.lower[i], skin.upper[i], skin.upper[j], skin.lower[j]]
      : smooth && [smooth[i], smooth[i], smooth[j], smooth[j]];
    addFace(batch, sides[i], coords, normals);
    u0 += lowWidth;
    u1 += highWidth;
  }
  if (part.topFace === false || (skin?.top === false && !part.roofContact)) return null;
  const firstIndex = batch.idx.length;
  addFlatPolygon(batch, [flatten(upper)], maxY);
  return part.roofContact ? readTriangles(batch, firstIndex) : null;
}

function addRoofPanel(batch, part) {
  const { outer, bottom, top } = part.roofPanel;
  const skin = part.roofSkin;
  const low = outer.map((p, i) => ({ ...p, y: bottom[i] }));
  const high = outer.map((p, i) => ({ ...p, y: top[i] }));
  const uv = vertices => vertices.map(p => [p.x, p.z]);
  addFace(batch, low, uv(low));
  for (let i = 0; i < 3; i++) {
    if (skin && !skin.walls[i]) continue;
    const j = (i + 1) % 3;
    addFace(batch, [low[i], high[i], high[j], low[j]], quadUv(part.top[i] - part.bottom[i],
      Math.hypot(outer[i].x - outer[j].x, outer[i].z - outer[j].z)));
  }
  const firstIndex = batch.idx.length;
  high.reverse();
  addFace(batch, high, skin ? [...skin.uv].reverse() : uv(high), skin ? [...skin.normals].reverse() : null);
  return part.roofContact ? readTriangles(batch, firstIndex) : null;
}

export function addLandmarkPart(batch, part) {
  if (part.loft) return addLoft(batch, part);
  if (part.roofPanel) return addRoofPanel(batch, part);
  if (Array.isArray(part.top)) return addSpan(batch, part);
  const rings = [part.polygon.outer, ...part.polygon.holes].map(flatten);
  addWalls(batch, rings, part.minY, part.maxY, null, part.minY);
  if (part.bottomFace !== false) addBottom(batch, rings, part.minY);
  if (part.topFace === false) return null;
  const firstIndex = batch.idx.length;
  addFlatPolygon(batch, rings, part.maxY);
  return part.roofContact ? readTriangles(batch, firstIndex) : null;
}

export function renderLandmark(plan, materialFor) {
  const group = new THREE.Group();
  group.name = `ShenzhenLandmark:${plan.id}`;
  const batches = new Map();
  const surfaces = [];
  for (const part of plan.parts) {
    if (!batches.has(part.style)) batches.set(part.style, new GeoBuilder());
    // 可见实体的水平顶面可供落脚；未封顶的外壳不凭空增加平台，斜屋面保留原声明。
    const roofContact = part.topFace !== false && (part.roofContact || (!Array.isArray(part.top) && part.loftSkin?.top !== false));
    const roof = addLandmarkPart(batches.get(part.style), { ...part, roofContact });
    if (roof) surfaces.push({ id: part.id, heightSource: part.heightSource, triangles: roof, climbableFromGround: part.climbableFromGround });
  }
  for (const [style, batch] of batches) {
    const mesh = new THREE.Mesh(batch.build(), materialFor(style));
    mesh.name = style;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, surfaces };
}

// 细小而重复的金属框件只做近景，一组实例共用一个网格。实体支承仍由模型部件负责。
export function renderLandmarkTrim(items, material) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, items.length);
  const transform = new THREE.Object3D();
  for (const [i, item] of items.entries()) {
    transform.position.set(item.x, item.y, item.z);
    transform.scale.set(...item.size);
    transform.rotation.set(item.pitch ?? 0, item.yaw ?? 0, 0, 'YXZ');
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
  }
  mesh.name = 'LandmarkCloseTrim';
  mesh.userData.cullDistance = 140;
  mesh.userData.localInstanceCull = true;
  return mesh;
}
