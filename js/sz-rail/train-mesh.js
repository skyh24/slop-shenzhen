import * as THREE from 'three/webgpu';
import { mergeParts } from '../sz-mesh-utils.js';
import { TRAIN } from './dispatch.js';
import { sampleRail } from './geometry.js';

const HALF = TRAIN.carLength / 2;
const FLOOR = 0.96;
const SECTION = [[-0.77, 0], [-0.98, 0.31], [-1, 0.58], [-0.92, 0.82], [-0.68, 0.96],
  [-0.34, 1], [0.34, 1], [0.68, 0.96], [0.92, 0.82], [1, 0.58], [0.98, 0.31], [0.77, 0]];
const width = TRAIN.width / 2;
const endShape = [[-HALF, 0.96, 0.97, 0], [-11, 1, 1, 0], [1.5, 1, 1, 0], [4.8, 0.94, 0.95, 0.09],
  [7.15, 0.79, 0.79, 0.13], [9.5, 0.59, 0.53, 0.09], [11.25, 0.36, 0.29, 0.13], [HALF, 0.08, 0.07, 0.27]];
const coachShape = [[-HALF, 0.91, 0.96, 0], [-11.2, 1, 1, 0], [11.2, 1, 1, 0], [HALF, 0.91, 0.96, 0]];

function shell(stations) {
  const p = [], indices = [];
  const sides = SECTION.length;
  for (const [z, w, h, lift] of stations) {
    for (const [x, y] of SECTION) p.push(x * w * width, FLOOR + y * 2.84 * h + lift, z);
  }
  for (let i = 1; i < stations.length; i++) for (let j = 0; j < sides; j++) {
    const a = (i - 1) * sides + j, b = (i - 1) * sides + (j + 1) % sides;
    indices.push(a, b + sides, b, a, a + sides, b + sides);
  }
  for (let i = 1; i < sides - 1; i++) {
    const end = (stations.length - 1) * sides;
    indices.push(0, i, i + 1, end, end + i + 1, end + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function box(x, y, z, w, h, l) {
  return new THREE.BoxGeometry(w, h, l).translate(x, y, z);
}
function merge(geometries) {
  const result = mergeParts(geometries.map(geometry => ({ geometry })));
  return result;
}
function trim(cab) {
  const pieces = [];
  for (const sign of [-1, 1]) {
    const first = -10.4, count = cab ? 7 : 12;
    for (let i = 0; i < count; i++) pieces.push(box(sign * 1.585, 2.48, first + i * 1.8, 0.105, 0.49, 1.39));
    if (cab) {
      pieces.push(box(sign * 1.52, 2.45, 2.52, 0.105, 0.51, 1.22));
      const glass = new THREE.BoxGeometry(0.048, 0.68, 2.85).rotateY(sign * -0.14)
        .rotateX(-0.16).translate(sign * 1.36, 2.66, 5.42);
      pieces.push(glass);
    }
  }
  if (cab) pieces.push(new THREE.BoxGeometry(2.37, 0.05, 2.25).rotateX(0.3).translate(0, 3.38, 5.62));
  return merge(pieces);
}
function wheels() {
  const pieces = [];
  for (const z of [-8.1, 8.1]) {
    pieces.push(box(0, 0.56, z, 2.25, 0.47, 2.95));
    for (const x of [-0.7175, 0.7175]) for (const dz of [-0.99, 0.99]) {
      pieces.push(new THREE.CylinderGeometry(0.46, 0.46, 0.145, 10).rotateZ(Math.PI / 2).translate(x, 0.46, z + dz));
    }
  }
  return merge(pieces);
}
function stripe(cab) {
  return merge([-1, 1].map(sign => box(sign * 1.59, 1.79, cab ? -4.15 : 0, 0.085, 0.16, cab ? 13.9 : 22.65)));
}
function lights() {
  return merge([-1, 1].map(sign => box(sign * 0.51, 1.64, 10.95, 0.28, 0.135, 0.15)));
}

export function createTrainMeshes(group, dispatch) {
  const body = new THREE.MeshStandardMaterial({ color: 0xf1f2ee, roughness: 0.34, metalness: 0.21 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x263a46, roughness: 0.24, metalness: 0.27 });
  const under = new THREE.MeshStandardMaterial({ color: 0x393f43, roughness: 0.72, metalness: 0.22 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x30829b, roughness: 0.48, metalness: 0.13 });
  const head = new THREE.MeshStandardMaterial({ color: 0xe0f1fe, emissive: 0xc4e6ff, emissiveIntensity: 1.15 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xb82230, emissive: 0xe52136, emissiveIntensity: 0.83 });
  const batches = [];
  function mesh(geo, material, perTrain) {
    const instance = new THREE.InstancedMesh(geo, material, dispatch.trains.length * perTrain);
    instance.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instance.receiveShadow = true;
    // 共享池的可见实例已按相机距离筛选；不让静态包围球剔除在移动的列车。
    instance.frustumCulled = false;
    instance.count = 0;
    batches.push(instance);
    group.add(instance);
    return instance;
  }
  const coach = mesh(shell(coachShape), body, TRAIN.cars - 2), cab = mesh(shell(endShape), body, 2);
  const coachGlass = mesh(trim(false), trimMat, TRAIN.cars - 2), cabGlass = mesh(trim(true), trimMat, 2);
  const coachStripe = mesh(stripe(false), accent, TRAIN.cars - 2), cabStripe = mesh(stripe(true), accent, 2);
  const bogies = mesh(wheels(), under, TRAIN.cars);
  const joint = mesh(box(0, 2, 0, 2.1, 1.85, 0.72), under, TRAIN.cars - 1);
  const headlights = mesh(lights(), head, 1), taillights = mesh(lights(), tail, 1);
  const transform = new THREE.Object3D(), basis = new THREE.Matrix4();
  const forward = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const p = {}, a = {}, b = {}, nose = {};
  const heard = new Map();
  let visible = 0, detailed = 0, lastSound = -Infinity;
  const add = mesh => mesh.setMatrixAt(mesh.count++, transform.matrix);

  function pose(path, s, front = 1) {
    sampleRail(path, s, p);
    // 车厢以两组转向架之间的弦定姿，各节车单独取样。
    sampleRail(path, s - 8.1, a);
    sampleRail(path, s + 8.1, b);
    forward.set((b.x - a.x) * front, (b.y - a.y) * front, (b.z - a.z) * front).normalize();
    side.crossVectors(worldUp, forward).normalize();
    up.crossVectors(forward, side);
    transform.position.set(p.x, (a.y + b.y) / 2, p.z);
    transform.quaternion.setFromRotationMatrix(basis.makeBasis(side, up, forward));
    transform.updateMatrix();
  }
  function update(camera, audio, time) {
    const previous = batches.map(b => b.count);
    for (const batch of batches) batch.count = 0;
    visible = 0; detailed = 0;
    for (const train of dispatch.trains) {
      if (!train.route) { heard.delete(train.slot); continue; }
      const { points, length } = train.route;
      sampleRail(points, train.s - TRAIN.length / 2, p);
      const distance = Math.hypot(camera.x - p.x, camera.y - p.y, camera.z - p.z);
      if (distance > 4800) continue;
      visible++;
      const detail = distance < 520;
      if (detail) detailed++;
      const moving = train.speed > 1;
      if (moving && distance < 112 && heard.get(train.slot) !== train.id && time - lastSound > 5
          && audio?.railPass(train.id, p, train.speed)) {
        heard.set(train.slot, train.id); lastSound = time;
      }
      for (let i = 0; i < TRAIN.cars; i++) {
        const s = train.s - HALF - i * TRAIN.spacing;
        // 源接入段以外沿端部切线补足编组。完全驶离活动段以后才回收整列。
        if (s < -TRAIN.length || s > length + TRAIN.length) continue;
        const end = i === 0 || i === TRAIN.cars - 1;
        pose(points, s, i === TRAIN.cars - 1 ? -1 : 1);
        add(end ? cab : coach);
        add(end ? cabStripe : coachStripe);
        if (distance < 1700) add(end ? cabGlass : coachGlass);
        if (detail) {
          add(bogies);
          if (i === 0) add(headlights);
          if (i === TRAIN.cars - 1) add(taillights);
          else { pose(points, s - TRAIN.spacing / 2); add(joint); }
        }
      }
    }
    batches.forEach((mesh, i) => { if (mesh.count > 0 || previous[i] !== mesh.count) mesh.instanceMatrix.needsUpdate = true; });
  }
  return { update, stats: () => ({ visibleTrains: visible, detailedTrains: detailed,
    drawBatches: batches.filter(mesh => mesh.count).length, cars: coach.count + cab.count }),
  dispose() {
    for (const batch of batches) { batch.dispose(); batch.geometry.dispose(); }
    for (const material of [body, trimMat, under, accent, head, tail]) material.dispose();
  } };
}
