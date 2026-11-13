import * as THREE from 'three/webgpu';
import { color, floor, fract, fwidth, max, min, mix, smoothstep, uv, vec2 } from 'three/tsl';
import { GeoBuilder } from '../sz-geometry.js';
import { canvasTexture } from '../sz-mesh-utils.js';
import { sceneUniforms } from '../sz-materials.js';
import { addLandmarkPart } from '../sz-landmarks/render.js';
import { partCollider } from '../sz-landmarks/parts.js';
import { orientedBoxRing } from '../sz-polygon.js';

const PALETTE = {
  ivory: 0xe5dfcf, loft: 0xd3cfc2, chalk: 0xeae8de, concrete: 0x9d998b,
  tan: 0xb09b7d, brick: 0x986853, oldBrick: 0x736d64, granite: 0x968c79,
  stone: 0xc0b7a2, steel: 0x343f40, silver: 0xa7b2b1, blue: 0x395c70,
  green: 0x49624d, terra: 0xb46443, brass: 0xbc955a, wood: 0x906048,
  glass: 0x344c53, lamp: 0xd2ad78, aqua: 0x359ca0, white: 0xf4f1e8,
  hull: 0xf0eee4, waterline: 0x883d30, navy: 0x273943, orange: 0xc97443,
  roof: 0x695e55, tile: 0x8d6755, leaf: 0x638044, soil: 0x504233,
  blossom: 0xcd6e6a, goldFlower: 0xe9b565, darkGlass: 0x344c53
};

const MASONRY = {
  brick: [0.25, 0.082, 0xaea093], oldBrick: [0.32, 0.115, 0x9b8f7a],
  granite: [0.86, 0.36, 0x685f54], tile: [0.19, 0.30, 0x604e43]
};

const bounds = ring => ({
  minX: Math.min(...ring.map(p => p.x)), maxX: Math.max(...ring.map(p => p.x)),
  minZ: Math.min(...ring.map(p => p.z)), maxZ: Math.max(...ring.map(p => p.z))
});

export const point = ([x, z]) => ({ x, z });
export function polygon(points) { return { outer: points.map(point), holes: [] }; }
export function frame(x, z, dx, dz) {
  const n = Math.hypot(dx, dz);
  const c = dx / n, s = dz / n;
  return { c, s, at: (u, v) => ({ x: x + c * u - s * v, z: z + s * u + c * v }) };
}

export function solid(id, source, polygon, minY, maxY, style, layoutSource = 'scene-design') {
  return { id, sourceId: source.id, sourceHeight: source.height, sourceHeightSource: source.heightSource,
    heightSource: layoutSource === 'osm-footprint' ? source.heightSource : 'estimate',
    layoutSource, polygon, minY, maxY, style, ...bounds(polygon.outer) };
}

function makeMaterial(style) {
  const material = new THREE.MeshStandardNodeMaterial({
    color: PALETTE[style], roughness: style === 'aqua' ? 0.26 : style === 'glass' ? 0.37 : 0.81,
    metalness: ['silver', 'steel', 'brass'].includes(style) ? 0.18 : 0
  });
  if (style === 'glass' || style === 'lamp') {
    material.emissiveNode = color(style === 'glass' ? 0xca9b58 : 0xffce85)
      .mul(sceneUniforms.night).mul(style === 'glass' ? 0.32 : 1.15);
  }
  if (MASONRY[style]) {
    const [w, h, mortar] = MASONRY[style];
    const grid = uv().div(vec2(w, h));
    const v = fract(grid.y);
    const u = fract(grid.x.add(floor(grid.y).mul(0.5)));
    const px = max(fwidth(grid.x), fwidth(grid.y));
    const d = min(min(u, u.oneMinus()), min(v, v.oneMinus()));
    const seam = smoothstep(0.025, 0.066, d).oneMinus().mul(smoothstep(0.16, 0.5, px).oneMinus());
    material.colorNode = mix(color(PALETTE[style]), color(mortar), seam.mul(0.56));
  }
  return material;
}

// 实体与碰撞同用一个部件；小件共享实例网格，远处关闭纯装饰，不切换实体碰撞。
export function createDistrictKit(root) {
  const materials = new Map();
  const labels = new Map();
  const geometries = {
    box: new THREE.BoxGeometry(1, 1, 1),
    label: new THREE.PlaneGeometry(1, 1),
    disc: new THREE.CylinderGeometry(0.5, 0.5, 1, 16).rotateX(Math.PI / 2),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 16)
  };
  const materialFor = style => {
    if (!materials.has(style)) materials.set(style, makeMaterial(style));
    return materials.get(style);
  };
  const updates = [];
  const extras = [];
  const lights = [];
  const pose = new THREE.Object3D();
  function district(id, focus) {
    const group = new THREE.Group(), near = new THREE.Group();
    group.name = id;
    near.name = `${id}:detail`;
    root.add(group);
    group.add(near);
    updates.push({ near, focus });
    const batches = new Map(), instances = new Map(), colliders = [];
    const labelBatches = new Map();
    let nextId = 0;
    function part(row, collide = true) {
      if (!batches.has(row.style)) batches.set(row.style, new GeoBuilder());
      addLandmarkPart(batches.get(row.style), row);
      if (collide) colliders.push(partCollider(row));
      return row;
    }
    function piece(p, y, w, h, d, f, style, { detail = true, shape = 'box', roll = 0 } = {}) {
      const key = `${style}:${shape}:${detail}`;
      if (!instances.has(key)) instances.set(key, { style, shape, detail, matrices: [] });
      pose.position.set(p.x, y, p.z);
      pose.rotation.set(0, -Math.atan2(f.s, f.c), roll, 'YXZ');
      pose.scale.set(w, h, d);
      pose.updateMatrix();
      instances.get(key).matrices.push(pose.matrix.clone());
    }
    function box(p, bottom, top, w, d, f, style, source, id) {
      const poly = { outer: orientedBoxRing(p.x, p.z, w, d, f.c, f.s), holes: [] };
      return part(solid(id ?? `${group.name}:solid:${nextId++}`, source, poly, bottom, top, style));
    }
    function label(p, y, width, height, f, text, ink = '#eee5d0', background = '#343e3b', detail = false) {
      const key = `${ink}:${background}:${text}`;
      if (!labels.has(key)) {
        const map = canvasTexture(512, 128, (ctx, w, h) => {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = ink;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = '700 76px system-ui, sans-serif';
          ctx.fillText(text, w / 2, h / 2 + 4, w * 0.94);
        });
        const material = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.9 });
        labels.set(key, material);
        extras.push({ map, material });
      }
      const material = labels.get(key);
      if (detail) {
        if (!labelBatches.has(material)) labelBatches.set(material, []);
        pose.position.set(p.x, y, p.z);
        pose.rotation.set(0, -Math.atan2(f.s, f.c), 0);
        pose.scale.set(width, height, 1);
        pose.updateMatrix();
        labelBatches.get(material).push(pose.matrix.clone());
        return;
      }
      const mesh = new THREE.Mesh(geometries.label, material);
      mesh.scale.set(width, height, 1);
      mesh.position.set(p.x, y, p.z);
      mesh.rotation.y = -Math.atan2(f.s, f.c);
      group.add(mesh);
    }
    function lamp(p, y, strength = 34, range = 12) {
      const light = new THREE.PointLight(0xffd6a0, 0, range, 2);
      light.position.set(p.x, y, p.z);
      light.visible = false;
      lights.push({ light, strength });
      group.add(light);
    }
    function finish() {
      for (const [material, matrices] of labelBatches) {
        const mesh = new THREE.InstancedMesh(geometries.label, material, matrices.length);
        for (const [index, matrix] of matrices.entries()) mesh.setMatrixAt(index, matrix);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        near.add(mesh);
        extras.push({ mesh });
      }
      for (const [style, batch] of batches) {
        const geometry = batch.build();
        const mesh = new THREE.Mesh(geometry, materialFor(style));
        mesh.name = `${id}:${style}`;
        mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh);
        extras.push({ geometry });
      }
      for (const { style, shape, detail, matrices } of instances.values()) {
        const mesh = new THREE.InstancedMesh(geometries[shape], materialFor(style), matrices.length);
        for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.receiveShadow = true;
        (detail ? near : group).add(mesh);
        extras.push({ mesh });
      }
    }
    return { group, part, piece, box, label, lamp, colliders, finish };
  }
  let lightingFocus = null;
  return { district, update(camera) {
    for (const { focus, near } of updates) {
      const distance = Math.hypot(camera.x - focus.x, camera.y - (focus.y ?? 8), camera.z - focus.z);
      near.visible = distance < (near.visible ? 375 : 345);
    }
    const night = sceneUniforms.night.value;
    const lit = night >= 0.05;
    if (lightingFocus && lightingFocus.lit === lit && Math.abs(night - lightingFocus.night) < 0.025
      && Math.hypot(camera.x - lightingFocus.x, camera.y - lightingFocus.y, camera.z - lightingFocus.z) < 5) return;
    lightingFocus = { x: camera.x, y: camera.y, z: camera.z, night, lit };
    if (!lit) {
      for (const { light } of lights) light.visible = false;
      return;
    }
    const distance = ({ light }) => light.position.distanceToSquared(camera);
    const active = new Set(lights.filter(row => distance(row) < 145 ** 2)
      .sort((a, b) => distance(a) - distance(b)).slice(0, 16));
    for (const row of lights) {
      row.light.visible = active.has(row);
      row.light.intensity = row.strength * night;
    }
  }, dispose() {
    root.removeFromParent();
    for (const { geometry, material, map, mesh } of extras) {
      geometry?.dispose(); material?.dispose(); map?.dispose(); mesh?.dispose();
    }
    for (const material of materials.values()) material.dispose();
    for (const geometry of Object.values(geometries)) geometry.dispose();
  } };
}

export function railing(kit, f, y, u0, u1, v, style = 'steel', { detail = true, height = 1.08 } = {}) {
  const length = u1 - u0;
  const count = Math.max(1, Math.ceil(length / 1.55));
  for (const level of [0.32, 0.68, 1]) {
    kit.piece(f.at((u0 + u1) / 2, v), y + height * level, length, 0.047, 0.06, f, style, { detail });
  }
  for (let i = 0; i <= count; i++) {
    kit.piece(f.at(u0 + length * i / count, v), y + height / 2, 0.068, height, 0.068, f, style, { detail });
  }
}
