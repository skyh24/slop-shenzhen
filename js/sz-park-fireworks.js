import * as THREE from 'three/webgpu';

export const FIREWORK_INTERVAL = 5;
const ASCENT = 1.55;
const LIFETIME = 4.55;
const RANGE = 2200;
const FULL_DETAIL = 850;
const SPARKS = 96;
const COLORS = [0xffb442, 0xff5467, 0x61aaff, 0xffdf89].map(rgb => new THREE.Color(rgb));

export function createFireworkCycle() {
  let start = null;
  let lastSlot = -1;
  let launched = 0;
  let age = Infinity;
  let variant = 0;
  return {
    update(now, night, inRange) {
      if (!night) {
        start = null;
        lastSlot = -1;
      } else {
        start ??= now;
        const slot = Math.floor((now - start) / FIREWORK_INTERVAL);
        const slotAge = now - start - slot * FIREWORK_INTERVAL;
        if (slot !== lastSlot) {
          lastSlot = slot;
          if (inRange && slotAge < ASCENT) {
            launched++;
            variant = slot % COLORS.length;
            age = slotAge;
            return;
          }
        } else if (inRange && age < LIFETIME && slotAge < LIFETIME) {
          age = slotAge;
          return;
        }
      }
      age = Infinity;
    },
    get age() { return age; },
    get variant() { return variant; },
    get launched() { return launched; },
    get phase() { return age < ASCENT ? 'ascent' : age < LIFETIME ? 'burst' : 'idle'; }
  };
}

export function buildParkFireworks(scene, launch) {
  const cycle = createFireworkCycle();
  // 单枚生命周期短于发射间隔，因此一批固定容量实例足以覆盖全部阶段。
  const mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1), new THREE.MeshBasicNodeMaterial({
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false
  }), SPARKS);
  mesh.name = 'WindowOfWorldFireworks';
  mesh.position.set(launch.x, launch.y, launch.z);
  mesh.visible = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color();
  for (let i = 0; i < SPARKS; i++) mesh.setColorAt(i, tint);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 80, 0), 110);
  scene.add(mesh);
  const heights = [103, 118, 110, 97];
  const directions = Array.from({ length: SPARKS }, (_, i) => {
    const h = 1 - 2 * ((i * 37) % SPARKS + 0.5) / SPARKS;
    const phi = i * 2.399963229728653;
    return [Math.cos(phi), Math.sin(phi), h, Math.sqrt(1 - h * h), 0.8 + 0.25 * Math.sin(i * 17.41)];
  });
  const write = (i, x, y, z, size, yScale, brightness, color) => {
    matrix.makeScale(size, size * yScale, size).setPosition(x, y, z);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, tint.copy(color).multiplyScalar(brightness));
  };
  return {
    update(now, night, camera) {
      const distance = Math.hypot(camera.x - launch.x, camera.z - launch.z);
      cycle.update(now, night, distance <= RANGE);
      const { phase, age, variant } = cycle;
      mesh.visible = phase !== 'idle';
      if (!mesh.visible) {
        mesh.count = 0;
        return;
      }
      const color = COLORS[variant];
      const height = heights[variant];
      const far = distance > FULL_DETAIL;
      const sizeBias = far ? 1.45 : 1;
      const drift = variant % 2 ? -5 : 5;
      if (phase === 'ascent') {
        mesh.count = far ? 5 : 11;
        for (let i = 0; i < mesh.count; i++) {
          const t = Math.max(0, (age - i * 0.022) / ASCENT);
          const rise = t * (1.38 - 0.38 * t);
          const fade = (1 - i / mesh.count) ** 1.5;
          write(i, drift * rise, height * rise, 0, (0.16 + 0.33 * fade) * sizeBias, 2.3, 2.5 * fade, COLORS[0]);
        }
      } else {
        mesh.count = far ? SPARKS / 2 : SPARKS;
        const t = age - ASCENT;
        const life = 1 - t / (LIFETIME - ASCENT);
        const radius = 33 * (1 - Math.exp(-t * 1.62));
        for (let i = 0; i < mesh.count; i++) {
          const [cos, sin, h, flat, variation] = directions[far ? i * 2 : i];
          const ring = variant === 1;
          const r = radius * variation;
          const flicker = 0.8 + 0.2 * Math.sin(i * 8 + t * 12);
          write(i, drift + cos * (ring ? 1 : flat) * r,
            height + h * r * (ring ? 0.2 : variant === 2 ? 1.2 : 0.85) - 2.9 * t * t,
            sin * (ring ? 1 : flat) * r, (0.67 * life + 0.15) * sizeBias,
            variant === 2 ? 1.6 : 1, 4.0 * life ** 1.75 * flicker, color);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    },
    snapshot: () => ({ phase: cycle.phase, age: Number.isFinite(cycle.age) ? cycle.age : null,
      launched: cycle.launched, particles: mesh.count }),
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  };
}
