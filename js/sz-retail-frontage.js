import * as THREE from 'three/webgpu';
import {
  attribute, uv, color, vec3, clamp, step, smoothstep, abs, max, fract, floor, mix, fwidth,
  cameraPosition, positionWorld, normalWorldGeometry, normalize, dot
} from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';
import { GeoBuilder } from './sz-geometry.js';
import { buildingSeed } from './sz-building-layout.js';
import { isGroundRoad } from './sz-roads.js';
import { polygonContainsInclusive } from './sz-polygon.js';
import { spatialIndex } from './sz-spatial.js';

const SHOP_MIN_M = 4.4;
const CANOPY_CLEARANCE_M = 3.05;
const FRONTAGE_REACH_M = 34;
const CHUNK_M = 600;
export function createRetailFrontage(buildings, { regions = [], nearRoads, pavementAt, carriageway, entrance } = {}) {
  const retailAreas = spatialIndex(regions.filter(region => region.type === 'retail').flatMap(region => region.polygons), p => p.outer);
  const shapes = buildings.filter(b => b.minHeight < 1.9).flatMap(building => building.polygons.map(polygon => ({ building, polygon })));
  const occupied = spatialIndex(shapes, row => row.polygon.outer);
  const batches = new Map(), buildingsWithFrontage = new Set(), doors = [];

  function clear(building, x, z) {
    return !carriageway?.(x, z, 0.45) && ![...occupied(x, z)].some(row =>
      row.building !== building && polygonContainsInclusive(row.polygon, x, z));
  }

  function streetEdge(x, z, nx, nz) {
    return nearRoads?.(x, z, FRONTAGE_REACH_M).some(hit => isGroundRoad(hit.road)
      && (hit.x - x) * nx + (hit.z - z) * nz > Math.max(0.5, hit.distance * 0.5));
  }

  function addCanopy(batch, x, z, y, ux, uz, nx, nz, width, seed) {
    // 高于人行净空，薄顶只从门头向外伸出，顶面和底面共用材质。
    const span = width / 2;
    for (const up of [1, -1]) {
      const base = batch.count;
      const height = y + up * 0.045;
      for (const [along, depth] of [[-span, 0], [span, 0], [span, 0.72], [-span, 0.72]]) {
        batch.vertex(x + ux * along + nx * depth, height, z + uz * along + nz * depth,
          0, up, 0, 0, 0, [-1, 0, 0, seed]);
      }
      if (up > 0) {
        batch.tri(base, base + 1, base + 2);
        batch.tri(base, base + 2, base + 3);
      } else {
        batch.tri(base, base + 2, base + 1);
        batch.tri(base, base + 3, base + 2);
      }
    }
  }

  function edge(building, placement, ax, az, bx, bz, nx, nz, length) {
    const { minY, maxY } = placement;
    if (length < SHOP_MIN_M || maxY - minY < 2.85) return;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const ux = (bx - ax) / length, uz = (bz - az) / length;
    const retailArea = [...retailAreas(mx, mz)].some(p => polygonContainsInclusive(p, mx, mz));
    const frontX = mx + nx * 1.7, frontZ = mz + nz * 1.7;
    const paving = pavementAt?.(frontX, frontZ);
    if (!clear(building, frontX, frontZ) || !(streetEdge(mx, mz, nx, nz) || retailArea && Number.isFinite(paving))) return;

    const fullRetail = building.retailFloors === 2;
    const floorHeight = fullRetail && building.levels > 0
      ? THREE.MathUtils.clamp((maxY - minY) / building.levels, 3, 5.2) : 4.1;
    const ground = Math.min(floorHeight, maxY - minY);
    const floors = Math.max(1, Math.round((maxY - minY) / ground));
    const top = fullRetail ? maxY : minY + ground;
    const levels = fullRetail ? floors : 1;
    const storefrontHeight = fullRetail ? (maxY - minY) / levels : ground;
    const distanceToEntrance = entrance?.buildingId === building.id
      ? Math.hypot(mx - entrance.x, mz - entrance.z) : Infinity;
    const count = Math.max(1, Math.round(length / 7.2));
    const seed = buildingSeed(building.id + ':' + ax + ',' + az);
    const key = `${Math.floor(mx / CHUNK_M)},${Math.floor(mz / CHUNK_M)}`;
    const batch = batches.get(key) ?? new GeoBuilder(true);
    batches.set(key, batch);
    buildingsWithFrontage.add(building.id);
    let start = 0;
    for (let i = 0; i < count; i++) {
      const variation = fractNumber(seed * 89.13 + i * 0.618);
      const end = i === count - 1 ? length : (i + 1 + (variation - 0.5) * 0.38) * length / count;
      const width = end - start;
      const doorU = width * (0.37 + variation * 0.27);
      const doubleDoor = distanceToEntrance < 5 || width > 7.7;
      const doorWidth = doubleDoor ? 1.76 : 1.16;
      const doorX = ax + ux * (start + doorU), doorZ = az + uz * (start + doorU);
      // 实际地面铺装与门槛接高，并给门前身体扫掠留净距。其余开间只布置橱窗。
      const door = [0.45, 1.05, 2.0].every(distance => [-doorWidth / 2, 0, doorWidth / 2].every(offset => {
        const x = doorX + nx * distance + ux * offset, z = doorZ + nz * distance + uz * offset;
        const y = pavementAt?.(x, z);
        return Number.isFinite(y) && Math.abs(y - minY) <= 0.22 && clear(building, x, z);
      }));
      if (door) {
        doors.push({ buildingId: building.id, x: doorX, y: minY, z: doorZ, nx, nz,
          width: doorWidth, appearanceSource: 'estimate', open: false });
        const canopyY = storefrontHeight * 0.83;
        if (canopyY >= CANOPY_CLEARANCE_M && (distanceToEntrance < 6 || variation > 0.8)) {
          addCanopy(batch, doorX, doorZ, minY + canopyY, ux, uz, nx, nz, doorWidth + 0.75, variation);
        }
      }
      const meta = [width, door ? doorU : -8, doorWidth, variation];
      const a = batch.vertex(ax + ux * start, minY, az + uz * start, nx, 0, nz, 0, 0, meta);
      const b = batch.vertex(ax + ux * end, minY, az + uz * end, nx, 0, nz, width, 0, meta);
      // uv.v 以层高归一，层间窗格与首层窗顶在同一墙面内绘制。
      const c = batch.vertex(ax + ux * end, top, az + uz * end, nx, 0, nz, width, levels, meta);
      const d = batch.vertex(ax + ux * start, top, az + uz * start, nx, 0, nz, 0, levels, meta);
      batch.tri(a, c, b);
      batch.tri(a, d, c);
      start = end;
    }
    return top;
  }

  return { edge, doors, buildingsWithFrontage,
    finish(group) {
      if (!batches.size) return null;
      const material = createRetailMaterial();
      for (const [key, batch] of batches) {
        const mesh = new THREE.Mesh(batch.build(), material);
        mesh.name = `ShenzhenRetail:${key}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      return material;
    }
  };
}

const fractNumber = value => value - Math.floor(value);
const band = (x, a, b, aa) => smoothstep(0, aa, x.sub(a)).mul(smoothstep(0, aa, x.mul(-1).add(b)));

function createRetailMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.05 });
  const [u, v] = [uv().x, uv().y];
  const meta = attribute('bmeta', 'vec4');
  const width = max(1, meta.x), doorCenter = meta.y, halfDoor = meta.z.mul(0.5), seed = meta.w;
  const ground = step(v, 1);
  const floorV = fract(v);
  const aaU = max(fwidth(u), 0.013);
  const aaV = max(fwidth(v), 0.003);
  const wallX = band(u, 0.26, width.sub(0.26), aaU);
  const doorX = abs(u.sub(doorCenter));
  const doorFrame = smoothstep(halfDoor, halfDoor.add(aaU), doorX).oneMinus();
  const shopWindow = band(floorV, 0.075, 0.775, aaV).mul(wallX);
  const shopDoor = band(v, 0.012, 0.775, aaV).mul(doorFrame);
  const upper = band(floorV, 0.18, 0.88, aaV).mul(wallX);
  const opening = mix(upper, max(shopWindow, shopDoor), ground);
  const trim = mix(color(0x485453), color(0x877461), seed);
  const stone = mix(color(0xa29d90), color(0xd0c2a8), seed);
  const divider = smoothstep(0.022, aaU.add(0.022), abs(fract(u.div(width).mul(3)).sub(0.5)).mul(width.div(3))).oneMinus();
  const vertical = mix(divider, smoothstep(0.018, aaU.add(0.018), doorX).oneMinus()
    .mul(step(0.8, halfDoor)), doorFrame.mul(ground));
  const doorEdge = band(doorX, halfDoor.sub(0.036), halfDoor.add(0.04), aaU).mul(ground);
  const transom = band(floorV, 0.61, 0.63, aaV).mul(doorFrame).mul(ground);
  const handle = band(doorX, 0.09, 0.16, aaU).mul(band(v, 0.23, 0.32, aaV)).mul(doorFrame);
  const glass = opening.mul(max(max(vertical, doorEdge), transom).oneMinus());
  const fascia = band(v, 0.81, 0.958, aaV).mul(wallX);
  const reveal = band(v, 0.776, 0.808, aaV).mul(wallX);
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(abs(dot(view, normalWorldGeometry)), 0, 1);
  const angle = facing.oneMinus();
  const tangent = vec3(normalWorldGeometry.z.mul(-1), 0, normalWorldGeometry.x);
  // 单层不透明玻璃用视线偏移采样橱窗背板和展台，保留掠射角的天空反光。
  const depthU = u.add(clamp(dot(view, tangent).div(max(facing, 0.32)), -1.6, 1.6).mul(0.65));
  const backV = floorV.add(clamp(view.y.div(max(facing, 0.32)), -0.55, 0.55).mul(0.14));
  const display = band(fract(depthU.div(width).mul(2)), 0.17, 0.73, 0.035)
    .mul(band(backV, 0.13, 0.32, 0.02)).mul(doorFrame.oneMinus());
  const backdrop = mix(color(0x827d69), color(0xb0aca0), seed).mul(smoothstep(0.12, 0.77, backV).mul(0.52).add(0.48));
  const interior = mix(backdrop, mix(color(0x78938b), color(0xc29e79), seed), display.mul(0.84));
  const reflection = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, angle);
  const glazing = mix(interior, reflection, angle.mul(angle).mul(0.51).add(0.16));
  let surface = mix(stone, trim, fascia.mul(0.78));
  surface = mix(surface, color(0x403f38), reveal);
  surface = mix(surface, trim, opening);
  const wall = step(0, meta.x);
  material.colorNode = mix(trim, mix(mix(surface, glazing, glass), color(0xb4bfc0), handle), wall);
  material.roughnessNode = mix(0.8, 0.27, glass.mul(wall));
  const night = smoothstep(0.56, 1.45, cityUniforms.uInteriorGlow);
  const occupancySeed = fract(seed.add(floor(v).mul(0.38197)));
  const occupancy = mix(0.06, occupancySeed.mul(0.52).add(0.42), step(0.33, occupancySeed));
  const lit = mix(color(0xdbe3da), color(0xffd5a3), seed).mul(smoothstep(0.04, 0.75, backV).mul(0.22).add(0.16));
  material.emissiveNode = lit.mul(glass).mul(night).mul(occupancy).mul(mix(0.48, 1, ground))
    .add(color(0xe1c49f).mul(reveal).mul(night).mul(occupancy).mul(0.085)).mul(wall);
  return material;
}
