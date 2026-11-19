import * as THREE from 'three/webgpu';
import { normalView, positionViewDirection, smoothstep, uniform, uv } from 'three/tsl';

// 灯位取专模屋面。市民中心从西到东取五个面板中心，塔冠取最高截面的中心。
function roofAnchors(colliders) {
  const panels = [];
  let crown;
  for (const part of colliders) {
    if (part.landmarkId === 'civic-center' && part.name.startsWith('civic-center:canopy:')) {
      const { outer, top } = part.roofPanel;
      const point = new THREE.Vector3();
      outer.forEach((p, i) => point.add(new THREE.Vector3(p.x, top[i], p.z)));
      panels.push(point.divideScalar(outer.length));
    }
    if (part.landmarkId === 'ping-an' && part.name.endsWith(':diamond-crown')) {
      const ring = part.loft.upper;
      crown = new THREE.Vector3(ring.reduce((s, p) => s + p.x, 0) / ring.length, part.maxY,
        ring.reduce((s, p) => s + p.z, 0) / ring.length);
    }
  }
  const bounds = new THREE.Box3().setFromPoints(panels);
  const civic = [];
  for (const fraction of [0.13, 0.30, 0.50, 0.70, 0.87]) {
    if (!panels.length) break;
    const x = THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, fraction);
    const z = THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, 0.24);
    const distance = p => (p.x - x) ** 2 + (p.z - z) ** 2;
    civic.push(panels.reduce((best, p) => distance(p) < distance(best) ? p : best));
  }
  return { civic, crown };
}

// 每盏灯的相邻目标由灯号和拍号固定，回放时保持原编舞，目标之间平滑插值。
function sweep(index, seconds) {
  const beat = seconds / (3.4 + index * 0.37) + index * 0.61;
  const step = Math.floor(beat), phase = beat - step;
  const offset = n => {
    const h = Math.sin((index + 1) * 127.1 + n * 311.7) * 43758.5453;
    return (h - Math.floor(h) - 0.5) * 40;
  };
  return THREE.MathUtils.degToRad((index - 2) * 11
    + THREE.MathUtils.lerp(offset(step), offset(step + 1), phase * phase * (3 - 2 * phase)));
}

export function buildCbdSearchlights(scene, colliders, night) {
  const { civic, crown } = roofAnchors(colliders);
  const group = new THREE.Group();
  group.name = 'cbd-searchlights';
  group.visible = false;
  scene.add(group);
  // 开口圆台沿本地 +Y 从灯口向外扩散。侧边、远端渐隐，建筑按已有深度遮挡光束。
  const geometry = new THREE.CylinderGeometry(1, 0.045, 1, 24, 1, true).translate(0, 0.5, 0);
  const axial = uv().y.oneMinus().pow(1.35);
  const softEdge = normalView.dot(positionViewDirection).abs().pow(1.6);
  const intensity = uniform(1);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false });
  material.opacityNode = axial.mul(softEdge).mul(smoothstep(0.32, 0.72, night));
  const burstMaterial = material.clone();
  burstMaterial.opacityNode = material.opacityNode.mul(intensity);
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion(), matrix = new THREE.Matrix4();
  function batch(name, colors, surface) {
    const mesh = new THREE.InstancedMesh(geometry, surface, colors.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    colors.forEach((color, i) => mesh.setColorAt(i, new THREE.Color(color).multiplyScalar(1.65)));
    group.add(mesh);
    return mesh;
  }
  function aim(mesh, index, point, length, width) {
    rotation.setFromUnitVectors(up, direction.normalize());
    mesh.setMatrixAt(index, matrix.compose(point, rotation, scale.set(width, length, width)));
  }
  const wash = batch('civic-roof-sweep', civic.map(() => 0x81c9ff), material);
  wash.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const palette = [0x398dff, 0x7c64ff, 0xff527e, 0xffb640, 0xffe56b, 0x48b9ff];
  const burst = batch('ping-an-crown-burst', crown ? Array.from({ length: 24 }, (_, i) => palette[i % palette.length]) : [], burstMaterial);
  for (let i = 0; i < burst.count; i++) {
    const a = i * Math.PI * 2 / burst.count;
    direction.set(Math.cos(a), Math.sin(a) * 0.84, -0.52 + 0.20 * Math.sin(a));
    aim(burst, i, crown, 250 + 30 * Math.cos(3 * a), 6.5);
  }
  burst.instanceMatrix.needsUpdate = true;
  return {
    group,
    update(seconds, remaining) {
      group.visible = true;
      civic.forEach((point, i) => {
        const a = sweep(i, seconds);
        direction.set(Math.sin(a), Math.cos(a), 0.12);
        aim(wash, i, point, 340, 8.5);
      });
      wash.instanceMatrix.needsUpdate = true;
      burst.visible = burst.count > 0 && remaining > 0 && remaining <= 3;
      if (burst.visible) intensity.value = THREE.MathUtils.smoothstep(3 - remaining, 0, 0.18)
        * THREE.MathUtils.smoothstep(remaining, 0, 0.35);
    },
    hide() { group.visible = false; },
    dispose() {
      scene.remove(group);
      wash.dispose();
      burst.dispose();
      geometry.dispose();
      material.dispose();
      burstMaterial.dispose();
    }
  };
}
