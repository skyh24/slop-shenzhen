import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { buildWalkTracks, createColliderGrid, sampleTrack } from './sz-pedestrian-tracks.js';

// 正式深圳场景的环境人群：复用纽约的 PersonRig / PersonCrowd（步态、脚底接地、远近 LOD），
// 但不搬纽约的人行道/斑马线数据。深圳没有全城铺装人行道网格，行走位置来自
// sz-pedestrian-tracks.js 的模拟步行带（沿地面道路两侧偏移），铺装条带同样是模拟。
// 人群只在玩家附近维持：活动区按 focus 增量重建，130 m 内才解算骨骼，220 m 外回收。
const PED_DEFAULTS = {
  maxPeds: 120,
  seed: 20261109,
  regionRadiusM: 260,
  regionShiftM: 100,
  spawnMinM: 20,
  spawnMaxM: 160,
  recycleRadiusM: 220,
  nearRadiusM: 130,
  viewProtectM: 90,
  spawnBudget: 6,
  farDistanceM: 34,
  castShadow: true,
  keepRightM: 0.38,
  targetSpeedMin: 1.1,
  targetSpeedMax: 1.5,
  walkMarginM: 2.1,
  pauseTurnS: 0.9,
  restMinS: 35,
  restMaxS: 80,
  restPauseMinS: 1.5,
  restPauseMaxS: 3.5,
  surfaceRiseM: 0.03,
  pavement: true,
  pavementHalfWidthM: 1.1
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const squareDistance = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

export function seededRandom(seed) {
  let state = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const hash = (i, salt) => {
  const value = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

function createPed(id, cfg) {
  const female = hash(id, 1) < 0.48;
  const hairRoll = hash(id, 2);
  return {
    id,
    rig: new PersonRig({
      seed: id * 1.6180339 + 0.13,
      female,
      scale: (female ? 0.91 : 0.97) + hash(id, 4) * 0.1,
      girth: 0.9 + hash(id, 5) * 0.24,
      hair: female ? (hairRoll < 0.68 ? 1 : 0.3 + hairRoll * 0.25) : hairRoll < 0.08 ? 1 : hairRoll * 0.35,
      armSwing: 0.75 + hash(id, 6) * 0.5,
      stride: 0.94 + hash(id, 7) * 0.12
    }),
    placed: false,
    leg: null,
    s: 0,
    dir: 1,
    fromLeg: null,
    x: 0,
    z: 0,
    heading: 0,
    v: 0,
    speed: cfg.targetSpeedMin + (cfg.targetSpeedMax - cfg.targetSpeedMin) * hash(id, 3),
    lateral: 0,
    pause: 0,
    restAt: 0
  };
}

function processPose(ped, sampled) {
  const fade = Math.max(0, Math.min(1, ped.s / 2.5, (ped.leg.length - ped.s) / 2.5));
  const lateral = ped.lateral * fade;
  ped.x = sampled.x + sampled.dz * lateral;
  ped.z = sampled.z - sampled.dx * lateral;
  // 坐标系约定与控制器相同：heading = atan2(x 分量, z 分量)，0 为南、π 为北。
  ped.heading = Math.atan2(sampled.dx * ped.dir, sampled.dz * ped.dir);
}

function pickTrack(region, random) {
  const total = region.spawnWeight;
  if (!(total > 0)) return null;
  const target = random() * total;
  let lo = 0;
  let hi = region.spawnTracks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (region.spawnCum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return region.spawnTracks[lo];
}

export function createSzPedestrians(scene, graph, options = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Ambient pedestrians require a scene');
  if (!graph || !Array.isArray(graph.links) || !Array.isArray(graph.metadata)) {
    throw new Error('Ambient pedestrians require the source road graph');
  }
  if (typeof options.heightAt !== 'function') throw new Error('Ambient pedestrians require heightAt');
  if (!Array.isArray(options.colliders)) throw new Error('Ambient pedestrians require collider bounds');
  const cfg = { ...PED_DEFAULTS, ...options };
  const random = seededRandom(cfg.seed);
  // 全城建筑碰撞体只索引一次，活动区重建时取附近一组。
  const colliderGrid = createColliderGrid(cfg.colliders);
  const group = new THREE.Group();
  group.name = 'shenzhen-ambient-pedestrians';
  const crowd = new PersonCrowd(cfg.maxPeds, { farDistance: cfg.farDistanceM, castShadow: cfg.castShadow });
  for (const mesh of crowd.meshes) group.add(mesh);
  const pavementMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.94 });
  pavementMaterial.name = 'simulated-sidewalk-pavement';
  let pavementMesh = null;
  const peds = [];
  for (let id = 0; id < cfg.maxPeds; id++) peds.push(createPed(id, cfg));
  scene.add(group);

  const ground = (owner, x, z) => {
    const height = cfg.heightAt(x, z);
    return Number.isFinite(height) ? height + cfg.surfaceRiseM : cfg.surfaceRiseM;
  };
  const scratch = { x: 0, y: 0, z: 0, dx: 1, dz: 0 };
  const nearPeds = [];
  const avoidance = [];
  let region = null;
  let lastFocus = null;
  let clock = 0;
  let spawnCursor = 0;
  let pavementGeometry = null;
  const statistics = {
    maxPeds: cfg.maxPeds, placed: 0, near: 0, drawn: 0, spawned: 0, recycled: 0, spawnFailures: 0,
    regionBuilds: 0, regionBuildMs: 0, tracks: 0, connectors: 0, walkableMeters: 0,
    pavementTriangles: 0, pavementAreaM2: 0, colliderIndexed: 0
  };

  function applyPavement(pavement) {
    if (pavementMesh) {
      group.remove(pavementMesh);
      pavementGeometry?.dispose();
      pavementMesh = null;
      pavementGeometry = null;
    }
    if (!cfg.pavement || pavement.positions.length === 0) return;
    pavementGeometry = new THREE.BufferGeometry();
    pavementGeometry.setAttribute('position', new THREE.BufferAttribute(pavement.positions, 3));
    pavementGeometry.setAttribute('color', new THREE.BufferAttribute(pavement.colors, 3));
    pavementGeometry.computeVertexNormals();
    pavementGeometry.computeBoundingSphere();
    pavementMesh = new THREE.Mesh(pavementGeometry, pavementMaterial);
    pavementMesh.name = 'shenzhen-simulated-pavement';
    pavementMesh.receiveShadow = true;
    group.add(pavementMesh);
  }

  function buildRegion(focus) {
    const started = typeof performance === 'object' && performance?.now ? performance.now() : Date.now();
    const radius = cfg.regionRadiusM;
    const bounds = { minX: focus.x - radius, minZ: focus.z - radius, maxX: focus.x + radius, maxZ: focus.z + radius };
    const built = buildWalkTracks(graph, {
      ...cfg,
      bounds,
      heightAt: cfg.heightAt,
      colliders: cfg.colliders,
      colliderGrid,
      pavement: cfg.pavement,
      surfaceRiseM: cfg.surfaceRiseM,
      pavementHalfWidthM: cfg.pavementHalfWidthM,
      walkMarginM: cfg.walkMarginM
    });
    // 只保留独立直段参与出生选点；转角连接是通路，不是出生点。
    const spawnTracks = [];
    const spawnCum = [];
    let spawnWeight = 0;
    for (const track of built.tracks) {
      spawnTracks.push(track);
      spawnWeight += track.length;
      spawnCum.push(spawnWeight);
    }
    region = { center: { x: focus.x, z: focus.z }, bounds, spawnTracks, spawnCum, spawnWeight, ...built };
    applyPavement(built.pavement);
    statistics.regionBuilds++;
    statistics.regionBuildMs = (typeof performance === 'object' && performance?.now ? performance.now() : Date.now()) - started;
    statistics.tracks = built.tracks.length;
    statistics.connectors = built.connectors.length;
    statistics.walkableMeters = built.statistics.walkableMeters;
    statistics.pavementTriangles = built.statistics.pavementTriangles;
    statistics.pavementAreaM2 = built.statistics.pavementAreaM2;
    statistics.colliderIndexed = built.statistics.colliderIndexed;
  }

  function collectAvoidance(players) {
    avoidance.length = 0;
    if (!Array.isArray(players)) return;
    for (const entity of players) {
      const position = entity?.position;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) continue;
      if (!(position.y < 3)) continue;
      avoidance.push({ x: position.x, z: position.z, radius: entity.type === 'person' ? 1.1 : 2.6 });
    }
  }

  function crowded(x, z) {
    for (const ped of peds) {
      if (!ped.placed) continue;
      if (squareDistance(x, z, ped.x, ped.z) < 1) return true;
    }
    return false;
  }

  function trySpawn(ped, focus, isVisible) {
    if (!region || region.spawnTracks.length === 0) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const track = pickTrack(region, random);
      if (!track || track.length < 2) continue;
      const s = 0.6 + random() * Math.max(0, track.length - 1.2);
      sampleTrack(track, s, scratch);
      const distance = Math.hypot(scratch.x - focus.x, scratch.z - focus.z);
      if (distance < cfg.spawnMinM || distance > cfg.spawnMaxM) continue;
      // 视锥内近处不允许凭空出现；远处 90 m 外允许被人群补充，避免镜头前突然冒人。
      if (isVisible && distance < cfg.viewProtectM && isVisible(scratch.x, scratch.z, 7)) continue;
      let blocked = false;
      for (const player of avoidance) {
        if (squareDistance(scratch.x, scratch.z, player.x, player.z) < (player.radius + 1) ** 2) { blocked = true; break; }
      }
      if (blocked || crowded(scratch.x, scratch.z)) continue;
      ped.leg = track;
      ped.s = s;
      ped.dir = random() < 0.5 ? 1 : -1;
      ped.fromLeg = null;
      ped.lateral = cfg.keepRightM * ped.dir;
      ped.v = ped.speed * (0.5 + random() * 0.5);
      ped.pause = 0;
      ped.restAt = clock + cfg.restMinS + random() * (cfg.restMaxS - cfg.restMinS);
      processPose(ped, scratch);
      ped.rig.placed = false;
      ped.placed = true;
      statistics.spawned++;
      return true;
    }
    statistics.spawnFailures++;
    return false;
  }

  function unplace(ped) {
    ped.placed = false;
    ped.leg = null;
    ped.fromLeg = null;
    ped.rig.placed = false;
  }

  function transition(ped) {
    const end = ped.dir > 0 ? 1 : 0;
    const links = ped.leg.ends[end];
    let choice = null;
    if (links.length > 0) {
      const fresh = links.filter(link => link.leg !== ped.fromLeg);
      const pool = fresh.length > 0 ? fresh : links;
      choice = pool[Math.floor(random() * pool.length)];
    }
    if (!choice) {
      // 没有同侧转角连接：在端点原路折返；不横穿车行道。
      ped.dir = -ped.dir;
      ped.pause = cfg.pauseTurnS;
      ped.v = 0;
      ped.fromLeg = null;
      return true;
    }
    const previous = ped.leg;
    ped.leg = choice.leg;
    ped.s = choice.end === 0 ? 0 : ped.leg.length;
    ped.dir = choice.end === 0 ? 1 : -1;
    ped.fromLeg = previous;
    return true;
  }

  function aheadSpeed(ped) {
    let speed = ped.speed;
    const fx = Math.sin(ped.heading);
    const fz = Math.cos(ped.heading);
    for (const other of nearPeds) {
      if (other === ped) continue;
      const dx = other.x - ped.x;
      const dz = other.z - ped.z;
      const forward = dx * fx + dz * fz;
      if (forward <= 0 || forward > 1.6) continue;
      const lateral = Math.abs(dx * fz - dz * fx);
      if (lateral > 0.62) continue;
      speed = Math.min(speed, forward < 0.75 ? 0 : 0.45);
    }
    return speed;
  }

  function advance(ped, dt) {
    if (ped.pause > 0) {
      ped.pause = Math.max(0, ped.pause - dt);
      ped.v = 0;
    }
    let target = ped.pause > 0 ? 0 : ped.speed;
    for (const player of avoidance) {
      if (squareDistance(ped.x, ped.z, player.x, player.z) < player.radius ** 2) { target = 0; break; }
    }
    if (target > 0) target = Math.min(target, aheadSpeed(ped));
    // 无连接的端点前提前减速，折返前自然停住。
    const end = ped.dir > 0 ? 1 : 0;
    if (ped.leg.ends[end].length === 0) {
      const ahead = ped.dir > 0 ? ped.leg.length - ped.s : ped.s;
      target = Math.min(target, Math.sqrt(2 * 1.8 * Math.max(0, ahead)));
    }
    // 随机短暂停留：看橱窗/等同伴的模拟，不是实测客流行为。
    if (ped.pause === 0 && clock >= ped.restAt) {
      ped.pause = cfg.restPauseMinS + random() * (cfg.restPauseMaxS - cfg.restPauseMinS);
      ped.restAt = clock + cfg.restMinS + random() * (cfg.restMaxS - cfg.restMinS);
      target = 0;
    }
    const acceleration = target > ped.v ? 1.7 : 3.2;
    ped.v = clamp(ped.v + clamp(target - ped.v, -acceleration * dt, acceleration * dt), 0, ped.speed);
    // 侧向让线：靠右走，转角/端点处回到中线，避免变道时脚底打滑。
    const lateralTarget = cfg.keepRightM * ped.dir;
    ped.lateral += clamp(lateralTarget - ped.lateral, -2.2 * dt, 2.2 * dt);
    let remaining = ped.v * dt;
    let guard = 0;
    while (remaining > 0 && guard++ < 4) {
      const endDistance = ped.dir > 0 ? ped.leg.length - ped.s : ped.s;
      if (remaining <= endDistance) {
        ped.s = clamp(ped.s + ped.dir * remaining, 0, ped.leg.length);
        remaining = 0;
        break;
      }
      ped.s = ped.dir > 0 ? ped.leg.length : 0;
      remaining -= endDistance;
      transition(ped);
      if (ped.pause > 0) remaining = 0;
    }
    sampleTrack(ped.leg, ped.s, scratch);
    processPose(ped, scratch);
  }

  function update(dt, focus, elapsed, isVisible = null, players = null) {
    if (!focus || !Number.isFinite(focus.x) || !Number.isFinite(focus.z)) return;
    dt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.05));
    clock = Number.isFinite(elapsed) ? elapsed : clock + dt;
    const jump = lastFocus ? Math.hypot(focus.x - lastFocus.x, focus.z - lastFocus.z) > cfg.recycleRadiusM : false;
    if (!region || jump || Math.hypot(focus.x - region.center.x, focus.z - region.center.z) > cfg.regionShiftM) {
      buildRegion(focus);
    }
    lastFocus = { x: focus.x, z: focus.z };
    collectAvoidance(players);
    // 远处回收：保证活动区人数只受 focus 附近轨道容量限制。
    const recycleSq = cfg.recycleRadiusM ** 2;
    for (const ped of peds) {
      if (!ped.placed) continue;
      if (squareDistance(ped.x, ped.z, focus.x, focus.z) > recycleSq) {
        unplace(ped);
        statistics.recycled++;
      }
    }
    let budget = jump ? cfg.maxPeds : cfg.spawnBudget;
    let scanned = 0;
    while (budget > 0 && scanned < peds.length) {
      const ped = peds[spawnCursor];
      spawnCursor = (spawnCursor + 1) % peds.length;
      scanned++;
      if (ped.placed) continue;
      budget--;
      trySpawn(ped, focus, isVisible);
    }
    nearPeds.length = 0;
    crowd.begin();
    let placed = 0;
    let near = 0;
    let drawn = 0;
    const nearSq = cfg.nearRadiusM ** 2;
    for (const ped of peds) {
      if (!ped.placed) continue;
      placed++;
      const dx = ped.x - focus.x;
      const dz = ped.z - focus.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > nearSq) {
        if (ped.rig.placed) ped.rig.placed = false;
        continue;
      }
      near++;
      nearPeds.push(ped);
      advance(ped, dt);
      const draw = !isVisible || isVisible(ped.x, ped.z, 7);
      if (draw) drawn++;
      // 隐藏但离得近的人仍然推进步态；超过 50 m 且看不见则等待重新落地，省掉骨骼计算。
      if (!draw && distanceSq > 2500) ped.rig.placed = false;
      else {
        ped.rig.update(dt, ped.x, ped.z, ped.heading, ground, ped, 0, draw, -1);
        if (draw) crowd.add(ped.rig, Math.sqrt(distanceSq));
      }
    }
    crowd.end();
    statistics.placed = placed;
    statistics.near = near;
    statistics.drawn = drawn;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of crowd.meshes) {
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
      mesh.dispose?.();
    }
    if (pavementMesh) {
      group.remove(pavementMesh);
      pavementGeometry?.dispose();
      pavementMesh = null;
      pavementGeometry = null;
    }
    pavementMaterial.dispose();
    region = null;
  }

  return { group, meshes: crowd.meshes, update, statistics, dispose, peds, get region() { return region; } };
}
