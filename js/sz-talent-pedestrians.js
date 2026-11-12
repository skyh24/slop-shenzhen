import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { createWalkSweep } from './sz-public-walk.js';
import { writePedestrianCollider } from './sz-driving-motion.js';
import { TALENT_WALK_ID } from './sz-talent-waterfront.js';

const RADIUS = 0.38;
const WALK = 1.2;
const LANE = 1.20;
const RUN = 2.7;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function createTalentPedestrians(scene, waterfront, colliders) {
  if (!waterfront) return null;
  const { route, pathHeightAt, extent, arrival, viewS } = waterfront;
  const padded = { minX: extent.minX - 15, minZ: extent.minZ - 15, maxX: extent.maxX + 15, maxZ: extent.maxZ + 15 };
  // 静态验脚印与玩家使用同一铺装高度和实体；半径采样覆盖人身宽度而非只核中心线。
  const walk = {
    heightAt: pathHeightAt,
    allows(x, z, r) {
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        if (pathHeightAt(x + r * Math.cos(a), z + r * Math.sin(a)) === null) return false;
      }
      return pathHeightAt(x, z) !== null;
    }
  };
  const clear = createWalkSweep(walk, TALENT_WALK_ID, colliders, null, padded);
  const group = new THREE.Group();
  group.name = 'talent-park:pedestrians';
  const people = new PersonCrowd(14, { farDistance: 34, castShadow: false });
  group.add(...people.meshes);
  scene.add(group);
  const actors = [];
  const ground = (actor, x, z) => pathHeightAt(x, z) ?? actor.y;

  function addActor(id, s, dir, jog, watch = null) {
    const offset = dir * LANE;
    const p = route.at(s, offset);
    if (!clear(p, p, RADIUS)) return;
    const y = pathHeightAt(p.x, p.z);
    const heading = Math.atan2(p.dx * dir, p.dz * dir);
    actors.push({ ...p, id, s, dir, offset, y, heading, watch,
      pace: jog ? RUN : WALK + (id % 4) * 0.12, mode: 'walk', v: 0,
      rig: new PersonRig({ seed: 1112 + id * 83, female: id % 3 !== 1, scale: 0.91 + (id % 5) * 0.024,
        girth: 0.87 + (id % 5) * 0.05, stride: 0.96 + (id % 3) * 0.05, hair: id % 2 ? 0.4 : 0.92 }),
      collider: writePedestrianCollider({ id: `talent-park:person:${id}` }, p.x, y, p.z, heading, 0)
    });
  }
  for (let i = 0; i < 8; i++) addActor(i, 14 + i * 54, i % 2 === 0 ? 1 : -1, i % 4 === 2);
  // 少量观众从步行流进入独立驻足点。两侧通行带和玩家落点留空。
  for (let i = 0; i < 2; i++) {
    const s = viewS + (i === 0 ? -2.6 : 2.6);
    const east = route.at(s, 4.15), west = route.at(s, -4.15);
    const forward = p => (p.x - arrival.x) * Math.sin(arrival.heading) + (p.z - arrival.z) * Math.cos(arrival.heading);
    const dir = forward(east) > forward(west) ? 1 : -1;
    const pad = dir === 1 ? east : west;
    const door = route.at(s, dir * LANE);
    if (clear(door, pad, RADIUS)) addActor(10 + i, s - dir * (3.1 + i * 1.2), dir, false, { s, pad, door });
  }

  function canMove(actor, p, focus) {
    if (!clear(actor, p, RADIUS)) return false;
    const y = pathHeightAt(p.x, p.z);
    if (Math.abs(focus.y - y) < 1.7 && distance(p, focus) < 1.05 && distance(p, focus) <= distance(actor, focus)) return false;
    return actors.every(other => other === actor || Math.abs(other.y - y) > 1.65 || distance(p, other) >= 0.94
      || distance(p, other) > distance(actor, other));
  }

  function moveToward(actor, target, dt, focus, speed) {
    const length = distance(actor, target);
    if (length < 0.045) return true;
    const step = Math.min(1, speed * dt / length);
    const p = { x: actor.x + (target.x - actor.x) * step, z: actor.z + (target.z - actor.z) * step };
    if (!canMove(actor, p, focus)) return false;
    actor.heading = Math.atan2(p.x - actor.x, p.z - actor.z);
    actor.v = length * step / dt;
    actor.x = p.x;
    actor.z = p.z;
    return step === 1;
  }

  function advance(actor, dt, focus, watching) {
    actor.v = 0;
    const { watch } = actor;
    if (actor.mode === 'watch' && !watching) actor.mode = 'rejoin';
    if (actor.mode === 'watch') {
      actor.heading = arrival.heading;
      return;
    }
    if (actor.mode === 'approach' && !watching) actor.mode = 'rejoin';
    if (actor.mode === 'approach') {
      if (moveToward(actor, watch.pad, dt, focus, 0.92)) actor.mode = 'watch';
      return;
    }
    if (actor.mode === 'rejoin') {
      if (moveToward(actor, watch.door, dt, focus, 0.92)) {
        actor.mode = 'walk';
        actor.s = watch.s;
      }
      return;
    }
    if (watching && watch && Math.abs(actor.s - watch.s) < 0.65) {
      if (moveToward(actor, watch.door, dt, focus, 0.92)) actor.mode = 'approach';
      return;
    }
    if (actor.s < 1 || actor.s > route.length - 1) actor.dir = actor.s < 1 ? 1 : -1;
    const nextS = actor.s + actor.pace * actor.dir * dt;
    const lane = actor.dir * LANE;
    const look = route.at(nextS + actor.dir * 1.7, lane);
    const obstructed = distance(look, focus) < 1.12 || actors.some(other => other !== actor && distance(other, look) < 1.12);
    const wide = lane * 1.32;
    const choices = obstructed ? [wide, lane, lane * 0.45, -lane] : [lane, wide, lane * 0.45, -lane];
    for (const offset of choices) {
      const next = route.at(nextS, offset);
      const targetDistance = distance(actor, next);
      if (targetDistance < 1e-6) continue;
      // 一侧遇到设施或对向行人时尝试邻道；横移保持有限速度，无法让行就原地等待。
      if (!walk.allows(next.x, next.z, RADIUS)) continue;
      const moved = moveToward(actor, next, dt, focus, actor.pace);
      if (moved || distance(actor, next) < 0.11) actor.s = nextS;
      if (actor.v > 0) return;
    }
  }

  return {
    group, actors,
    nearColliders(x, z, radius) {
      return actors.filter(a => Math.hypot(a.x - x, a.z - z) <= radius).map(a => a.collider);
    },
    update(dt, focus, camera, isVisible, watching) {
      const active = focus.x >= padded.minX - 520 && focus.x <= padded.maxX + 520
        && focus.z >= padded.minZ - 520 && focus.z <= padded.maxZ + 520;
      people.begin();
      if (active) for (const actor of actors) {
        if (dt > 0) advance(actor, dt, focus, watching);
        actor.y = pathHeightAt(actor.x, actor.z) ?? actor.y;
        writePedestrianCollider(actor.collider, actor.x, actor.y, actor.z, actor.heading, actor.v);
        const d = distance(actor, camera);
        const draw = d < 340 && (!isVisible || isVisible(actor.x, actor.z, 7, actor.y));
        if (draw || d < 55) actor.rig.update(dt, actor.x, actor.z, actor.heading, ground, actor, 0, draw, -1);
        if (draw) people.add(actor.rig, d);
      }
      people.end();
    }
  };
}
