import { STR } from './sz-strings.js';

export const LANDMARK_RADIUS = 200;

// 已有模型入口和前场优先。其余建筑用已派生的临街到达方向取景。
export function createLandmarkViews(landmarks, heights, heightAt, approaches, gateYaw) {
  const modelFront = {
    'civic-center': [0, 1],
    'convention-center': [0, -1],
    'press-tower': [0, 1],
    chunjian: [-1, 0],
    ...(Number.isFinite(gateYaw) && { 'iec-xiangmihu': [Math.sin(gateYaw), Math.cos(gateYaw)] })
  };
  return new Map(landmarks.flatMap(({ id, x, z, name, height }) => {
    const model = heights?.get(id);
    const base = model?.base ?? heightAt(x, z);
    const roof = model?.roof ?? (height > 0 && Number.isFinite(base) ? base + height : null);
    if (!Number.isFinite(roof) || !(roof > base)) return [];
    const approach = approaches[id];
    const direction = modelFront[id] ?? (approach && [approach.x - x, approach.z - z]);
    const length = direction ? Math.hypot(...direction) : 0;
    const front = length > 0 ? { x: direction[0] / length, z: direction[1] / length } : null;
    return [[id, { x, y: (base + roof) / 2, z, name, base, roof, front }]];
  }));
}

export function findLandmarkArrival(landmark, controller, findGroundArrival, roadHeight, flightStartAltitude, mode = controller.activeMode) {
  const { x, y, z, roof, front } = landmark;
  if (!front) return null;
  if (mode !== 'helicopter') {
    return findGroundArrival(landmark, mode, { front, isClear: point => !Number.isFinite(roadHeight(point.x, point.z))
      && controller.findTeleportPosition(point.x, point.z, point.heading, 0, true, null, { exact: true, mode }) });
  }
  const frontAngle = Math.atan2(front.x, front.z);
  // 优先飞到立面中部高度。正前方受阻时，先提高净空，再沿正面一侧试位。
  const preferred = Math.max(24, y + 4);
  const altitudes = new Set([preferred, Math.max(preferred, roof + 8), Math.max(preferred, flightStartAltitude)]
    .filter(Number.isFinite).map(altitude => Math.min(controller.maxFlightAltitude, altitude)));
  for (const offset of [0, 15, -15, 30, -30, 45, -45, 60, -60]) {
    const angle = frontAngle + offset * Math.PI / 180;
    const px = x + Math.sin(angle) * LANDMARK_RADIUS, pz = z + Math.cos(angle) * LANDMARK_RADIUS;
    const heading = Math.atan2(x - px, z - pz);
    for (const altitude of altitudes) {
      const point = controller.findTeleportPosition(px, pz, heading, altitude, true, null, { exact: true, mode });
      if (point) return point;
    }
  }
  return null;
}

function orbitAltitude(target, heightAt, colliders) {
  const { x, z } = target;
  let altitude = Math.max(target.base + 28, target.roof + 6);
  // 用环线实际经过的碰撞包络抬高镜头，保持整个圆周的高度一致。
  for (const collider of colliders) {
    const near = Math.hypot(Math.max(collider.minX - x, x - collider.maxX, 0),
      Math.max(collider.minZ - z, z - collider.maxZ, 0));
    const far = Math.hypot(Math.max(Math.abs(collider.minX - x), Math.abs(collider.maxX - x)),
      Math.max(Math.abs(collider.minZ - z), Math.abs(collider.maxZ - z)));
    if (near <= LANDMARK_RADIUS + 1 && far >= LANDMARK_RADIUS - 1) altitude = Math.max(altitude, collider.maxY + 6);
  }
  for (let i = 0; i < 120; i++) {
    const angle = i * 2 * Math.PI / 120;
    const ground = heightAt(x + Math.sin(angle) * LANDMARK_RADIUS, z + Math.cos(angle) * LANDMARK_RADIUS);
    if (Number.isFinite(ground)) altitude = Math.max(altitude, ground + 8);
  }
  return altitude;
}

export function wireLandmarkOrbit({ button, views, controllerManager, cameraSystem, heightAt, mapOpen, exit, onStart,
  available = () => true }) {
  function nearbyTarget() {
    const { x, z } = controllerManager.getActiveEntity().position;
    let closest = null;
    let best = LANDMARK_RADIUS + 5;
    for (const target of views.values()) {
      const distance = Math.hypot(x - target.x, z - target.z);
      if (distance > best) continue;
      closest = target;
      best = distance;
    }
    return closest;
  }

  function stop() {
    if (cameraSystem.landmarkOrbit) exit();
  }

  function update(manual = false) {
    if (!available()) {
      button.hidden = true;
      return;
    }
    const { up, down } = controllerManager.keys;
    if (!mapOpen() && (manual || up || down)) stop();
    const active = Boolean(cameraSystem.landmarkOrbit);
    const target = active ? null : nearbyTarget();
    const label = active ? STR.landmarkOrbit.stop : target ? STR.landmarkOrbit.start(target.name) : '';
    const hidden = !label || mapOpen();
    if (button.hidden !== hidden) button.hidden = hidden;
    if (button.textContent !== label) button.textContent = label;
  }

  button.addEventListener('click', () => {
    if (!available()) return;
    if (cameraSystem.landmarkOrbit) { stop(); return; }
    const target = nearbyTarget();
    if (!target || mapOpen()) return;
    const colliders = controllerManager.nearColliders(target.x, target.z, LANDMARK_RADIUS + 3, false);
    cameraSystem.startLandmarkOrbit(target, orbitAltitude(target, heightAt, colliders));
    onStart();
    update();
  });
  return { update, stop };
}
