import * as THREE from 'three/webgpu';
import { polygonBoxOverlaps } from './building-collision.js';
import { sceneUniforms } from './sz-materials.js';
import { addGreenwayLightPool, createFixtureBatches, createGreenwayLightMaterial,
  GREENWAY_LAMP, GREENWAY_RAIL, planBench, planLantern, planRail } from './sz-site-fixtures.js';
import { STR } from './sz-strings.js';

const CELL = 110;
const RETAINING = 0x89857b;
const RIPRAP = 0x72746d;

export function createBayPathLookup(paths = []) {
  if (!paths.length) return () => [];
  const edges = [];
  for (const path of paths) {
    for (let i = 1; i < path.points.length; i++) {
      const [x, z] = path.points[i - 1];
      const dx = path.points[i][0] - x, dz = path.points[i][1] - z;
      const length2 = dx * dx + dz * dz;
      if (length2 > 1e-8) edges.push({ x, z, dx, dz, length2, mode: path.mode, width: path.widthM / 2 });
    }
  }
  // 海岸、湖岸、河岸相距数公里。按小块索引，避免跨样区时逐条扫描全部线段。
  const cellSize = 32;
  const cells = new Map();
  const key = (x, z) => `${x},${z}`;
  for (const edge of edges) {
    for (let x = Math.floor(Math.min(edge.x, edge.x + edge.dx) / cellSize);
      x <= Math.floor(Math.max(edge.x, edge.x + edge.dx) / cellSize); x++) {
      for (let z = Math.floor(Math.min(edge.z, edge.z + edge.dz) / cellSize);
        z <= Math.floor(Math.max(edge.z, edge.z + edge.dz) / cellSize); z++) {
        const id = key(x, z);
        if (!cells.has(id)) cells.set(id, new Set());
        cells.get(id).add(edge);
      }
    }
  }
  const maxWidth = edges.reduce((width, edge) => Math.max(width, edge.width), 0);
  return function near(x, z, pad = 0) {
    const reach = Math.max(0, maxWidth + pad);
    const candidates = new Set();
    for (let ix = Math.floor((x - reach) / cellSize); ix <= Math.floor((x + reach) / cellSize); ix++) {
      for (let iz = Math.floor((z - reach) / cellSize); iz <= Math.floor((z + reach) / cellSize); iz++) {
        for (const edge of cells.get(key(ix, iz)) ?? []) candidates.add(edge);
      }
    }
    const modes = new Set();
    for (const edge of candidates) {
      if (edge.width + pad <= 0) continue;
      const ox = x - edge.x, oz = z - edge.z;
      const t = Math.max(0, Math.min(1, (ox * edge.dx + oz * edge.dz) / edge.length2));
      if ((ox - t * edge.dx) ** 2 + (oz - t * edge.dz) ** 2 <= (edge.width + pad) ** 2) modes.add(edge.mode);
    }
    return [...modes];
  };
}

export function createBayParkArrivals(anchor, parks, pathArrival, findGroundArrival, getLocationLabel) {
  const park = parks.find(row => row.id === anchor?.id);
  const road = anchor && findGroundArrival(anchor, 'car', { radius: 800 });
  return {
    person: park?.areas.some(area => area.arrivals.length) && { ...anchor, ...pathArrival, park,
      detail: pathArrival ? STR.teleport.parkPath : STR.teleport.parkWalk },
    car: road && { ...road, detail: STR.teleport.nearParkRoad(getLocationLabel(road.x, road.z), road.distance) },
    helicopter: anchor && { ...anchor, detail: STR.teleport.parkFlight }
  };
}

function horizontalNormal(a, b) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return length > 1e-4 ? { x: -(b.z - a.z) / length, z: (b.x - a.x) / length } : null;
}

function offset(point, normal, distance, y = point.y) {
  return { x: point.x + normal.x * distance, y, z: point.z + normal.z * distance };
}

function beamCollider(a, b, height, width, type) {
  const normal = horizontalNormal(a, b);
  const outer = normal ? [offset(a, normal, -width / 2), offset(b, normal, -width / 2),
    offset(b, normal, width / 2), offset(a, normal, width / 2)]
    : [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([x, z]) => ({ x: a.x + x * width / 2, z: a.z + z * height / 2 }));
  return { type, polygon: { outer, holes: [] },
    minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
    minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
    minY: Math.min(a.y, b.y) - (normal ? height / 2 : 0), maxY: Math.max(a.y, b.y) + (normal ? height / 2 : 0) };
}

function addQuad(bucket, a, b, c, d, tint) {
  for (const point of [a, b, c, c, b, d]) {
    bucket.positions.push(point.x, point.y, point.z);
    bucket.colors.push(tint.r, tint.g, tint.b);
  }
}

function rampFactor(distance, length) {
  return Math.max(0, Math.min(1, distance / 13, (length - distance) / 13));
}

export function planCoastalGuardrail(sections, { heightAt, isWater, nearCycle, blocked }) {
  const bars = [], posts = [];
  const pointAt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t });
  const supports = sections.map(({ crest, normal }) => {
    if (isWater(crest.x + normal.x * 1.4, crest.z + normal.z * 1.4) !== true) return null;
    const p = offset(crest, normal, -0.48);
    p.y = heightAt(p.x, p.z);
    return Number.isFinite(p.y) && isWater(p.x, p.z) === false ? p : null;
  });
  let previous = null, toNext = 0;
  for (let i = 1; i < supports.length; i++) {
    const a = supports[i - 1], b = supports[i];
    const length = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
    const n = Math.ceil(length / 0.6);
    let clear = length > 0.02 && Math.abs(a.y - b.y) < 0.2 + length * 0.27;
    for (let j = 0; clear && j <= n; j++) {
      const p = pointAt(a, b, j / n);
      const y = heightAt(p.x, p.z);
      clear = Number.isFinite(y) && Math.abs(y - p.y) < 0.28 && isWater(p.x, p.z) === false
        && nearCycle(p.x, p.z) && !blocked(p.x, p.z, y);
    }
    if (!clear) {
      if (previous && toNext < 2.8) posts.push(previous);
      previous = null;
      toNext = 0;
      continue;
    }
    bars.push(...planRail(a, b, GREENWAY_RAIL));
    while (toNext <= length) {
      posts.push(pointAt(a, b, toNext / length));
      toNext += 3;
    }
    toNext -= length;
    previous = b;
  }
  if (previous && toNext < 2.8) posts.push(previous);
  return { bars, posts };
}

function safeFootprint(x, z, radius, obstacles) {
  return !obstacles.some(c => c.minX < x + radius && c.maxX > x - radius
    && c.minZ < z + radius && c.maxZ > z - radius
    && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, radius, radius)));
}

function addWayfinding(group, point, tangent) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 168;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#314d48';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f3e8d1';
  ctx.font = 'bold 47px sans-serif';
  ctx.fillText(STR.bayWaterfront.destination, 34, 72);
  ctx.font = '30px sans-serif';
  ctx.fillText(`${STR.bayWaterfront.walk}  ↑`, 34, 127);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicNodeMaterial({ map });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.343), material);
  sign.name = 'shenzhen-bay-wayfinding';
  sign.position.set(point.x - tangent.x * 0.074, point.y + 1.76, point.z - tangent.z * 0.074);
  sign.rotation.y = Math.atan2(-tangent.x, -tangent.z);
  group.add(sign);
  return { map, material, sign };
}

export function planBayWaterfront(source, { heightAt, isWater, colliders: obstacles = [], pathsNear,
  nearObstacles = () => obstacles, wayfindingEnabled = true, parkNetwork, reserveWalk = () => false,
  carriagewayOccupied = () => false, fixtureBlocked = () => false }) {
  const colliders = [];
  const statistics = { shoreTriangles: 0, rails: 0, coastalRailPosts: 0, lamps: 0, benches: 0, bins: 0 };
  if (!source) return { batches: [], colliders, statistics, routePoints: [], restSpots: [] };

  const routePoints = source.walkRoute.map(([x, y, z]) => ({ x, y, z }));
  const restSpots = [];
  const buckets = new Map();
  function bucket(x, z) {
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    const id = `${ix},${iz}`;
    if (!buckets.has(id)) buckets.set(id, {
      id, x: (ix + 0.5) * CELL, z: (iz + 0.5) * CELL, positions: [], colors: [], rockSites: [],
      metal: [], wood: [], light: [], poolPositions: [], poolUvs: []
    });
    return buckets.get(id);
  }

  function addBox(batch, finish, a, b, height, width, type) {
    batch[finish].push({ a, b, height, width });
    if (type) {
      const collider = beamCollider(a, b, height, width, type);
      (batch.colliders ??= []).push(collider);
      colliders.push(collider);
    }
  }

  const coastCycle = createBayPathLookup((parkNetwork?.bayPaths ?? []).filter(p => !p.bridge && p.mode !== 'walk'));

  for (const shore of source.shore) {
    const stations = shore.stations.map(([x, y, z]) => ({ x, y, z })).filter((point, i, rows) =>
      i === 0 || Math.hypot(point.x - rows[i - 1].x, point.z - rows[i - 1].z) >= 0.004);
    const lengths = [0];
    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1], b = stations[i];
      lengths.push(lengths.at(-1) + Math.hypot(a.x - b.x, a.z - b.z));
    }
    if (stations.length < 2) continue;
    const rockSlope = shore.profile === 'rock-slope';
    const seawall = shore.profile === 'seawall';
    const sections = stations.map((crest, i) => {
      const normal = horizontalNormal(stations[Math.max(0, i - 1)], stations[Math.min(stations.length - 1, i + 1)]);
      if (!normal) throw new Error('Invalid coastal station direction');
      if (isWater(crest.x + normal.x * 1.4, crest.z + normal.z * 1.4) !== true) {
        normal.x *= -1;
        normal.z *= -1;
      }
      const toeY = source.seaHeightM - 0.38;
      const desired = rockSlope ? source.estimates.rockSlopeRunM * rampFactor(lengths[i], lengths.at(-1))
        : seawall ? 1.5 : 0;
      // 岸脚只伸向同一段海面，遇相邻岸线或出水口收短。
      let run = desired;
      while (run > 0.25 && isWater(crest.x + normal.x * run, crest.z + normal.z * run) !== true) run *= 0.5;
      return { crest, normal, toe: offset(crest, normal, run, toeY), run };
    });

    for (let i = 1; i < sections.length; i++) {
      const a = sections[i - 1], b = sections[i];
      const batch = bucket((a.crest.x + b.crest.x) / 2, (a.crest.z + b.crest.z) / 2);
      const phase = (i * 53 % 17) / 17;
      const tint = new THREE.Color(rockSlope ? RIPRAP : RETAINING).multiplyScalar(0.89 + phase * 0.22);
      if (seawall) {
        const dark = tint.clone().multiplyScalar(0.66);
        const aMid = offset(a.crest, a.normal, a.run * 0.25, Math.max(a.toe.y, a.crest.y - 0.48));
        const bMid = offset(b.crest, b.normal, b.run * 0.25, Math.max(b.toe.y, b.crest.y - 0.48));
        addQuad(batch, a.crest, b.crest, aMid, bMid, tint);
        addQuad(batch, aMid, bMid, a.toe, b.toe, dark);
        statistics.shoreTriangles += 2;
      } else if (rockSlope) {
        addQuad(batch, a.crest, b.crest, a.toe, b.toe, tint);
        if (Math.min(a.run, b.run) > 1.5) {
          for (const across of [0.32, 0.61, 0.87]) {
            const x = (a.crest.x + b.crest.x + (a.toe.x + b.toe.x - a.crest.x - b.crest.x) * across) / 2;
            const z = (a.crest.z + b.crest.z + (a.toe.z + b.toe.z - a.crest.z - b.crest.z) * across) / 2;
            const y = (a.crest.y + b.crest.y) * (1 - across) / 2 + a.toe.y * across;
            batch.rockSites.push({ x, y, z, size: 0.38 + phase * 0.39, phase: phase + across });
          }
        }
      } else {
        // 挡墙上缘与地面三角形共边，栏杆柱落在陆侧。
        addQuad(batch, a.crest, b.crest, a.toe, b.toe, tint);
        const p = offset(a.crest, a.normal, -0.19), q = offset(b.crest, b.normal, -0.19);
        p.y = heightAt(p.x, p.z) ?? a.crest.y;
        q.y = heightAt(q.x, q.z) ?? b.crest.y;
        for (const { a, b, height, width } of planRail(p, q, GREENWAY_RAIL)) {
          addBox(batch, 'metal', a, b, height, width, 'bay-rail');
        }
        addBox(batch, 'metal', p, { ...p, y: p.y + 1.1 }, 0.09, 0.09, 'bay-rail-post');
        statistics.rails++;
      }
      statistics.shoreTriangles += 2;
    }
    if (seawall || rockSlope) {
      const rail = planCoastalGuardrail(sections, {
        heightAt, isWater, nearCycle: (x, z) => coastCycle(x, z, 24).length > 0,
        blocked: (x, z, y) => pathsNear(x, z, 0.28).length > 0 || reserveWalk(x, z, 0.28)
          || carriagewayOccupied(x, z, 0.28) || fixtureBlocked(x, z, 0.14, y, y + 1.15)
      });
      for (const { a, b, height, width } of rail.bars) {
        addBox(bucket((a.x + b.x) / 2, (a.z + b.z) / 2), 'metal', a, b, height, width, 'bay-rail');
      }
      for (const p of rail.posts) {
        addBox(bucket(p.x, p.z), 'metal', p, { ...p, y: p.y + 1.12 }, 0.09, 0.09, 'bay-rail-post');
      }
      statistics.coastalRailPosts += rail.posts.length;
      statistics.rails += rail.bars.length / 2;
    }
  }

  const fixtures = [];
  const nearby = (x, z, radius) => [...nearObstacles(x, z, radius), ...fixtures];
  let wayfinding = null;
  const coastPath = source.paths.find(path => path.nodes.includes(source.viewNode));
  const view = coastPath.points[coastPath.nodes.indexOf(source.viewNode)];
  let distance = 0, nextFixture = 11, station = 0;
  function restSpot(p, normal, s, side) {
    const shoulder = offset(p, normal, side * 1.42);
    if (pathsNear(shoulder.x, shoulder.z, -0.37).includes('walk')
      && !pathsNear(shoulder.x, shoulder.z, 0.37).includes('cycle')
      && safeFootprint(shoulder.x, shoulder.z, 0.42, nearby(shoulder.x, shoulder.z, 0.42))) restSpots.push({ s, side: -side * 1.42 });
  }
  for (let i = 1; i < routePoints.length; i++) {
    const a = routePoints[i - 1], b = routePoints[i], normal = horizontalNormal(a, b);
    if (!normal) continue;
    distance += Math.hypot(a.x - b.x, a.z - b.z);
    if (Math.hypot(b.x - view[0], b.z - view[1]) < 0.01) {
      restSpot(b, normal, distance, 1);
      restSpot(b, normal, distance, -1);
    }
    if (distance < nextFixture) continue;
    nextFixture += station % 3 === 0 ? 19 : 14;
    const kind = station++ % 4;
    const clearance = kind === 1 ? 1.25 : 0.48;
    const viewpoint = Math.hypot(a.x - view[0], a.z - view[1]) < 15;
    const options = [3.4, -3.4, 4.8, -4.8].map(d => offset(a, normal, d));
    const p = options.find(({ x, z }) => isWater(x, z) === false && !pathsNear(x, z, clearance).length
      && safeFootprint(x, z, clearance, nearby(x, z, clearance)) && Number.isFinite(heightAt(x, z)));
    if (!p || (viewpoint && kind === 0)) continue;
    p.y = heightAt(p.x, p.z);
    const batch = bucket(p.x, p.z);
    const tangent = { x: normal.z, z: -normal.x };
    const before = colliders.length;
    if (!wayfinding && distance < 50 && wayfindingEnabled) {
      batch.wayfinding = [p, tangent];
      wayfinding = true;
      addBox(batch, 'metal', p, { ...p, y: p.y + 1.94 }, 0.10, 0.10, 'bay-sign-post');
    } else if (kind === 1) {
      const { wood, steel } = planBench(p, tangent.x, tangent.z, { halfLengthM: 0.92, seatHeightM: 0.46,
        seatWidthM: 0.52, legBottomM: -0.05, legTopM: 0.46, legWidthM: 0.28, legDepthM: 0.11 });
      for (const { a, b, height, width } of wood) addBox(batch, 'wood', a, b, height, width, 'bay-bench');
      for (const { a, b, height, width } of steel) addBox(batch, 'metal', a, b, height, width, 'bay-bench-leg');
      statistics.benches++;
      const side = Math.sign((p.x - a.x) * normal.x + (p.z - a.z) * normal.z);
      restSpot(a, normal, distance, side);
    } else if (kind === 3) {
      addBox(batch, 'metal', p, { ...p, y: p.y + 0.85 }, 0.44, 0.44, 'bay-bin');
      statistics.bins++;
    } else if (!parkNetwork) {
      const { pole, lamp } = planLantern(p, { poleBottomM: -0.05, poleTopM: 3.18, headBottomM: 3.16,
        headTopM: 3.30, headWidthM: 0.27 });
      addBox(batch, 'metal', pole.a, pole.b, pole.height, pole.width, 'bay-lamp');
      batch.light.push(lamp);
      // 光斑顺地形落在路缘，灯头发光，场景不增加实时点光源。
      const side = Math.sign((p.x - a.x) * normal.x + (p.z - a.z) * normal.z);
      addGreenwayLightPool(batch, offset(a, normal, side * 0.88), heightAt);
      statistics.lamps++;
    }
    fixtures.push(...colliders.slice(before));
  }

  for (const [x, y, z, pathX, pathZ] of parkNetwork?.bayLamps ?? []) {
    if (pathsNear(x, z, 0.55).length || reserveWalk(x, z, 0.55)
      || fixtureBlocked(x, z, 0.55, y, y + 4.2)) continue;
    const batch = bucket(x, z);
    const { pole, lamp } = planLantern({ x, y, z }, GREENWAY_LAMP);
    addBox(batch, 'metal', pole.a, pole.b, pole.height, pole.width, 'bay-lamp');
    batch.light.push(lamp);
    addGreenwayLightPool(batch, { x: pathX, z: pathZ }, heightAt);
    statistics.lamps++;
  }

  const arrival = { ...routePoints[0], heading: Math.atan2(routePoints[1].x - routePoints[0].x, routePoints[1].z - routePoints[0].z),
    sourcePathId: source.paths[0].osmId };
  statistics.restSpots = restSpots.length;
  return { batches: [...buckets.values()], colliders, statistics, routePoints, restSpots, arrival };
}

export function createBayWaterfrontAccess(pathsNear, parkPaths) {
  const parkPathsNear = createBayPathLookup((parkPaths ?? []).filter(path => !path.bridge));
  return {
    allowsGroundMode(mode, x, z) {
      const parkModes = parkPathsNear(x, z);
      if (mode === 'person') return !parkModes.length || parkModes.includes('walk') || parkModes.includes('shared');
      const modes = parkModes.length ? parkModes : pathsNear(x, z);
      if (mode === 'car') return modes.length === 0;
      if (mode !== 'cyclist') return true;
      return modes.includes('cycle') || modes.includes('shared')
        || (!modes.length && (parkPaths !== undefined || !pathsNear(x, z, 6).length));
    }
  };
}

export function createBayPublicRoutes(routePoints, restSpots, pathsNear) {
  if (!routePoints.length) return [];
  const publicRoutes = [{ id: 'shenzhen-bay:central-bay', points: routePoints,
    allows: (x, z, radius) => pathsNear(x, z, -radius).includes('walk'), reserve: (x, z) => pathsNear(x, z, 1.4).length > 0,
    restSide: s => restSpots.find(spot => Math.abs(spot.s - s) <= 2.6)?.side, jogSpeed: 2.25 }];
  return publicRoutes;
}

export function createBayWaterfrontResources() {
  const shoreMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.96 });
  const poolMaterial = createGreenwayLightMaterial();
  const stone = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.96 });
  const rockGeometry = new THREE.IcosahedronGeometry(1, 0);

  return { shoreMaterial, poolMaterial, stone, rockGeometry, dispose() {
    for (const resource of [shoreMaterial, poolMaterial, stone, rockGeometry]) resource.dispose();
  } };
}

export function mountBayWaterfrontBatch(group, batch, shared, scheduleDetail = build => build()) {
  const { shoreMaterial, poolMaterial, stone, rockGeometry } = shared;
  const fixtureBatches = createFixtureBatches(group, 'bay');
  const owned = [];
  const add = mesh => { group.add(mesh); owned.push(mesh); };
  const wayfinding = batch.wayfinding && addWayfinding(group, ...batch.wayfinding);
  if (wayfinding) owned.push(wayfinding.sign);
  if (batch.positions.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, shoreMaterial);
    mesh.name = `shenzhen-bay-shore:${batch.id}`;
    mesh.receiveShadow = true;
    add(mesh);
  }
  fixtureBatches.build(batch.metal, 'steel', `shenzhen-bay-steel:${batch.id}`);
  fixtureBatches.build(batch.wood, 'wood', `shenzhen-bay-timber:${batch.id}`);
  fixtureBatches.build(batch.light, 'lamp', `shenzhen-bay-lamps:${batch.id}`);
  if (batch.poolPositions.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.poolPositions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.poolUvs, 2));
    batch.pool = new THREE.Mesh(geometry, poolMaterial);
    batch.pool.name = `shenzhen-bay-path-light:${batch.id}`;
    batch.pool.visible = false;
    add(batch.pool);
  }

  let details = null, wantsDetails = false;
  return {
    get detailActive() { return Boolean(details); },
    update({ x, z }) {
      if (batch.pool) batch.pool.visible = sceneUniforms.night.value > 0.025;
      if (!batch.rockSites.length) return;
      const d2 = (x - batch.x) ** 2 + (z - batch.z) ** 2;
      wantsDetails = d2 < 210 ** 2;
      if (details && d2 > 265 ** 2) {
        details.removeFromParent();
        details.dispose();
        details = null;
      } else if (!details && wantsDetails) scheduleDetail(() => {
        if (details || !wantsDetails) return;
        const mesh = new THREE.InstancedMesh(rockGeometry, stone, batch.rockSites.length);
        mesh.name = `shenzhen-bay-riprap:${batch.id}`;
        const matrix = new THREE.Matrix4();
        batch.rockSites.forEach(({ x, y, z, size, phase }, i) => {
          matrix.makeRotationY(phase * 9).scale(new THREE.Vector3(size * 1.32, size * 0.62, size));
          mesh.setMatrixAt(i, matrix.setPosition(x, y, z));
          mesh.setColorAt(i, new THREE.Color(RIPRAP).multiplyScalar(0.75 + (phase % 1) * 0.5));
        });
        mesh.computeBoundingSphere();
        mesh.receiveShadow = true;
        group.add(mesh);
        details = mesh;
      });
    },
    dispose() {
      fixtureBatches.dispose();
      details?.removeFromParent();
      details?.dispose();
      for (const mesh of owned) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
      wayfinding?.map.dispose();
      wayfinding?.material.dispose();
    }
  };
}

export function buildSzBayWaterfront(scene, source, options) {
  const { pathsNear } = options;
  const plan = planBayWaterfront(source, { ...options, wayfindingEnabled: typeof document !== 'undefined' });
  const group = new THREE.Group();
  group.name = 'shenzhen-bay-central-waterfront';
  const shared = createBayWaterfrontResources();
  const batches = plan.batches.map(batch => mountBayWaterfrontBatch(group, batch, shared));
  const statistics = { ...plan.statistics, detailChunks: 0 };
  scene.add(group);
  return { group, colliders: plan.colliders, arrival: plan.arrival, statistics,
    publicRoutes: createBayPublicRoutes(plan.routePoints, plan.restSpots, pathsNear),
    ...createBayWaterfrontAccess(pathsNear, options.parkNetwork?.bayPaths),
    update(position) {
      for (const batch of batches) batch.update(position);
      statistics.detailChunks = batches.filter(batch => batch.detailActive).length;
    },
    dispose() {
      for (const batch of batches) batch.dispose();
      group.removeFromParent();
      shared.dispose();
      statistics.detailChunks = 0;
    }
  };
}
