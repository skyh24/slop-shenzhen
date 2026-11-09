import * as THREE from 'three/webgpu';
import { GeoBuilder, addFlatPolygon, addWalls } from '../sz-geometry.js';

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

function readTriangles(batch, firstIndex) {
  const triangles = [];
  const vertices = batch.pos.data;
  const indices = batch.idx.data;
  for (let i = firstIndex; i < batch.idx.length; i += 3) {
    const tri = [];
    for (let j = i; j < i + 3; j++) {
      const offset = indices[j] * 3;
      tri.push({ x: vertices[offset], y: vertices[offset + 1], z: vertices[offset + 2] });
    }
    triangles.push(tri);
  }
  return triangles;
}

const quadUv = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

function addFace(batch, corners, uv) {
  const [a, b, c] = corners;
  const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const ac = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
  const n = ab.cross(ac).normalize();
  const ids = corners.map((p, i) => batch.vertex(p.x, p.y, p.z, n.x, n.y, n.z, ...uv[i]));
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
  addBottom(batch, [flatten(lower)], minY);
  const y0 = minY - part.uvOriginY;
  const y1 = maxY - part.uvOriginY;
  let u0 = 0, u1 = 0;
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    const lowWidth = Math.hypot(lower[j].x - lower[i].x, lower[j].z - lower[i].z);
    const highWidth = Math.hypot(upper[j].x - upper[i].x, upper[j].z - upper[i].z);
    addFace(batch, [{ ...lower[i], y: minY }, { ...upper[i], y: maxY }, { ...upper[j], y: maxY }, { ...lower[j], y: minY }],
      [[u0, y0], [u1, y1], [u1 + highWidth, y1], [u0 + lowWidth, y0]]);
    u0 += lowWidth;
    u1 += highWidth;
  }
  const firstIndex = batch.idx.length;
  addFlatPolygon(batch, [flatten(upper)], maxY);
  return part.roofContact ? readTriangles(batch, firstIndex) : null;
}

function addRoofPanel(batch, part) {
  const { outer, bottom, top } = part.roofPanel;
  const low = outer.map((p, i) => ({ ...p, y: bottom[i] }));
  const high = outer.map((p, i) => ({ ...p, y: top[i] }));
  const uv = vertices => vertices.map(p => [p.x, p.z]);
  addFace(batch, low, uv(low));
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    addFace(batch, [low[i], high[i], high[j], low[j]], quadUv(part.top[i] - part.bottom[i],
      Math.hypot(outer[i].x - outer[j].x, outer[i].z - outer[j].z)));
  }
  const firstIndex = batch.idx.length;
  high.reverse();
  addFace(batch, high, uv(high));
  return part.roofContact ? readTriangles(batch, firstIndex) : null;
}

export function addLandmarkPart(batch, part) {
  if (part.loft) return addLoft(batch, part);
  if (part.roofPanel) return addRoofPanel(batch, part);
  if (Array.isArray(part.top)) return addSpan(batch, part);
  const rings = [part.polygon.outer, ...part.polygon.holes].map(flatten);
  addWalls(batch, rings, part.minY, part.maxY, null, part.minY);
  addBottom(batch, rings, part.minY);
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
    const roof = addLandmarkPart(batches.get(part.style), part);
    if (roof) surfaces.push({ id: part.id, heightSource: part.heightSource, triangles: roof });
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
