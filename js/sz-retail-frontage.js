import * as THREE from 'three/webgpu';
import {
  attribute, uv, color, vec3, clamp, step, smoothstep, abs, max, fract, floor, mix, fwidth, float,
  cameraPosition, positionWorld, normalWorldGeometry, normalize, dot
} from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';
import { GeoBuilder } from './sz-geometry.js';
import { buildingSeed } from './sz-building-layout.js';
import { isGroundRoad } from './sz-roads.js';
import { polygonContainsInclusive } from './sz-polygon.js';
import { spatialIndex } from './sz-spatial.js';
import {
  buildShopSignGeometry, createShopSignMaterial, createShopSignTexture, planShopSignAtlas,
  shopSignLit, shopSignName, shopSignRect, SHOP_SIGN_OFFSET_M
} from './sz-retail-signs.js';

const SHOP_MIN_M = 4.4;
const CANOPY_CLEARANCE_M = 3.05;
const CANOPY_THICKNESS_M = 0.08;
const FRONTAGE_REACH_M = 34;
const CHUNK_M = 600;
export function createRetailFrontage(buildings, { regions = [], nearRoads, pavementAt, carriageway, entrance } = {}) {
  const retailAreas = spatialIndex(regions.filter(region => region.type === 'retail').flatMap(region => region.polygons), p => p.outer);
  const shapes = buildings.filter(b => b.minHeight < 1.9).flatMap(building => building.polygons.map(polygon => ({ building, polygon })));
  const occupied = spatialIndex(shapes, row => row.polygon.outer);
  const batches = new Map(), groundBatches = new Map(), signBatches = new Map();
  const canopyBudgets = new Map(), buildingsWithFrontage = new Set(), doors = [];

  function clear(building, x, z) {
    return !carriageway?.(x, z, 0.45) && ![...occupied(x, z)].some(row =>
      row.building !== building && polygonContainsInclusive(row.polygon, x, z));
  }

  function streetEdge(x, z, nx, nz) {
    return nearRoads?.(x, z, FRONTAGE_REACH_M).some(hit => isGroundRoad(hit.road)
      && (hit.x - x) * nx + (hit.z - z) * nz > Math.max(0.5, hit.distance * 0.5));
  }

  // 雨棚是悬空构件：后沿底面不低于 3.05m，顶板不越过店招底边；
  // 底面由后向前抬升，与顶板前沿交成楔形，省掉前檐板又不露空腔。
  function addCanopy(batch, grounds, x, z, soffit, ux, uz, nx, nz, width, depth, seed) {
    const span = width / 2;
    const top = soffit + CANOPY_THICKNESS_M;
    const meta = [-1, depth, 0, seed];
    const vertex = (along, out, y, ny, u, v) => {
      const horizontal = ny === 0 ? 1 : 0;
      batch.vertex(x + ux * along + nx * out, y, z + uz * along + nz * out,
        nx * horizontal, ny, nz * horizontal, u, v, meta);
      grounds.push(0);
    };
    const alongU = along => (along + span) / (span * 2);
    const slab = [[-span, 0], [span, 0], [span, depth], [-span, depth]];
    // 顶板（朝上）
    let base = batch.count;
    for (const [along, out] of slab) vertex(along, out, top, 1, alongU(along), out / depth);
    batch.tri(base, base + 2, base + 1);
    batch.tri(base, base + 3, base + 2);
    // 底板（朝下，夜间独立发光面）：后沿 soffit、前沿 top，与顶板交成楔形
    base = batch.count;
    for (const [along, out] of slab) {
      const y = soffit + CANOPY_THICKNESS_M * (out / depth);
      vertex(along, out, y, -1, alongU(along), out / depth);
    }
    batch.tri(base, base + 1, base + 2);
    batch.tri(base, base + 2, base + 3);
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
    // 店招按 7 开间取 2 块的确定性节律布置：成对出现，留出 5 间空白，
    // 避免整条街均匀稀疏；偏移量由 seed 决定，保证同一楼栋稳定可复现。
    const signOffset = Math.floor(fractNumber(seed * 31.73 + 0.19) * 7);
    const key = `${Math.floor(mx / CHUNK_M)},${Math.floor(mz / CHUNK_M)}`;
    const batch = batches.get(key) ?? new GeoBuilder(true);
    batches.set(key, batch);
    const grounds = groundBatches.get(key) ?? [];
    groundBatches.set(key, grounds);
    const signs = signBatches.get(key) ?? [];
    signBatches.set(key, signs);
    // 同一栋楼最多 3 段雨棚，跨多面墙共用同一份预算。
    let canopies = canopyBudgets.get(building.id);
    if (canopies === undefined) {
      canopies = Math.min(3, 1 + Math.floor(fractNumber(buildingSeed(building.id + ':canopy') * 11.7) * 3));
      canopyBudgets.set(building.id, canopies);
    }
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
      }
      const center = (start + end) / 2;
      const sign = (i + signOffset) % 7 < 2 ? shopSignRect(minY, storefrontHeight, width) : null;
      if (sign) {
        // 招牌宽度与图集单元格同宽，避免文字被横向拉伸。
        const half = sign.width / 2;
        const signSeed = fractNumber(seed * 12.9 + i * 0.618);
        signs.push({
          ax: ax + ux * (center - half) + nx * SHOP_SIGN_OFFSET_M,
          az: az + uz * (center - half) + nz * SHOP_SIGN_OFFSET_M,
          bx: ax + ux * (center + half) + nx * SHOP_SIGN_OFFSET_M,
          bz: az + uz * (center + half) + nz * SHOP_SIGN_OFFSET_M,
          nx, nz, y0: sign.bottom, y1: sign.top,
          width: sign.width, height: sign.height,
          glow: shopSignLit(seed, i), seed: signSeed, name: shopSignName(signSeed)
        });
      }
      if (sign && canopies > 0 && (count - i <= canopies || variation > 0.55)) {
        const depth = 0.95 + 0.55 * variation;
        const canopyWidth = Math.min(width - 0.2, width * (0.56 + 0.22 * variation));
        const topLimit = Math.min(sign.bottom - 0.04, minY + storefrontHeight * 0.958);
        const soffit = Math.max(minY + CANOPY_CLEARANCE_M,
          Math.min(minY + storefrontHeight * 0.76, topLimit - CANOPY_THICKNESS_M));
        if (canopyWidth >= 1.6 && soffit + CANOPY_THICKNESS_M <= topLimit) {
          addCanopy(batch, grounds, ax + ux * center, az + uz * center, soffit,
            ux, uz, nx, nz, canopyWidth, depth, variation);
          canopies--;
        }
      }
      const meta = [width, door ? doorU : -8, doorWidth, variation];
      const a = batch.vertex(ax + ux * start, minY, az + uz * start, nx, 0, nz, 0, 0, meta);
      const b = batch.vertex(ax + ux * end, minY, az + uz * end, nx, 0, nz, width, 0, meta);
      // uv.v 以层高归一，层间窗格与首层窗顶在同一墙面内绘制。
      const c = batch.vertex(ax + ux * end, top, az + uz * end, nx, 0, nz, width, levels, meta);
      const d = batch.vertex(ax + ux * start, top, az + uz * start, nx, 0, nz, 0, levels, meta);
      grounds.push(storefrontHeight, storefrontHeight, storefrontHeight, storefrontHeight);
      batch.tri(a, c, b);
      batch.tri(a, d, c);
      start = end;
    }
    canopyBudgets.set(building.id, canopies);
    return top;
  }

  return { edge, doors, buildingsWithFrontage,
    finish(group) {
      if (!batches.size) return null;
      const material = createRetailMaterial();
      const signMaterials = [];
      for (const [key, batch] of batches) {
        const geometry = batch.build();
        const grounds = groundBatches.get(key) ?? [];
        const count = geometry.attributes.position.count;
        const heights = new Float32Array(count);
        for (let i = 0; i < count; i++) heights[i] = grounds[i] ?? 4.1;
        geometry.setAttribute('bground', new THREE.BufferAttribute(heights, 1));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `ShenzhenRetail:${key}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      for (const [key, entries] of signBatches) {
        if (!entries.length) continue;
        // 图集装不下时按确定性间隔抽样，宁可少放招牌也不让字挤在一起。
        let active = entries;
        let layout = planShopSignAtlas(active);
        while (!layout && active.length > 24) {
          active = active.filter((_, index) => index % 2 === 0);
          layout = planShopSignAtlas(active);
        }
        if (!layout) continue;
        const map = createShopSignTexture(layout);
        if (!map) continue;
        const signMaterial = createShopSignMaterial(map);
        const built = buildShopSignGeometry(layout, active);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(built.positions), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(built.normals), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(built.uvs), 2));
        geometry.setAttribute('signGlow', new THREE.BufferAttribute(Float32Array.from(built.glows), 1));
        geometry.setIndex(built.indices);
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, signMaterial);
        mesh.name = `ShenzhenRetailSigns:${key}`;
        mesh.receiveShadow = true;
        group.add(mesh);
        signMaterials.push(signMaterial);
      }
      // sz-buildings.js 只释放零售材质本身，店招图集在这里一起释放。
      const dispose = material.dispose.bind(material);
      material.dispose = () => {
        for (const signMaterial of signMaterials) {
          signMaterial.map?.dispose();
          signMaterial.dispose();
        }
        signMaterials.length = 0;
        dispose();
      };
      return material;
    }
  };
}

const fractNumber = value => value - Math.floor(value);
const band = (x, a, b, aa) => smoothstep(0, aa, x.sub(a)).mul(smoothstep(0, aa, x.mul(-1).add(b)));

// 首层夜间亮度固定三档、冷暖二选一：材质与测试共用同一套确定性规则。
export function retailGroundTier(seed) {
  const tierSeed = fractNumber(seed * 43.17 + 0.21);
  return tierSeed < 0.30 ? 0.35 : tierSeed < 0.62 ? 0.65 : 1;
}

export function retailGroundWarm(seed) {
  return fractNumber(seed * 7.31 + 0.11) >= 0.52;
}

export function createRetailMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.05 });
  const [u, v] = [uv().x, uv().y];
  const meta = attribute('bmeta', 'vec4');
  const storefrontHeight = attribute('bground', 'float');
  const width = max(1, meta.x), doorCenter = meta.y, halfDoor = meta.z.mul(0.5), seed = meta.w;
  const wall = step(0, meta.x);
  const canopy = wall.oneMinus();
  const ground = step(v, 1);
  const floorV = fract(v);
  const aaU = max(fwidth(u), 0.013);
  const aaV = max(fwidth(v), 0.003);
  const wallX = band(u, 0.26, width.sub(0.26), aaU);
  // 首层石材基座：0.42m 墙裙 + 0.10m 深色收边，按每栋实际首层层高换算成 uv。
  const plinthTop = clamp(float(0.42).div(max(storefrontHeight, 3)), 0.075, 0.115);
  const plinthEdge = clamp(float(0.10).div(max(storefrontHeight, 3)), 0.018, 0.03);
  const doorX = abs(u.sub(doorCenter));
  const doorFrame = smoothstep(halfDoor, halfDoor.add(aaU), doorX).oneMinus();
  const plinth = band(v, 0.006, plinthTop, aaV).mul(wall).mul(doorFrame.oneMinus());
  const plinthTrim = band(v, plinthTop, plinthTop.add(plinthEdge), aaV).mul(wall).mul(doorFrame.oneMinus());
  const shopWindow = band(floorV, plinthTop.add(0.006), 0.775, aaV).mul(wallX);
  const shopDoor = band(v, plinthTop.add(0.004), 0.775, aaV).mul(doorFrame);
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
  const glassBand = opening.mul(max(max(vertical, doorEdge), transom).oneMinus());
  const glass = glassBand.mul(wall).mul(max(plinth, plinthTrim).oneMinus());
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
  // 基座比墙身更暖更暗，和深色收边一起压住街面底部。
  const plinthStone = mix(color(0x6c6152), color(0x8d7c66), seed);
  surface = mix(surface, plinthStone, plinth.mul(0.94));
  surface = mix(surface, color(0x33302b), plinthTrim);
  const canopyBase = mix(color(0x5f594e), color(0x8b816d), seed.mul(0.6));
  const wallColor = mix(trim, mix(mix(surface, glazing, glass), color(0xb4bfc0), handle), wall);
  material.colorNode = mix(canopyBase, wallColor, wall);
  material.roughnessNode = mix(0.86, 0.27, glass);
  const night = smoothstep(0.56, 1.45, cityUniforms.uInteriorGlow);
  // 首层夜间亮度固定三档（0.35 / 0.65 / 1.0），按楼栋 seed 分布，冷暖再由另一路 seed 混合。
  const tierSeed = fract(seed.mul(43.17).add(0.21));
  const tierMid = step(0.30, tierSeed);
  const tierHigh = step(0.62, tierSeed);
  const groundTier = mix(mix(0.35, 0.65, tierMid), 1, tierHigh);
  const warm = step(0.52, fract(seed.mul(7.31).add(0.11)));
  const litColor = mix(color(0xcfe0ea), color(0xffd0a0), warm);
  const occupancySeed = fract(seed.add(floor(v).mul(0.38197)));
  const occupancy = mix(0.06, occupancySeed.mul(0.52).add(0.42), step(0.33, occupancySeed));
  // 橱窗背墙由下向上渐亮，避免整条街退化成一条连续亮带。
  const backdropGlow = smoothstep(0.08, 0.78, backV).mul(0.42).add(0.58);
  const wallLit = litColor.mul(glass).mul(night).mul(mix(occupancy, groundTier, ground))
    .mul(mix(0.5, 1, ground)).mul(backdropGlow);
  const revealLit = color(0xe1c49f).mul(reveal).mul(night).mul(occupancy).mul(0.085);
  const canopyLit = color(0xffd7ad).mul(canopy).mul(night)
    .mul(mix(0.2, 0.9, smoothstep(0, 1, v)))
    .mul(step(0, normalWorldGeometry.y.mul(-1)).mul(0.72).add(0.28));
  material.emissiveNode = mix(canopyLit, wallLit.add(revealLit), wall);
  return material;
}
