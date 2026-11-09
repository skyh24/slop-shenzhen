import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { decodeRing } from './data.js';
import { sceneUniforms } from './materials.js';

// 只让车跑在主次干道到支路上（roadClass 0..5）
const DRIVABLE_MAX_CLASS = 5;
const SPAWN_MAX_CLASS = 4;
const TAXI_SHARE = 0.32;
const GREEN_PLATE_SHARE = 0.85;
// 深圳出租车蓝；社会车辆以白、银、黑、灰为主，少量彩色
const TAXI_BLUE = 0x1f7ae0;
const CAR_COLORS = [0xf2f2f0, 0xf2f2f0, 0xd9dcdf, 0xb8bcc0, 0x2b2e33, 0x1a1c20, 0x5d6670, 0x2f4f7a, 0x8a1f24, 0x6a7f63, 0xc9b28c];
const PLATE_GREEN = 0x37c46c;
const PLATE_BLUE = 0x1d4fb8;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLanes(roads) {
  const lanes = [];
  const starts = new Map();
  const key = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  for (let i = 0; i < roads.cls.length; i++) {
    const cls = roads.cls[i];
    if (cls > DRIVABLE_MAX_CLASS) continue;
    const pts = decodeRing(roads.pts[i]);
    const n = pts.length / 2;
    if (n < 2) continue;
    const cum = new Float32Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]);
    const length = cum[n - 1];
    if (length < 8) continue;
    const width = roads.width[i];
    const oneway = roads.oneway[i] === 1;
    const offset = oneway ? 0 : Math.min(width / 4, 4);
    const head = key(pts[0], pts[1]);
    const tail = key(pts[n * 2 - 2], pts[n * 2 - 1]);
    const dirs = oneway ? [1] : [1, -1];
    for (const dir of dirs) {
      const lane = { pts, cum, length, dir, cls, offset, width, from: dir > 0 ? head : tail, to: dir > 0 ? tail : head, next: [] };
      lanes.push(lane);
      if (!starts.has(lane.from)) starts.set(lane.from, []);
      starts.get(lane.from).push(lane);
    }
  }
  for (const lane of lanes) {
    lane.next = (starts.get(lane.to) || []).filter((l) => !(l.to === lane.from && l.pts === lane.pts));
  }
  return lanes;
}

// 沿车道取位置：s 是沿行驶方向的距离，返回 x、z 和朝向角
function sampleLane(lane, s, out) {
  const d = lane.dir > 0 ? s : lane.length - s;
  const { cum, pts } = lane;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-3);
  const ax = pts[lo * 2], az = pts[lo * 2 + 1], bx = pts[hi * 2], bz = pts[hi * 2 + 1];
  let dx = (bx - ax) * lane.dir, dz = (bz - az) * lane.dir;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  // 靠右行驶：行进方向顺时针转 90°（x 向东、z 向南）是 (−dz, dx)
  out.x = ax + (bx - ax) * t - dz * lane.offset;
  out.z = az + (bz - az) * t + dx * lane.offset;
  out.yaw = Math.atan2(dx, dz);
}

function carGeometries() {
  const body = new THREE.BoxGeometry(1.85, 0.8, 4.7);
  body.translate(0, 0.65, 0);
  const cabin = new THREE.BoxGeometry(1.62, 0.62, 2.5);
  cabin.translate(0, 1.36, -0.25);
  const plate = new THREE.BoxGeometry(0.46, 0.15, 0.04);
  const plates = new THREE.BufferGeometry();
  const rear = plate.clone().translate(0, 0.55, -2.37);
  const front = plate.clone().translate(0, 0.5, 2.37);
  plates.setAttribute('position', new THREE.Float32BufferAttribute([...rear.attributes.position.array, ...front.attributes.position.array], 3));
  plates.setAttribute('normal', new THREE.Float32BufferAttribute([...rear.attributes.normal.array, ...front.attributes.normal.array], 3));
  const ri = rear.index.array;
  plates.setIndex([...ri, ...Array.from(front.index.array, (v) => v + rear.attributes.position.count)]);
  const sign = new THREE.BoxGeometry(0.9, 0.26, 0.34);
  sign.translate(0, 1.8, -0.2);
  const lightsGeo = new THREE.BoxGeometry(1.5, 0.14, 0.05);
  lightsGeo.translate(0, 0.78, 2.36);
  const tailGeo = new THREE.BoxGeometry(1.6, 0.12, 0.05);
  tailGeo.translate(0, 0.86, -2.36);
  return { body, cabin, plates, sign, lightsGeo, tailGeo };
}

export function createTraffic(data, count = 1400) {
  const lanes = buildLanes(data.roads);
  const spawnable = lanes.filter((l) => l.cls <= SPAWN_MAX_CLASS);
  const weights = spawnable.map((l) => l.length * (l.cls <= 2 ? 3 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const rand = rng(20261119);
  const pick = () => {
    let r = rand() * total;
    for (let i = 0; i < spawnable.length; i++) {
      r -= weights[i];
      if (r <= 0) return spawnable[i];
    }
    return spawnable[spawnable.length - 1];
  };

  const g = carGeometries();
  const bodyMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.5 });
  const glassMat = new THREE.MeshStandardNodeMaterial({ color: 0x1b2430, roughness: 0.15, metalness: 0.6 });
  const plateMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.1 });
  const signMat = new THREE.MeshStandardNodeMaterial({ color: 0xf4f4f4, roughness: 0.4 });
  signMat.emissiveNode = color(0xfff2c0).mul(sceneUniforms.night.mul(0.9).add(0.05));
  const headMat = new THREE.MeshStandardNodeMaterial({ color: 0xdfe6ee, roughness: 0.3 });
  headMat.emissiveNode = color(0xfff4dc).mul(sceneUniforms.night.mul(2.5));
  const tailMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a0d10, roughness: 0.3 });
  tailMat.emissiveNode = color(0xff2a1f).mul(sceneUniforms.night.mul(2.0).add(0.15));

  const cars = [];
  for (let i = 0; i < count; i++) {
    const lane = pick();
    const taxi = rand() < TAXI_SHARE;
    cars.push({
      lane, s: rand() * lane.length, taxi,
      speed: (lane.cls <= 1 ? 17 : 12) * (0.75 + rand() * 0.5),
      color: taxi ? TAXI_BLUE : CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)],
      plate: rand() < GREEN_PLATE_SHARE ? PLATE_GREEN : PLATE_BLUE
    });
  }
  const taxis = cars.filter((c) => c.taxi);

  const group = new THREE.Group();
  group.name = 'traffic';
  const mk = (geo, mat, n) => {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  const body = mk(g.body, bodyMat, count);
  const cabin = mk(g.cabin, glassMat, count);
  const plates = mk(g.plates, plateMat, count);
  const heads = mk(g.lightsGeo, headMat, count);
  const tails = mk(g.tailGeo, tailMat, count);
  const signs = mk(g.sign, signMat, taxis.length);
  const c = new THREE.Color();
  cars.forEach((car, i) => {
    body.setColorAt(i, c.setHex(car.color));
    plates.setColorAt(i, c.setHex(car.plate));
  });

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const sample = { x: 0, z: 0, yaw: 0 };

  function update(dt) {
    let t = 0;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      car.s += car.speed * dt;
      while (car.s > car.lane.length) {
        car.s -= car.lane.length;
        const options = car.lane.next;
        car.lane = options.length ? options[Math.floor(rand() * options.length)] : pick();
      }
      sampleLane(car.lane, car.s, sample);
      pos.set(sample.x, 0.14, sample.z);
      q.setFromAxisAngle(up, sample.yaw);
      m4.compose(pos, q, one);
      body.setMatrixAt(i, m4);
      cabin.setMatrixAt(i, m4);
      plates.setMatrixAt(i, m4);
      heads.setMatrixAt(i, m4);
      tails.setMatrixAt(i, m4);
      if (car.taxi) signs.setMatrixAt(t++, m4);
    }
    for (const m of [body, cabin, plates, heads, tails, signs]) m.instanceMatrix.needsUpdate = true;
  }

  update(0);
  return { group, update, count, lanes: lanes.length };
}
