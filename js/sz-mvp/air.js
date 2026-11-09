import * as THREE from 'three/webgpu';
import { color, sin, time, float, step, fract } from 'three/tsl';
import { sceneUniforms } from './materials.js';

const DRONES_PER_DIRECTION = 3;
const DRONE_SPEED = 16;
const EVTOL_SPEED = 42;
// 航点放在地标南侧（海湾一侧），飞行器从塔旁经过而不是穿过塔身
const EVTOL_SIDE_OFFSET = 240;

function landmarkMap(data) {
  return new Map(data.landmarks.map((l) => [l.id, l]));
}

// 四旋翼载人飞行器：两座封闭座舱、四个涵道旋翼、航行灯
function buildEvtolModel() {
  const root = new THREE.Group();
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xf3f5f7, roughness: 0.3, metalness: 0.2 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x1d2633, roughness: 0.1, metalness: 0.7 });
  const accent = new THREE.MeshStandardNodeMaterial({ color: 0x1f7ae0, roughness: 0.4, metalness: 0.3 });
  const rotorMat = new THREE.MeshStandardNodeMaterial({ color: 0x222831, roughness: 0.6, transparent: true, opacity: 0.45 });

  const cabin = new THREE.Mesh(new THREE.CapsuleGeometry(1.05, 2.2, 8, 16), white);
  cabin.rotation.x = Math.PI / 2;
  root.add(cabin);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), dark);
  canopy.scale.set(0.95, 0.75, 1.5);
  canopy.position.set(0, 0.35, 0.6);
  root.add(canopy);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.12, 3.2), accent);
  stripe.position.y = -0.2;
  root.add(stripe);

  const rotors = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 3.0), white);
    arm.position.set(sx * 1.15, 0.45, sz * 1.15);
    arm.rotation.y = Math.atan2(sx, sz);
    root.add(arm);
    const duct = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.12, 8, 28), white);
    duct.rotation.x = Math.PI / 2;
    duct.position.set(sx * 2.25, 0.5, sz * 2.25);
    root.add(duct);
    const rotor = new THREE.Mesh(new THREE.CircleGeometry(1.05, 24), rotorMat);
    rotor.rotation.x = -Math.PI / 2;
    rotor.position.set(sx * 2.25, 0.52, sz * 2.25);
    root.add(rotor);
    rotors.push(rotor);
  }
  for (const sx of [1, -1]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 3.0), dark);
    skid.position.set(sx * 0.85, -1.35, 0);
    root.add(skid);
  }
  const nav = (hex, x, z, blink) => {
    const m = new THREE.MeshBasicNodeMaterial();
    const on = blink ? step(0.85, fract(time.mul(1.1))) : float(1);
    m.colorNode = color(hex).mul(on.mul(sceneUniforms.night.mul(3).add(1.2)));
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), m);
    s.position.set(x, 0.5, z);
    root.add(s);
  };
  nav(0xff2020, -3.4, 2.25, false);
  nav(0x20ff60, 3.4, 2.25, false);
  nav(0xffffff, 0, -1.9, true);
  return { root, rotors };
}

function buildDroneGeometry() {
  const body = new THREE.BoxGeometry(0.5, 0.18, 0.5);
  const arms = new THREE.BoxGeometry(1.3, 0.05, 0.08);
  const arms2 = arms.clone().rotateY(Math.PI / 2);
  const box = new THREE.BoxGeometry(0.34, 0.26, 0.34).translate(0, -0.3, 0);
  const parts = [body, arms.rotateY(Math.PI / 4), arms2.rotateY(Math.PI / 4), box];
  const pos = [], nrm = [], idx = [];
  let base = 0;
  for (const p of parts) {
    pos.push(...p.attributes.position.array);
    nrm.push(...p.attributes.normal.array);
    idx.push(...Array.from(p.index.array, (v) => v + base));
    base += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export function createAir(data, landmarkTops) {
  const lms = landmarkMap(data);
  const air = data.air;
  const group = new THREE.Group();
  group.name = 'air';

  const groundY = (id) => {
    const idx = data.landmarks.findIndex((l) => l.id === id);
    const top = landmarkTops.get(idx);
    return top && top.h < 140 ? top.h + 2 : 2;
  };

  // 无人机配送：起降站之间垂直爬升、巡航、下降
  const stations = new Map(air.droneStations.map((s) => {
    const lm = lms.get(s.landmark);
    return [s.id, { x: lm.x, z: lm.z, y: groundY(s.landmark) }];
  }));
  const [cruiseLo, cruiseHi] = air.droneCruiseAltitude;
  const paths = [];
  air.droneRoutes.forEach(([a, b], ri) => {
    const A = stations.get(a), Bs = stations.get(b);
    const cruise = cruiseLo + ((ri * 37) % (cruiseHi - cruiseLo + 1));
    for (const [p, q] of [[A, Bs], [Bs, A]]) {
      const pts = [
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Vector3(p.x, cruise, p.z),
        new THREE.Vector3(p.x + (q.x - p.x) * 0.15, cruise, p.z + (q.z - p.z) * 0.15),
        new THREE.Vector3(p.x + (q.x - p.x) * 0.85, cruise, p.z + (q.z - p.z) * 0.85),
        new THREE.Vector3(q.x, cruise, q.z),
        new THREE.Vector3(q.x, q.y, q.z)
      ];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      paths.push({ curve, length: curve.getLength() });
    }
  });

  const routeLines = new THREE.Group();
  routeLines.name = 'droneRoutes';
  const lineMat = new THREE.LineBasicNodeMaterial({ transparent: true, opacity: 0.55 });
  lineMat.colorNode = color(0x38e1ff).mul(sceneUniforms.night.mul(1.5).add(0.8));
  for (let i = 0; i < paths.length; i += 2) {
    const g = new THREE.BufferGeometry().setFromPoints(paths[i].curve.getSpacedPoints(80));
    routeLines.add(new THREE.Line(g, lineMat));
  }
  group.add(routeLines);

  const droneCount = paths.length * DRONES_PER_DIRECTION;
  const droneMat = new THREE.MeshStandardNodeMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.4 });
  const drones = new THREE.InstancedMesh(buildDroneGeometry(), droneMat, droneCount);
  drones.frustumCulled = false;
  drones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(drones);
  const beaconMat = new THREE.MeshBasicNodeMaterial();
  beaconMat.colorNode = color(0x39ffb0).mul(sin(time.mul(6.0)).mul(0.5).add(0.6)).mul(sceneUniforms.night.mul(2).add(1));
  const beacons = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), beaconMat, droneCount);
  beacons.frustumCulled = false;
  beacons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(beacons);
  const droneState = [];
  paths.forEach((p, pi) => {
    for (let k = 0; k < DRONES_PER_DIRECTION; k++) droneState.push({ path: p, s: (k / DRONES_PER_DIRECTION + pi * 0.13) % 1 });
  });

  // 载人飞行器：沿地标环线飞
  const via = air.evtolLoop.via.map((id) => lms.get(id)).filter(Boolean);
  const loopPts = via.map((l) => new THREE.Vector3(
    l.x, Math.max(air.evtolLoop.altitude, Math.min(l.height * 0.75, 420)), l.z + EVTOL_SIDE_OFFSET));
  const loop = new THREE.CatmullRomCurve3(loopPts, true, 'centripetal');
  const loopLength = loop.getLength();
  const evtol = buildEvtolModel();
  evtol.root.scale.setScalar(1.6);
  group.add(evtol.root);
  let evtolS = 0;

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const beaconOffset = new THREE.Vector3(0, 0.25, 0);
  let spin = 0;

  function update(dt) {
    droneState.forEach((d, i) => {
      d.s = (d.s + (DRONE_SPEED * dt) / d.path.length) % 1;
      d.path.curve.getPointAt(d.s, v);
      d.path.curve.getPointAt(Math.min(d.s + 0.01, 1), ahead);
      q.setFromAxisAngle(yAxis, Math.atan2(ahead.x - v.x, ahead.z - v.z));
      m4.compose(v, q, one);
      drones.setMatrixAt(i, m4);
      m4.compose(v.add(beaconOffset), q, one);
      beacons.setMatrixAt(i, m4);
    });
    drones.instanceMatrix.needsUpdate = true;
    beacons.instanceMatrix.needsUpdate = true;

    evtolS = (evtolS + (EVTOL_SPEED * dt) / loopLength) % 1;
    loop.getPointAt(evtolS, evtol.root.position);
    loop.getPointAt((evtolS + 0.004) % 1, ahead);
    const dx = ahead.x - evtol.root.position.x;
    const dz = ahead.z - evtol.root.position.z;
    const yaw = Math.atan2(dx, dz);
    const prevYaw = evtol.root.userData.yaw ?? yaw;
    let turn = yaw - prevYaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    evtol.root.userData.yaw = yaw;
    const bank = THREE.MathUtils.clamp(-turn / Math.max(dt, 1e-3) * 0.25, -0.35, 0.35);
    evtol.root.rotation.set(0.08, yaw, THREE.MathUtils.lerp(evtol.root.rotation.z, bank, 0.05), 'YXZ');
    spin += dt * 40;
    evtol.rotors.forEach((r, i) => { r.rotation.z = spin * (i % 2 ? 1 : -1); });
  }

  update(0);
  return { group, update, routeLines, evtol: evtol.root, droneCount };
}
