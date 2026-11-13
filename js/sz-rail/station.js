import * as THREE from 'three/webgpu';
import { canvasTexture } from '../sz-mesh-utils.js';
import { createPavingMaterial } from '../sz-paving.js';
import { buildPublicWalk, createWalkSweep } from '../sz-public-walk.js';
import { polygonContainsInclusive } from '../sz-polygon.js';
import { partCollider, spanPart } from '../sz-landmarks/parts.js';
import { renderLandmark } from '../sz-landmarks/render.js';
import { northRoofY } from '../sz-landmarks/shenzhen-north.js';
import { STR } from '../sz-strings.js';
import { createNorthRailLayout } from './geometry.js';
import { createRailDispatch } from './dispatch.js';
import { buildTrackMeshes } from './track-mesh.js';
import { createTrainMeshes } from './train-mesh.js';

function decodeRing(ring) {
  let x = 0, z = 0;
  const points = [];
  for (let i = 0; i < ring.length; i += 2) points.push({ x: (x += ring[i]) / 10, z: (z += ring[i + 1]) / 10 });
  return points;
}

function stationSign(group, layout) {
  const texture = canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 144px "PingFang SC", "Noto Sans CJK SC", sans-serif';
    ctx.fillStyle = '#bd292d';
    ctx.fillText(STR.hsr.north, w / 2, 94);
    ctx.font = 'bold 36px sans-serif';
    ctx.fillStyle = '#e6e7e2';
    ctx.fillText(STR.hsr.northEn.toUpperCase(), w / 2, h - 51);
  });
  const geometry = new THREE.PlaneGeometry(56, 14);
  const material = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.42, toneMapped: false });
  const direction = layout.toWorld(1, 0, 0), origin = layout.toWorld(0, 0, 0);
  for (const side of [-1, 1]) {
    const sign = new THREE.Mesh(geometry, material);
    const point = layout.toWorld(side > 0 ? 234.0 : -169.4, -9, northRoofY - 4.3);
    sign.position.set(point.x, point.y, point.z);
    sign.rotation.y = Math.atan2(side * (direction.x - origin.x), side * (direction.z - origin.z));
    group.add(sign);
  }
  return () => { texture.dispose(); geometry.dispose(); material.dispose(); };
}

function publicStructures(scene, data, layout, heightAt) {
  const paving = createPavingMaterial('light-stone', { tileSizeM: 1.9 });
  const barrier = new THREE.MeshStandardMaterial({ color: 0x68747c, roughness: 0.58 });
  const parts = [];
  for (const [role, walk] of Object.entries(data.walks)) {
    if (!['southOverpass', 'northConcourse', 'westRamp', 'eastRamp'].includes(role)) continue;
    const source = { id: walk.id, heightSource: 'estimate' };
    const points = role === 'eastRamp' ? walk.points.slice(0, 4) : walk.points;
    let distance = 0;
    const heights = role === 'northConcourse' ? points.map(() => 15.64)
      : role === 'westRamp' ? [heightAt(...points[0]) + 0.025, 15.64]
      : role === 'eastRamp' ? points.map(([x, z], i) => {
        if (i) distance += Math.hypot(x - points[i - 1][0], z - points[i - 1][1]);
        return Math.max(heightAt(x, z) + 0.025, 15.64 - distance * 0.096);
      }) : points.map(([x, z]) => {
        const u = layout.lateral({ x, z });
        if (u >= -110 && u <= 111) return 15.8;
        const distance = Math.max(0, -110 - u, u - 111);
        return Math.max(heightAt(x, z) + 0.04, 15.8 - distance * 0.175);
      });
    for (let i = 1; i < points.length; i++) {
      const [x, z] = points[i - 1], [xx, zz] = points[i];
      const a = { x, z, y: heights[i - 1] }, b = { x: xx, z: zz, y: heights[i] };
      const width = role === 'southOverpass' ? 4.4 : 7.4;
      if (Math.hypot(xx - x, zz - z) < 0.1) continue;
      parts.push(spanPart(`north:walk:${role}:${i}`, source, a, b, width, width, 0.46, 'walk', { roofContact: true }));
      const length = Math.hypot(xx - x, zz - z);
      for (const side of [-1, 1]) {
        const dx = (zz - z) / length * (width / 2 - 0.09) * side;
        const dz = -(xx - x) / length * (width / 2 - 0.09) * side;
        parts.push(spanPart(`north:guard:${role}:${i}:${side}`, source,
          { x: x + dx, z: z + dz, y: a.y + 1.14 }, { x: xx + dx, z: zz + dz, y: b.y + 1.14 },
          0.14, 0.14, 1.14, 'guard'));
      }
    }
  }
  const { group, surfaces } = renderLandmark({ id: 'north-public-bridges', parts }, style => style === 'walk' ? paving : barrier);
  scene.add(group);
  return { group, colliders: parts.map(partCollider), surfaces: surfaces.map(surface => ({ ...surface, climbableFromGround: true })),
    dispose() { for (const mesh of group.children) mesh.geometry.dispose(); paving.dispose(); barrier.dispose(); group.removeFromParent(); } };
}

export function buildNorthStation(scene, data, site) {
  if (!data) return null;
  const layout = createNorthRailLayout(data);
  const group = new THREE.Group(), tracks = new THREE.Group(), vehicles = new THREE.Group();
  group.name = 'ShenzhenNorthRail';
  group.add(tracks, vehicles);
  scene.add(group);
  const staticRail = buildTrackMeshes(tracks, data, layout);
  const dispatch = createRailDispatch(layout.routes);
  const rollingStock = createTrainMeshes(vehicles, dispatch);
  const disposeSign = stationSign(group, layout);
  const areas = Object.entries(data.plazas).map(([role, { id, rings }]) => ({
    id: `north:${role}-plaza`, kind: 'frontage', access: 'public', network: `north-${role}`, sourceIds: [id],
    polygon: { outer: decodeRing(rings[0]), holes: rings.slice(1).map(decodeRing) }
  }));
  // 东侧广场和人行线同属公共接驳层；场地标高沿项目地表，避开道路既有活动面。
  for (const role of ['eastWalk', 'eastWalkSouth']) {
    const { id, points } = data.walks[role];
    for (let i = 1; i < points.length; i++) {
      const [x, z] = points[i - 1], [xx, zz] = points[i];
      const length = Math.hypot(xx - x, zz - z);
      const dx = (zz - z) / length * 3.3, dz = -(xx - x) / length * 3.3;
      if (length <= 0.1) continue;
      areas.push({ id: `north:${role}:${i}`, kind: 'sidewalk', access: 'public', sourceIds: [id],
        polygon: { outer: [{ x: x + dx, z: z + dz }, { x: xx + dx, z: zz + dz },
          { x: xx - dx, z: zz - dz }, { x: x - dx, z: z - dz }], holes: [] } });
    }
  }
  // 补东侧图照可辨的前场开放面，足迹只覆盖两条有来源的公共通道之间的空地。
  areas.push({ id: 'north:east-forecourt', kind: 'frontage', access: 'public', network: 'north-east-front',
    sourceIds: [data.walks.eastWalk.id, data.walks.eastWalkSouth.id],
    polygon: { outer: [[234, -48], [359, -48], [359, 63], [234, 63]].map(([u, v]) => layout.toWorld(u, v)), holes: [] } });
  const walk = buildPublicWalk(scene, site.terrainSurface, areas, {
    resolve: defaults => ({ ...defaults, surfaceStyle: 'light-stone' })
  });
  function publicRoutes(colliders, carriageway) {
    const clear = createWalkSweep(walk, 'north-east-front', colliders, { contains: carriageway },
      { minX: -3005, maxX: -2825, minZ: -7590, maxZ: -7380 });
    const candidates = [[278, 290], [300, 316], [327, 342]].map(([a, b], i) => {
      const points = [layout.toWorld(a, -35), layout.toWorld(b, 50)].map(p => ({ ...p, y: walk.heightAt(p.x, p.z) }));
      if (!points.every(p => Number.isFinite(p.y)) || !clear(...points, 1.1)) return null;
      return { id: `north:forecourt-walk:${i}`, points,
        walkAt: (x, z, radius) => walk.allows(x, z, radius, 'north-east-front') };
    });
    return candidates.filter(Boolean);
  }
  const bridges = publicStructures(scene, data, layout, site.heightAt);
  group.add(walk.group, bridges.group);
  const arrival = layout.toWorld(341, 11);
  const target = layout.toWorld(65, 0);
  arrival.heading = Math.atan2(target.x - arrival.x, target.z - arrival.z);
  const inRestricted = (x, z, margin = 0) => {
    // 传送和环境步行避让站场及整个显示接入段；公共上跨由独立活动表面承载。
    const p = { x, z };
    const v = layout.along(p), u = layout.lateral(p);
    if (Math.abs(v) < 425 + margin && u > -108 - margin && u < 113 + margin) return true;
    if (v < -2300 || v > 1950 || Math.abs(u) > 160) return false;
    const reach = 2.7 + margin;
    return layout.segments.some(({ points }) => {
      const a = points[0], b = points.at(-1);
      if (x < Math.min(a.x, b.x) - reach || x > Math.max(a.x, b.x) + reach
        || z < Math.min(a.z, b.z) - reach || z > Math.max(a.z, b.z) + reach) return false;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(x - a.x - dx * t, z - a.z - dz * t) < reach;
    });
  };
  return {
    group, tracks, arrival, bridges: bridges.group, surfaces: bridges.surfaces,
    colliders: [...staticRail.colliders, ...bridges.colliders],
    heightAt: walk.heightAt, publicRoutes,
    inRestricted,
    reserves(x, z, margin) {
      return inRestricted(x, z, margin) || areas.some(({ polygon }) => polygonContainsInclusive(polygon, x, z));
    },
    update(dt, camera, audio) {
      dispatch.update(dt);
      staticRail.update(camera);
      rollingStock.update(camera, audio, dispatch.time());
    },
    snapshot() {
      return { ...dispatch.snapshot(), ...staticRail.stats, ...rollingStock.stats(),
        arrival, routeCount: layout.routes.length, platformCount: layout.platforms.length };
    },
    dispose() {
      staticRail.dispose(); rollingStock.dispose(); walk.dispose(); bridges.dispose(); disposeSign();
      group.removeFromParent();
    }
  };
}
