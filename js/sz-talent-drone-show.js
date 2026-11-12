import * as THREE from 'three/webgpu';
import { FLEET_SIZE } from './sz-drone-formations.js';
import { planDroneChoreography, sampleDroneChoreography } from './sz-drone-choreography.js';
import { polygonContainsInclusive } from './sz-polygon.js';

export function droneWorld(airspace, u, v, d) {
  const x = Math.sin(airspace.heading), z = Math.cos(airspace.heading);
  return { x: airspace.x - z * u + x * d, y: airspace.y + v, z: airspace.z + x * u + z * d };
}

function worldEnvelope(airspace, { u, v, d }) {
  const corners = u.flatMap(a => d.map(b => droneWorld(airspace, a, 0, b)));
  return { minX: Math.min(...corners.map(p => p.x)) - 2, maxX: Math.max(...corners.map(p => p.x)) + 2,
    minZ: Math.min(...corners.map(p => p.z)) - 2, maxZ: Math.max(...corners.map(p => p.z)) + 2,
    minY: airspace.y + v[0] - 2, maxY: airspace.y + v[1] + 2 };
}

export function auditTalentAirspace(airspace, envelope, lake, colliders, lakeHeight) {
  const b = worldEnvelope(airspace, envelope);
  if (b.minY < lakeHeight + 10) return null;
  // 用比旋转节目包络更大的轴对齐盒核水域，再与场景实体检查整盒净空。
  const samples = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]];
  if (!samples.every(([x, z]) => polygonContainsInclusive(lake, x, z))
      || [lake.outer, ...lake.holes].some(ring => ring.some(p => p.x >= b.minX && p.x <= b.maxX
        && p.z >= b.minZ && p.z <= b.maxZ))) return null;
  if (colliders.some(c => c.maxY > b.minY && c.minY < b.maxY
    && c.minX < b.maxX && c.maxX > b.minX && c.minZ < b.maxZ && c.maxZ > b.minZ)) return null;
  return b;
}

function bodyGeometry() {
  // 一个几何合并机腹和十字机臂，远处不绘制机体实例。
  const geom = new THREE.BufferGeometry();
  const indexed = new THREE.BoxGeometry();
  const base = indexed.toNonIndexed();
  indexed.dispose();
  const pos = base.attributes.position;
  const shapes = [[0.46, 0.15, 0.46], [1.02, 0.055, 0.12], [0.12, 0.055, 1.02]];
  const array = new Float32Array(shapes.length * pos.count * 3);
  for (const [k, [x, y, z]] of shapes.entries()) for (let i = 0; i < pos.count; i++) {
    array.set([pos.getX(i) * x, pos.getY(i) * y, pos.getZ(i) * z], (k * pos.count + i) * 3);
  }
  geom.setAttribute('position', new THREE.BufferAttribute(array, 3));
  geom.computeVertexNormals();
  base.dispose();
  return geom;
}

export function createTalentDroneShow(scene, { airspace, lake, colliders, lakeHeight }) {
  const plan = planDroneChoreography();
  const clear = auditTalentAirspace(airspace, plan.envelope, lake, colliders, lakeHeight);
  const poses = Array.from({ length: FLEET_SIZE }, () => ({}));
  const matrix = new THREE.Matrix4(), tint = new THREE.Color();
  const cx = Math.sin(airspace.heading), cz = Math.cos(airspace.heading);
  let group = null, leds = null, bodies = null, total = 0, paused = false, cue = 0, loops = 0;
  let replayAt = null, retreat = null, retreatTime = 0, changing = false, stageId = null, updateMs = 0;
  let nearCount = 0;

  function createMeshes() {
    group = new THREE.Group();
    group.name = 'talent-park:drone-show';
    const diode = new THREE.IcosahedronGeometry(0.94, 0);
    const ledMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, toneMapped: false });
    leds = new THREE.InstancedMesh(diode, ledMaterial, FLEET_SIZE);
    leds.name = 'talent-park:show-diodes';
    bodies = new THREE.InstancedMesh(bodyGeometry(),
      new THREE.MeshStandardNodeMaterial({ color: 0x363b52, roughness: 0.55 }), FLEET_SIZE);
    bodies.name = 'talent-park:show-airframes';
    for (const mesh of [leds, bodies]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    scene.add(group);
  }

  function draw(camera, stagePlan, seconds) {
    const started = performance.now();
    const stage = sampleDroneChoreography(stagePlan, seconds, poses);
    cue = stage.cue;
    changing = stage.changing;
    stageId = stagePlan === plan ? plan.stages.indexOf(stage) : null;
    nearCount = 0;
    let count = 0;
    for (const p of poses) {
      const x = airspace.x - cz * p.u + cx * p.d, y = airspace.y + p.v, z = airspace.z + cx * p.u + cz * p.d;
      if (camera && Math.hypot(x - camera.x, y - camera.y, z - camera.z) < 105) {
        matrix.makeTranslation(x, y, z);
        bodies.setMatrixAt(nearCount++, matrix);
      }
      const brightness = Math.max(p.r, p.g, p.b);
      if (brightness <= 0.002) continue;
      // 保持灯体在世界空间。低亮背景的发光外壳更小，换形中连续缩放和调色。
      const scale = 0.38 + 0.92 * Math.sqrt(brightness);
      matrix.makeScale(scale, scale, scale).setPosition(x, y - 0.24, z);
      leds.setMatrixAt(count, matrix);
      tint.setRGB(p.r, p.g, p.b);
      leds.setColorAt(count++, tint);
    }
    leds.count = count;
    bodies.count = nearCount;
    leds.visible = count > 0;
    bodies.visible = nearCount > 0;
    leds.instanceMatrix.needsUpdate = bodies.instanceMatrix.needsUpdate = true;
    if (leds.instanceColor) leds.instanceColor.needsUpdate = true;
    updateMs = performance.now() - started;
  }

  return {
    available: Boolean(clear),
    get active() { return group !== null; },
    get paused() { return paused; },
    get time() { return total; },
    get cue() { return cue; },
    get replayPending() { return replayAt !== null || retreat !== null; },
    get statistics() {
      return { count: FLEET_SIZE, duration: plan.duration, minimumSpacingM: plan.minSpacing, peakSpeedMps: plan.peakSpeed,
        peakAccelerationMps2: plan.peakAcceleration, clear, stage: stageId, changing, loops, updateMs,
        meshes: group?.children.length ?? 0, lit: leds?.count ?? 0, airframes: nearCount };
    },
    start() {
      if (!clear || group) return false;
      total = cue = loops = 0;
      paused = false;
      createMeshes();
      draw(null, plan, 0);
      return true;
    },
    replay() {
      if (!group || retreat) return;
      paused = false;
      if (total < 1) { total = 0; return; }
      replayAt = plan.stages.find(stage => !stage.changing && stage.start >= total)?.start ?? plan.duration;
    },
    togglePause() { if (group) paused = !paused; },
    stop() {
      if (!group) return;
      group.removeFromParent();
      for (const mesh of [leds, bodies]) {
        mesh.dispose();
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      group = leds = bodies = retreat = replayAt = null;
      paused = false;
      nearCount = 0;
    },
    update(dt, camera) {
      if (!group || document.hidden) return;
      const delta = paused || dt > 0.5 ? 0 : Math.max(0, dt);
      if (retreat) {
        retreatTime += delta;
        if (retreatTime < retreat.duration) {
          draw(camera, retreat, retreatTime);
          return;
        }
        total = retreatTime - retreat.duration;
        retreat = null;
      } else if (replayAt !== null && total + delta >= replayAt) {
        const next = plan.replays.get(replayAt);
        retreatTime = total + delta - replayAt;
        replayAt = null;
        if (next?.duration > retreatTime) {
          retreat = next;
          draw(camera, retreat, retreatTime);
          return;
        }
        total = retreatTime - (next?.duration ?? 0);
      } else {
        total += delta;
        if (total >= plan.duration) { total -= plan.duration; loops++; }
      }
      draw(camera, plan, total);
    }
  };
}
