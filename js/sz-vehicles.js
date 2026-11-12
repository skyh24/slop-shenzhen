import * as THREE from 'three/webgpu';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { STR } from './sz-strings.js';
import { mirrorSection, roundedBox } from './vehicles.js';
import {
  BODY_SPECS, buildCarGeometry, buildCarSidePatch, buildSteerableWheelGeo, carLayout,
  carStyleCode, carTipZ, createCarWheelMaterial, createLoftedCarMaterial, setCarLocale
} from './cars.js';

// 涂装、车牌与出租车语义写在 cars.js 的 locale 分支里；这里在模块初始化时切到深圳，纽约默认行为不动。
setCarLocale('shenzhen');

const PALETTE = Object.freeze({
  blue: 0x1f8fe0, taxiBlue: 0x1f8fe0, taxiWhite: 0xf2f5f7, yellow: 0xffce28, green: 0x69bc7a, white: 0xf0f3ee,
  dark: 0x1d252f, rubber: 0x15181d, glass: 0x294651, silver: 0xa8b4b9,
  red: 0xde283c, amber: 0xffa135, light: 0xe1f6ff
});

// 车型外观全部来自纽约 loft 引擎的 BODY_SPECS：完整车身剖面、玻璃房、后视镜、轮眉内衬和顶灯。
const CAR_BODIES = Object.freeze({
  taxi: BODY_SPECS.taxi,
  sedan: BODY_SPECS.sedan,
  suv: BODY_SPECS.suv,
  minivan: BODY_SPECS.minivan,
  van: BODY_SPECS.van
});

// 碰撞与相机使用的整车尺寸由 loft 剖面推导，保证显示和碰撞是同一份几何。
function loftDimensions(body) {
  if (body._dimensions) return body._dimensions;
  const layout = carLayout(body);
  const cab = body.cabin;
  const shoulderWidth = Math.max(...body.halfWidth.map((point) => point[1])) + body.archFlare;
  const spec = Object.freeze({
    width: 2 * shoulderWidth,
    height: layout.cabinTop(layout.cabin((cab.roofFront + cab.roofRear) / 2), 0),
    length: body.zFront - body.zRear,
    wheelbase: 2 * body.wheelZ,
    track: 2 * body.wheelX,
    radius: body.wheelRadius,
    tireWidth: body.wheelRadius * 0.68,
    sill: Math.min(...body.sill.map((point) => point[1])),
    headlight: [body.headlight[0], body.headlight[1]]
  });
  body._dimensions = spec;
  return spec;
}

// 车体尺寸不含后视镜和营运顶灯，轮距、轮胎和车灯位置均为米。
const VEHICLE_SPECS = Object.freeze({
  taxi: loftDimensions(BODY_SPECS.taxi),
  sedan: loftDimensions(BODY_SPECS.sedan),
  suv: loftDimensions(BODY_SPECS.suv),
  minivan: loftDimensions(BODY_SPECS.minivan),
  van: loftDimensions(BODY_SPECS.van),
  bus: Object.freeze({ width: 2.55, height: 3.24, length: 12.2, wheelbase: 5.9, track: 2.05, radius: 0.49, tireWidth: 0.275, sill: 0.36, headlight: [0.95, 0.82] })
});

const BUS_PROFILE = [2.83, 2.89, 2.9, 2.9, 2.89, 2.85];
const ROTATION_X = [0, 0, Math.PI / 2];
const TURN = Math.PI * 2;
const ZERO = [0, 0, 0];

function materialFor(materials, finish) {
  if (materials.has(finish)) return materials.get(finish);
  const options = {
    body: { roughness: 0.36, metalness: 0.16 },
    trim: { roughness: 0.58, metalness: 0.12 },
    glass: { roughness: 0.18, metalness: 0.38 },
    canopy: { roughness: 0.16, metalness: 0.18, transparent: true, opacity: 0.4, depthWrite: false },
    brake: { roughness: 0.29, emissive: PALETTE.red, emissiveIntensity: 0.2 },
    reverse: { roughness: 0.3, emissive: PALETTE.light, emissiveIntensity: 0 }
  };
  const material = finish === 'light'
    ? new THREE.MeshBasicMaterial({ vertexColors: true })
    : new THREE.MeshStandardMaterial({ vertexColors: true, ...options[finish] });
  materials.set(finish, material);
  return material;
}

function colorGeometry(geometry, color) {
  const position = geometry.attributes.position;
  const rgb = new Float32Array(position.count * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    tint.setHex(typeof color === 'function' ? color(position.getX(i), position.getY(i), position.getZ(i)) : color);
    tint.toArray(rgb, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
}

// 静态细节按表面合并。相同的转动部件共享缓冲，阴影和灯光不计入实体边界。
function builder(materials) {
  const batches = new Map();
  const parts = [];
  function add(name, geometry, color, position = ZERO, rotation = ZERO, finish = 'body') {
    if (rotation !== ZERO) geometry.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)));
    if (position !== ZERO) geometry.translate(...position);
    geometry.deleteAttribute('uv');
    if (!geometry.index) {
      const indexed = mergeVertices(geometry);
      geometry.dispose();
      geometry = indexed;
    }
    colorGeometry(geometry, color);
    if (!batches.has(finish)) batches.set(finish, []);
    batches.get(finish).push(geometry);
    parts.push(name);
  }
  const box = (name, size, color, position, rotation, finish) => add(name, new THREE.BoxGeometry(...size), color, position, rotation, finish);
  function ball(name, size, color, position, finish) {
    add(name, new THREE.SphereGeometry(1, 16, 10).scale(...size), color, position, ZERO, finish);
  }
  function tube(name, start, end, radius, color, finish) {
    const a = new THREE.Vector3(...start);
    const delta = new THREE.Vector3(...end).sub(a);
    const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), 8);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize()));
    add(name, geometry, color, a.addScaledVector(delta, 0.5).toArray(), ZERO, finish);
  }
  function finish(group = new THREE.Group()) {
    for (const [surface, geometries] of batches) {
      const merged = mergeGeometries(geometries);
      geometries.forEach(geometry => geometry.dispose());
      const mesh = new THREE.Mesh(merged, materialFor(materials, surface));
      mesh.name = surface;
      mesh.castShadow = surface !== 'light' && surface !== 'canopy';
      mesh.receiveShadow = mesh.castShadow;
      group.add(mesh);
    }
    group.userData.parts = parts;
    return group;
  }
  return { add, box, ball, tube, finish };
}

function finalize(group, bounds = new THREE.Box3().setFromObject(group, true)) {
  const dispose = () => {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    group.traverse(({ geometry, material }) => {
      if (geometry) geometries.add(geometry);
      if (material) materials.add(material);
      if (material?.map) textures.add(material.map);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  };
  return { group, bounds, dispose };
}

function interpolateBelt(belt, z) {
  const t = Math.max(0, Math.min(5, (z + 0.5) * 5));
  const i = Math.min(4, Math.floor(t));
  return THREE.MathUtils.lerp(belt[i], belt[i + 1], t - i);
}

function wheelArchTop(spec, z, arch) {
  const distance = Math.abs(Math.abs(z) - spec.wheelbase / 2);
  if (distance >= arch) return spec.sill;
  return Math.max(spec.sill, spec.radius + Math.sqrt(arch * arch - distance * distance));
}

function addBodyShell(b, spec, belt, paint, stripe, detail) {
  const bus = spec === VEHICLE_SPECS.bus;
  const end = spec.length / 2;
  const arch = spec.radius + (bus ? 0.055 : 0.058);
  const zs = Array(detail ? 29 : 9);
  for (let i = 0; i < zs.length; i++) zs[i] = (2 * i / (zs.length - 1) - 1) * end;
  for (const z of [-end + 0.075, end - 0.075]) zs.push(z);
  for (const axle of [-spec.wheelbase / 2, spec.wheelbase / 2]) {
    const samples = detail ? 10 : 6;
    const start = Math.asin(Math.max(0, (spec.sill - spec.radius) / arch));
    for (let j = 0; j <= samples; j++) {
      const a = THREE.MathUtils.lerp(start, Math.PI - start, j / samples);
      zs.push(axle + Math.cos(a) * arch);
    }
  }
  const stripeTop = bus ? 1.21 : spec.sill + 0.26;
  const sections = [...new Set(zs)].sort((a, c) => a - c).map(z => {
    const tip = Math.max(0, 1 - (end - Math.abs(z)) / (bus ? 0.45 : 0.49));
    const hw = spec.width / 2 * (1 - (bus ? 0.072 : 0.18) * tip * tip);
    const deck = interpolateBelt(belt, z / spec.length);
    const lower = Math.min(deck - 0.075, wheelArchTop(spec, z, arch));
    const trim = Math.min(deck - 0.06, Math.max(lower + 0.006, stripeTop - 0.005));
    const edge = Math.min(deck - 0.055, Math.max(lower + 0.012, stripeTop + 0.005));
    const inner = Math.min(hw * 0.75, spec.track / 2 - spec.tireWidth / 2 - 0.22);
    const profile = [
      [inner, spec.sill - 0.035], [inner, lower - 0.008], [hw * (bus ? 0.985 : 0.935), lower],
      [hw * 0.992, trim], [hw * 0.995, edge], [hw, Math.max(edge + 0.008, deck - 0.15)],
      [hw * 0.96, deck - 0.03], [hw * 0.65, deck]
    ];
    return mirrorSection(profile, [0, deck + 0.008], z).reverse();
  });
  const shell = new LoftGeometry(sections, { capStart: true, capEnd: true });
  b.add('lofted-body-and-wheel-wells', shell, (x, y) => y < spec.sill - 0.016 ? PALETTE.dark : y < stripeTop ? stripe : paint);
}

function makeWheel(spec, materials, detail) {
  const b = builder(materials);
  const { radius, tireWidth } = spec;
  const segments = detail ? 28 : 12;
  const profile = [
    [radius * 0.58, -tireWidth / 2], [radius * 0.93, -tireWidth / 2],
    [radius, -tireWidth * 0.31], [radius, tireWidth * 0.31],
    [radius * 0.93, tireWidth / 2], [radius * 0.58, tireWidth / 2]
  ];
  const tire = new THREE.LatheGeometry(profile.map(p => new THREE.Vector2(...p)), segments);
  b.add('rounded-tire', tire, PALETTE.rubber, ZERO, ROTATION_X, 'trim');
  b.add('rim-barrel', new THREE.CylinderGeometry(radius * 0.626, radius * 0.626, tireWidth + 0.004, segments), 0x465561, ZERO, ROTATION_X, 'trim');
  if (detail) {
    for (const side of [-1, 1]) {
      const x = side * (tireWidth / 2 + 0.006);
      const rim = new THREE.TorusGeometry(radius * 0.588, radius * 0.031, 6, 22);
      b.add('machined-rim-lip', rim, PALETTE.silver, [x, 0, 0], [0, Math.PI / 2, 0], 'trim');
      b.add('wheel-hub', new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, 0.02, 10), PALETTE.silver, [x, 0, 0], ROTATION_X, 'trim');
      for (let i = 0; i < 5; i++) {
        const angle = i * TURN / 5;
        b.box('alloy-spoke', [0.018, radius * 0.5, 0.041], PALETTE.silver,
          [x, Math.cos(angle) * radius * 0.34, Math.sin(angle) * radius * 0.34], [angle, 0, 0], 'trim');
      }
    }
  }
  return b.finish();
}

function attachWheels(group, spec, template) {
  const wheels = [];
  for (const sign of [1, -1]) {
    for (const side of [-1, 1]) {
      const steerPivot = new THREE.Group();
      const tire = template.clone();
      steerPivot.position.set(side * spec.track / 2, spec.radius, sign * spec.wheelbase / 2);
      steerPivot.add(tire);
      group.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: sign === 1 });
    }
  }
  return wheels;
}

// 玩家出租车的 4 个可转向/滚动车轮直接用 loft 引擎的车轮几何：左右各一套，前轴 ±z。
// 车轮截面是 18 段 lathe，最低点略高于半径（约 5 mm）；按包围盒落地，轮胎才真正贴地。
function attachLoftWheels(group, body, detail) {
  const geometry = { '-1': buildSteerableWheelGeo(body, -1), 1: buildSteerableWheelGeo(body, 1) };
  geometry[-1].computeBoundingBox();
  geometry[1].computeBoundingBox();
  const groundOffset = -geometry[-1].boundingBox.min.y;
  const material = createCarWheelMaterial({ wheelRadius: body.wheelRadius, style: carStyleCode({ wheel: 1 }) });
  const wheels = [];
  for (const isFront of [true, false]) {
    for (const side of [-1, 1]) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(side * body.wheelX, groundOffset, isFront ? body.wheelZ : -body.wheelZ);
      const tire = new THREE.Mesh(geometry[side], material);
      tire.castShadow = detail;
      tire.receiveShadow = detail;
      steerPivot.add(tire);
      group.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront, restY: groundOffset });
    }
  }
  return wheels;
}

// canvas 贴图只在浏览器里生成；无 document 的单元测试环境返回 null，调用方跳过贴花。
function createCanvasTexture(draw, width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// 车门上的「深圳出租」：贴在建好车身的曲面侧门外皮上。
function addTaxiDoorDecals(chassis, body, localMaterials) {
  const texture = createCanvasTexture((ctx, width, height) => {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#194672';
    ctx.font = 'bold 46px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(STR.vehicleLabels?.taxi ?? '深圳出租', width / 2, height / 2 + 2);
  }, 280, 88);
  if (!texture) return;
  const material = new THREE.MeshStandardNodeMaterial({
    map: texture, transparent: true, roughness: 0.28, metalness: 0.12,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  localMaterials.push(material);
  const doorMid = (body.doors[0] + body.doors[1]) / 2;
  // 字贴随白色门板上缘定位。
  const labelY = body.szWaist - 0.14;
  for (const side of [-1, 1]) {
    const patch = new THREE.Mesh(buildCarSidePatch(body, side, doorMid - 0.4, doorMid + 0.4, labelY - 0.095, labelY + 0.095, 0.004), material);
    patch.name = 'taxi-door-lettering';
    chassis.add(patch);
  }
}

// 新能源绿牌：粤B 字样的渐变绿牌贴在前后保险杠上，倾斜跟随斜面。
function addPlateDecals(chassis, body, localMaterials) {
  const texture = createCanvasTexture((ctx, width, height) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#f7fcf8');
    gradient.addColorStop(1, '#a8dcb9');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#3f7a52';
    ctx.lineWidth = 4;
    ctx.strokeRect(3, 3, width - 6, height - 6);
    ctx.fillStyle = '#14210f';
    ctx.font = 'bold 56px "PingFang SC", "Microsoft YaHei", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('粤B·D12345', width / 2, height / 2 + 2);
  }, 512, 96);
  if (!texture) return;
  const material = new THREE.MeshStandardNodeMaterial({
    map: texture, roughness: 0.32, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  localMaterials.push(material);
  for (const front of [true, false]) {
    const y = body.plates[front ? 0 : 1];
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.008), material);
    plate.position.set(0, y, carTipZ(body, y, front) + (front ? 0.004 : -0.004));
    plate.rotation.x = Math.atan((carTipZ(body, y + 0.06, front) - carTipZ(body, y - 0.06, front)) / 0.12);
    plate.name = front ? 'front-plate' : 'rear-plate';
    chassis.add(plate);
  }
}

// 锚点在完整车身内，局部 +z 向前，+x 向左。
const DRIVER_SEAT = Object.freeze({
  pelvis: new THREE.Vector3(0, 0.58, 0.0),
  feet: Object.freeze([new THREE.Vector3(0.19, 0.24, 0.72), new THREE.Vector3(-0.19, 0.24, 0.72)]),
  hands: Object.freeze([new THREE.Vector3(0.165, 0.90, 0.47), new THREE.Vector3(-0.165, 0.90, 0.47)]),
  recline: 0.12
});

function createDriverInterior() {
  const materials = new Map();
  const b = builder(materials);
  const trim = 0x3a424b;
  const seat = 0x525d68;
  b.box('cabin-floor', [1.24, 0.05, 1.46], 0x333a42, [0, 0.305, 0.2], ZERO, 'trim');
  b.box('cabin-bulkhead', [1.2, 0.62, 0.06], trim, [0, 0.63, -0.52], ZERO, 'trim');
  b.box('cabin-dashboard', [1.2, 0.3, 0.24], 0x1e2228, [0, 0.7, 0.9], ZERO, 'trim');
  for (const side of [-1, 1]) {
    b.box('cabin-door-panel', [0.04, 0.62, 1.42], trim, [side * 0.62, 0.62, 0.2], ZERO, 'trim');
    b.box('cabin-pedal', [0.09, 0.03, 0.12], 0x111418, [side * 0.14, 0.34, 0.78], ZERO, 'trim');
  }
  b.add('driver-seat-cushion', roundedBox(0.48, 0.12, 0.5, 0.04), seat, [0, 0.52, 0.0], ZERO, 'trim');
  b.add('driver-seat-back', roundedBox(0.48, 0.64, 0.12, 0.04), seat, [0, 0.87, -0.24], [-0.12, 0, 0], 'trim');
  b.add('driver-headrest', roundedBox(0.3, 0.16, 0.1, 0.04), seat, [0, 1.16, -0.29], [-0.12, 0, 0], 'trim');
  // 方向盘：圆环面朝后上方，中心在仪表台前方；手部锚点取圆环左右两侧。
  b.add('driver-steering-wheel', new THREE.TorusGeometry(0.185, 0.022, 8, 24), 0x1a1e23, [0, 0.9, 0.47], [Math.PI + 0.32, 0, 0], 'trim');
  b.add('driver-steering-column', new THREE.CylinderGeometry(0.032, 0.036, 0.34, 10), 0x1a1e23, [0, 0.82, 0.62], [Math.PI / 2 - 0.36, 0, 0], 'trim');
  const interior = b.finish();
  interior.name = 'player-taxi-cockpit';
  interior.traverse((mesh) => { if (mesh.isMesh) { mesh.castShadow = false; mesh.receiveShadow = false; } });
  return interior;
}

function createShenzhenCarMesh({ type = 'taxi', color = PALETTE.white, detail = true } = {}) {
  const body = CAR_BODIES[type];
  if (!body) throw new Error(`Unknown Shenzhen car type: ${type}`);
  const spec = VEHICLE_SPECS[type];
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  const paint = type === 'taxi' ? PALETTE.taxiBlue : color;
  const cockpit = type === 'taxi';
  const material = createLoftedCarMaterial(body, paint);
  // 车身与轮毂材质来自 cars.js 的全局材质缓存（环境车共用），销毁时只释放本模型独有的贴花材质与几何。
  const localMaterials = [];

  const geometry = buildCarGeometry(body, false);
  if (cockpit) chassis.add(createDriverInterior());
  const bodyMesh = new THREE.Mesh(geometry, material);
  bodyMesh.name = `${type}-lofted-body`;
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  chassis.add(bodyMesh);
  if (type === 'taxi' && detail) {
    addTaxiDoorDecals(chassis, body, localMaterials);
    addPlateDecals(chassis, body, localMaterials);
  }
  group.add(chassis);

  const wheels = attachLoftWheels(group, body, detail);
  // 固定色材质的灯光状态在 carState uniform 里：x 刹车、w 倒车（转向灯语义留给环境车实例）。
  const carState = material.userData.carState;
  const setLights = detail && carState ? (braking, reversing) => {
    carState.value.x = braking ? 1 : 0;
    carState.value.w = reversing ? 1 : 0;
  } : null;
  const bounds = new THREE.Box3().setFromObject(group, true);
  const dispose = () => {
    const geometries = new Set();
    group.traverse(({ geometry }) => {
      if (geometry) geometries.add(geometry);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const decal of localMaterials) {
      if (decal.map) decal.map.dispose();
      decal.dispose();
    }
  };
  return { group, bounds, dispose, chassis, spec, wheels, setLights, seat: cockpit ? DRIVER_SEAT : null };
}

function createShenzhenBusMesh({ detail = true } = {}) {
  const spec = VEHICLE_SPECS.bus;
  const materials = new Map();
  const b = builder(materials);
  const half = spec.width / 2;
  const end = spec.length / 2;
  addBodyShell(b, spec, BUS_PROFILE, PALETTE.white, 0x429d63, detail);
  b.add('panoramic-bus-windshield', roundedBox(1.134, 0.605, 0.049, 0.082), PALETTE.glass, [0, 2.05, end], ZERO, 'glass');
  b.box('destination-panel', [1.77, 0.23, 0.047], PALETTE.dark, [0, 2.756, end], ZERO, 'trim');
  b.add('rear-window', roundedBox(1.08, 0.41, 0.054, 0.075), PALETTE.glass, [0, 2.24, -end], ZERO, 'glass');
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      if (side === -1 && [3, 6].includes(i)) continue;
      b.add('passenger-window', roundedBox(0.669, 0.463, 0.024, 0.053, 0.005), PALETTE.glass,
        [side * half, 2.105, -4.47 + 1.47 * i], [0, side * Math.PI / 2, 0], 'glass');
    }
    b.box('bus-headlight', [0.32, 0.098, 0.037], PALETTE.light, [side * 0.94, 0.82, end + 0.016], ZERO, 'light');
    b.box('bus-tail-light', [0.16, 0.38, 0.038], PALETTE.red, [side * 1.01, 1.09, -end - 0.015], ZERO, 'light');
    if (detail) {
      b.tube('mirror-arm', [side * 1.18, 2.6, 5.68], [side * 1.51, 2.6, 5.96], 0.038, PALETTE.dark, 'trim');
      b.box('bus-mirror', [0.12, 0.42, 0.18], PALETTE.dark, [side * 1.51, 2.41, 5.96], ZERO, 'trim');
    }
  }
  // 车辆的本地 +x 在朝前时对应道路左侧，客门开在本地 -x 一侧。
  for (const z of [-0.06, 4.35]) {
    b.box('passenger-door', [0.037, 1.96, 1.25], PALETTE.dark, [-half, 1.496, z], ZERO, 'trim');
    for (const dz of [-0.28, 0.28]) b.box('door-glass', [0.024, 1.49, 0.51], PALETTE.glass, [-half - 0.021, 1.635, z + dz], ZERO, 'glass');
  }
  b.add('roof-hvac', roundedBox(0.91, 0.154, 2.09, 0.114), PALETTE.white, [0, 3.052, -1.93]);
  if (detail) {
    for (let i = 0; i < 7; i++) b.box('hvac-grille', [1.28, 0.015, 0.049], PALETTE.dark, [0, 3.209, -2.46 + i * 0.18], ZERO, 'trim');
  }
  const group = b.finish();
  const wheels = attachWheels(group, spec, makeWheel(spec, materials, detail));
  return { ...finalize(group), spec, wheels };
}

// 环境轿车：loft 车身（不含车轮）+ 每实例涂装/灯光材质；车轮在 sz-traffic 里单独实例化。
function createTrafficCarBody(type) {
  const body = CAR_BODIES[type];
  if (!body) throw new Error(`Unknown Shenzhen car type: ${type}`);
  return { geometry: buildCarGeometry(body, false), material: createLoftedCarMaterial(body), body, spec: VEHICLE_SPECS[type] };
}

// 环境车统一一套轮毂几何（按各车半径缩放实例），左右各一份，避免 30 辆车各建一份缓冲。
function createTrafficWheels() {
  const base = BODY_SPECS.sedan;
  const left = buildSteerableWheelGeo(base, -1);
  const right = buildSteerableWheelGeo(base, 1);
  left.computeBoundingBox();
  return {
    left,
    right,
    material: createCarWheelMaterial({ instanced: true }),
    baseRadius: base.wheelRadius,
    // 车轮截面是 18 段 lathe，最低点略高于半径；实例按这个偏移落地，轮胎才真正贴地。
    groundOffset: -left.boundingBox.min.y
  };
}

// 公交沿用顶点色合并几何；轿车不再走这条低细节路径。
function createTrafficVehicleGeometry({ type = 'bus' } = {}) {
  switch (type) {
    case 'bus': {
      const model = createShenzhenBusMesh({ detail: false });
      model.group.updateMatrixWorld(true);
      const copies = [];
      model.group.traverse(object => {
        if (object.geometry) copies.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
      });
      const geometry = mergeGeometries(copies);
      for (const copy of copies) copy.dispose();
      model.dispose();
      return geometry;
    }
    default:
      throw new Error(`Unhandled traffic geometry type: ${type}`);
  }
}

const CYCLE_RADIUS = 0.335;
function createSharedCycleMesh({ color = 'yellow', electric = false } = {}) {
  if (color !== 'yellow' && color !== 'blue') throw new Error(`Unknown shared cycle color: ${color}`);
  const materials = new Map();
  const b = builder(materials);
  const paint = PALETTE[color];
  const rear = [0, CYCLE_RADIUS, -0.553];
  const front = [0, CYCLE_RADIUS, 0.608];
  const bracket = [0, 0.335, -0.098];
  const seat = [0, 0.929, -0.235];
  const bars = [0, 1.062, 0.389];
  const stem = [0, 0.853, 0.416];
  const crankLength = 0.159;
  const gripHalf = 0.243;
  const downTube = [0, 0.52, 0.231];
  b.tube('seat-tube', bracket, [0, seat[1] - 0.025, seat[2]], 0.034, paint);
  b.tube('low-step-frame', bracket, downTube, 0.047, paint);
  b.tube('rising-down-tube', downTube, stem, 0.041, paint);
  for (const side of [-1, 1]) {
    const hub = [side * 0.065, rear[1], rear[2]];
    b.tube('rear-seat-stay', [0, 0.695, -0.2], hub, 0.022, paint);
    b.tube('rear-chain-stay', [side * 0.07, bracket[1], bracket[2]], hub, 0.024, paint);
    b.tube('front-fork', stem, [side * 0.051, front[1], front[2]], 0.023, paint);
    b.tube('rubber-grip', [side * 0.176, bars[1], bars[2]], [side * 0.31, bars[1], bars[2] - 0.05], 0.023, PALETTE.dark, 'trim');
    b.tube('brake-lever', [side * 0.18, bars[1] - 0.012, bars[2]], [side * 0.273, bars[1] - 0.024, bars[2] + 0.048], 0.009, PALETTE.silver, 'trim');
  }
  b.tube('handlebar-stem', stem, bars, 0.023, PALETTE.silver, 'trim');
  b.tube('handlebar', [-0.2, bars[1], bars[2]], [0.2, bars[1], bars[2]], 0.018, PALETTE.silver, 'trim');
  b.add('padded-saddle', roundedBox(0.102, 0.028, 0.27, 0.024), PALETTE.dark, [0, seat[1] - 0.028, seat[2]], ZERO, 'trim');
  b.box('chain-guard', [0.031, 0.126, 0.529], paint, [-0.079, bracket[1], -0.319]);
  b.box('rear-wheel-lock', [0.158, 0.083, 0.112], PALETTE.dark, [0, 0.66, -0.474], ZERO, 'trim');
  b.tube('rear-reflector-bracket', [0, 0.659, -0.505], [0, 0.715, -0.77], 0.015, PALETTE.dark, 'trim');
  b.box('rear-reflector', [0.071, 0.036, 0.018], PALETTE.red, [0, 0.715, -0.777], ZERO, 'light');
  b.box('front-reflector', [0.068, 0.036, 0.018], PALETTE.light, [0, 0.819, 0.714], ZERO, 'light');

  // 挡泥板与辐条共用车轮中心。篮框保留透空网格和底板。
  for (const axle of [rear, front]) {
    b.add('mudguard', new THREE.TorusGeometry(CYCLE_RADIUS + 0.015, 0.031, 6, 18, Math.PI * 0.74), paint,
      axle, [Math.PI * 0.1, Math.PI / 2, 0], 'trim');
  }
  const basket = { halfX: 0.193, bottom: 0.814, top: 0.991, rear: 0.504, front: 0.814 };
  b.box('basket-floor', [0.337, 0.021, 0.277], PALETTE.dark, [0, basket.bottom, 0.658], ZERO, 'trim');
  for (const y of [basket.bottom, basket.top]) {
    for (const side of [-1, 1]) {
      const x = side * basket.halfX;
      b.tube('basket-edge', [x, y, basket.rear], [x, y, basket.front], 0.01, PALETTE.dark, 'trim');
    }
    for (const z of [basket.rear, basket.front]) b.tube('basket-edge', [-basket.halfX, y, z], [basket.halfX, y, z], 0.01, PALETTE.dark, 'trim');
  }
  for (const x of [-basket.halfX, basket.halfX]) for (let i = 0; i < 6; i++) {
    const z = THREE.MathUtils.lerp(basket.rear, basket.front, i / 5);
    b.tube('basket-wire', [x, basket.bottom, z], [x, basket.top, z], 0.006, PALETTE.dark, 'trim');
  }
  for (const z of [basket.rear, basket.front]) for (let i = 1; i < 6; i++) {
    const x = basket.halfX * (i / 3 - 1);
    b.tube('basket-wire', [x, basket.bottom, z], [x, basket.top, z], 0.006, PALETTE.dark, 'trim');
  }
  if (electric) {
    b.add('battery-case', roundedBox(0.111, 0.148, 0.291, 0.035), PALETTE.dark, [0, 0.48, -0.01], ZERO, 'trim');
    b.add('rear-cargo-case', roundedBox(0.211, 0.174, 0.392, 0.049), paint, [0, 0.944, -0.641]);
  }
  const group = b.finish();
  const wheel = builder(materials);
  for (const [name, major, minor, tint] of [
    ['bicycle-tire', 0.309, 0.026, PALETTE.rubber], ['bicycle-rim', 0.281, 0.012, PALETTE.silver]
  ]) wheel.add(name, new THREE.TorusGeometry(major, minor, 8, 32), tint, ZERO, [0, Math.PI / 2, 0], 'trim');
  for (let i = 0; i < 14; i++) {
    const a = i * TURN / 14;
    wheel.tube('bicycle-spoke', [i % 2 ? -0.022 : 0.022, 0, 0], [0, Math.sin(a) * 0.278, Math.cos(a) * 0.278], 0.0035, PALETTE.silver, 'trim');
  }
  wheel.add('bicycle-hub', new THREE.CylinderGeometry(0.049, 0.049, 0.12, 12), PALETTE.dark, ZERO, ROTATION_X, 'trim');
  const frontWheel = wheel.finish();
  const rearWheel = frontWheel.clone();
  frontWheel.position.set(...front);
  rearWheel.position.set(...rear);
  group.add(frontWheel, rearWheel);

  const crank = builder(materials);
  const crankPivot = new THREE.Group();
  crankPivot.position.set(...bracket);
  const pedals = [];
  for (const side of [1, -1]) {
    crank.tube('crank-arm', [side * 0.074, 0, 0], [side * 0.074, -side * crankLength, 0], 0.015, PALETTE.silver, 'trim');
    const pedal = builder(materials);
    pedal.box('rubber-pedal', [0.111, 0.022, 0.082], PALETTE.dark, ZERO, ZERO, 'trim');
    pedal.box('pedal-reflector', [0.089, 0.012, 0.012], PALETTE.amber, [0, 0, -0.038], ZERO, 'trim');
    const part = pedal.finish();
    part.position.set(side * 0.1, -side * crankLength, 0);
    crankPivot.add(part);
    pedals.push(part);
  }
  crankPivot.add(crank.finish());
  group.add(crankPivot);
  const bikeFrame = {
    seat: new THREE.Vector3(...seat), bars: new THREE.Vector3(...bars),
    bracket: new THREE.Vector3(...bracket), gripHalf, crankLength
  };
  return { ...finalize(group), frontWheel, rearWheel, crankPivot, pedals, bikeFrame, radius: CYCLE_RADIUS };
}

function addLandingSkids(b, cargo) {
  const reach = cargo ? 0.5 : 1.3;
  const height = cargo ? 0.024 : 0.049;
  const top = cargo ? 0.623 : 0.855;
  for (const side of [-1, 1]) {
    const x = side * (cargo ? 0.383 : 0.81);
    for (const sign of [-1, 1]) {
      b.tube('skid-strut', [x, height, sign * reach * 0.64], [x * 0.77, top, sign * reach * 0.64], cargo ? 0.022 : 0.04, PALETTE.silver, 'trim');
      b.tube('skid-raised-tip', [x, height, sign * reach * 0.8], [x, height + (cargo ? 0.06 : 0.11), sign * reach], height, PALETTE.dark, 'trim');
    }
    b.tube('landing-skid', [x, height, -reach * 0.8], [x, height, reach * 0.8], height, PALETTE.dark, 'trim');
  }
}

// 座舱乘员：一名坐姿飞行员。头、躯干在座舱玻璃后，双臂前伸到操纵台，双腿折进脚部空间。
// 衣服用浅灰白衬衣 + 深色马甲、皮肤色头部，逆光和透过舱盖时都能看出「有人坐着」。
function addSeatedPilot(b) {
  const x = -0.37;
  const shirt = 0xd9e2e8;
  const vest = 0x2f3d4c;
  const trouser = 0x3a4753;
  const skin = 0xe3b995;
  for (const side of [-1, 1]) {
    const shoulderX = x + side * 0.15;
    const hipX = x + side * 0.09;
    b.tube('pilot-upper-arm', [shoulderX, 1.77, -0.23], [x + side * 0.2, 1.58, 0.12], 0.047, shirt);
    b.tube('pilot-forearm', [x + side * 0.2, 1.58, 0.12], [x + side * 0.12, 1.46, 0.5], 0.038, shirt);
    b.ball('pilot-hand', [0.046, 0.032, 0.052], skin, [x + side * 0.12, 1.45, 0.54]);
    b.tube('pilot-thigh', [hipX, 1.48, -0.24], [hipX + side * 0.02, 1.49, 0.14], 0.063, trouser);
    b.tube('pilot-shin', [hipX + side * 0.02, 1.49, 0.14], [hipX + side * 0.02, 1.32, 0.53], 0.053, trouser);
    b.box('pilot-foot', [0.1, 0.07, 0.19], 0x14171b, [hipX + side * 0.02, 1.285, 0.6], ZERO, 'trim');
    b.ball('pilot-shoulder', [0.085, 0.07, 0.08], shirt, [shoulderX, 1.77, -0.23]);
  }
  b.box('pilot-pelvis', [0.26, 0.14, 0.22], trouser, [x, 1.49, -0.3], ZERO, 'trim');
  b.box('pilot-torso', [0.34, 0.36, 0.26], shirt, [x, 1.69, -0.27], [0.16, 0, 0]);
  // 马甲只贴在躯干前后外皮上，避免把浅色衬衣全部盖住
  b.box('pilot-vest-front', [0.3, 0.26, 0.03], vest, [x, 1.67, -0.13], [0.16, 0, 0], 'trim');
  b.box('pilot-vest-back', [0.3, 0.26, 0.03], vest, [x, 1.67, -0.41], [0.16, 0, 0], 'trim');
  b.ball('pilot-head', [0.112, 0.125, 0.115], skin, [x, 1.94, -0.19]);
  b.ball('pilot-cap', [0.118, 0.055, 0.12], 0x1e2733, [x, 2.005, -0.21], 'trim');
  b.box('pilot-visor', [0.17, 0.02, 0.05], 0x101519, [x, 1.97, -0.085], ZERO, 'trim');
}

const EVTOL_CANOPY_HEIGHT = 1.35;

function addPassengerBody(b) {
  b.ball('white-fuselage', [0.916, 0.431, 1.44], PALETTE.white, [0, 0.957, -0.038]);
  b.ball('lower-technical-fairing', [0.723, 0.284, 0.98], PALETTE.dark, [0, 0.745, -0.18], 'trim');
  const canopy = new THREE.SphereGeometry(1, 32, 14, 0, TURN, 0, Math.PI * 0.5).scale(0.872, EVTOL_CANOPY_HEIGHT, 1.315);
  // 舱盖用浅蓝灰半透明，追尾机位能看到舱内的白色衬衣飞行员，而不是一块暗色玻璃。
  b.add('panoramic-canopy', canopy, 0x9dc4d6, [0, 1.132, 0.01], ZERO, 'canopy');
  const gasket = new THREE.TorusGeometry(1, 0.026, 8, 42).rotateX(Math.PI / 2).scale(0.879, 1, 1.318);
  b.add('canopy-sill', gasket, PALETTE.dark, [0, 1.13, 0.01], ZERO, 'trim');
  for (let i = 0; i < 12; i++) {
    const a = Math.PI * i / 12;
    const c = Math.PI * (i + 1) / 12;
    b.tube('center-canopy-frame', [0, 1.13 + EVTOL_CANOPY_HEIGHT * Math.sin(a), 0.01 + 1.321 * Math.cos(a)],
      [0, 1.13 + EVTOL_CANOPY_HEIGHT * Math.sin(c), 0.01 + 1.321 * Math.cos(c)], 0.023, PALETTE.white);
  }
  for (const side of [-1, 1]) {
    b.add('seat-back', roundedBox(0.201, 0.284, 0.17, 0.054), 0x434c58, [side * 0.32, 1.44, -0.47], [-0.17, 0, 0], 'trim');
    b.add('seat-cushion', roundedBox(0.203, 0.064, 0.551, 0.049), 0x434c58, [side * 0.32, 1.24, -0.155], ZERO, 'trim');
    b.box('seat-harness', [0.048, 0.442, 0.031], PALETTE.silver, [side * 0.32, 1.44, -0.37], [-0.18, 0, 0], 'trim');
    b.box('door-handle', [0.034, 0.047, 0.177], PALETTE.silver, [side * 0.885, 1.17, 0.21], ZERO, 'trim');
  }
  b.add('instrument-console', roundedBox(0.49, 0.065, 0.24, 0.044), PALETTE.dark, [0, 1.38, 0.79], [-0.28, 0, 0], 'trim');
  b.box('instrument-display', [0.48, 0.041, 0.022], 0x83d9ff, [0, 1.392, 0.659], [-0.28, 0, 0], 'light');
  const band = new THREE.TorusGeometry(1, 0.026, 8, 40).rotateX(Math.PI / 2).scale(0.844, 1, 1.321);
  b.add('belly-blue-light-band', band, 0x4298ff, [0, 0.774, -0.04], ZERO, 'light');
  b.ball('white-tail-light', [0.055, 0.049, 0.049], PALETTE.light, [0, 1.04, -1.463], 'light');
}

function addCargoBody(b) {
  b.add('white-sensor-hull', roundedBox(0.43, 0.147, 1.02, 0.121), PALETTE.white, [0, 0.671, 0]);
  b.box('lower-frame', [0.59, 0.079, 0.69], PALETTE.dark, [0, 0.548, 0], ZERO, 'trim');
  b.add('cargo-lid', roundedBox(0.341, 0.044, 0.681, 0.024), PALETTE.dark, [0, 0.533, 0], ZERO, 'trim');
  for (const side of [-1, 1]) {
    b.box('cargo-latch', [0.059, 0.106, 0.029], PALETTE.silver, [side * 0.21, 0.446, 0.337], ZERO, 'trim');
    b.box('cargo-rail', [0.04, 0.054, 0.6], PALETTE.dark, [side * 0.236, 0.109, 0], ZERO, 'trim');
    b.ball('stereo-camera', [0.044, 0.043, 0.038], PALETTE.glass, [side * 0.115, 0.685, 0.519], 'glass');
  }
  b.ball('downward-camera', [0.062, 0.036, 0.057], PALETTE.glass, [0, 0.508, 0.41], 'glass');
}

function makeRotor(materials, cargo) {
  const b = builder(materials);
  const blades = cargo ? 3 : 2;
  const radius = cargo ? 0.316 : 0.982;
  const chord = cargo ? 0.052 : 0.146;
  const hub = cargo ? 0.041 : 0.109;
  b.add('rotor-hub', new THREE.CylinderGeometry(hub, hub * 0.89, hub * 0.66, 12), PALETTE.silver, ZERO, ZERO, 'trim');
  for (let i = 0; i < blades; i++) {
    const angle = i * TURN / blades;
    const shape = new THREE.Shape([
      new THREE.Vector2(hub * 0.7, -chord * 0.21), new THREE.Vector2(radius * 0.43, -chord * 0.52),
      new THREE.Vector2(radius * 0.93, -chord * 0.46), new THREE.Vector2(radius, -chord * 0.13),
      new THREE.Vector2(radius * 0.974, chord * 0.16), new THREE.Vector2(radius * 0.5, chord * 0.5),
      new THREE.Vector2(hub * 0.7, chord * 0.26)
    ]);
    const depth = cargo ? 0.008 : 0.019;
    const geo = new THREE.ExtrudeGeometry(shape, { bevelEnabled: false, depth })
      .translate(0, 0, -depth / 2).rotateX(-Math.PI / 2).rotateY(angle);
    b.add('tapered-rotor-blade', geo, (x, y, z) => Math.hypot(x, z) >= radius * 0.916 ? PALETTE.yellow : PALETTE.dark, ZERO, ZERO, 'trim');
  }
  return b.finish();
}

function rotorSweep(part, bounds) {
  let radius = 0, bottom = Infinity, top = -Infinity;
  const local = part.children[0].geometry.attributes.position;
  for (let i = 0; i < local.count; i++) {
    radius = Math.max(radius, Math.hypot(local.getX(i), local.getZ(i)));
    bottom = Math.min(bottom, local.getY(i));
    top = Math.max(top, local.getY(i));
  }
  const { x, y, z } = part.position;
  bounds.expandByPoint(new THREE.Vector3(x - radius, y + bottom, z - radius));
  bounds.expandByPoint(new THREE.Vector3(x + radius, y + top, z + radius));
  return radius;
}

// 四旋翼驾驶位锚点（机身局部坐标）：座垫上沿 1.27 m，脚进脚部空间，双手扶操纵台。
// 同一玩家角色从这里绑定坐姿；内置飞行员模型只作空机展示，玩家登机后隐藏。
const EVTOL_SEAT = Object.freeze({
  pelvis: new THREE.Vector3(-0.32, 1.31, -0.24),
  feet: Object.freeze([new THREE.Vector3(-0.23, 1.24, 0.58), new THREE.Vector3(-0.41, 1.24, 0.58)]),
  hands: Object.freeze([new THREE.Vector3(-0.20, 1.43, 0.36), new THREE.Vector3(-0.44, 1.43, 0.36)]),
  recline: 0.1
});

function createAircraft(cargo) {
  const materials = new Map();
  const b = builder(materials);
  if (cargo) addCargoBody(b);
  else addPassengerBody(b);
  addLandingSkids(b, cargo);
  const mounts = [];
  for (const side of [-1, 1]) for (const fore of [-1, 1]) {
    const x = side * (cargo ? 0.754 : 2.08);
    const y = cargo ? 0.79 : 1.28;
    const z = fore * (cargo ? 0.658 : 1.83);
    const attach = [side * (cargo ? 0.32 : 0.57), cargo ? 0.668 : 1.047, fore * (cargo ? 0.23 : 0.54)];
    const motorRadius = cargo ? 0.082 : 0.154;
    b.tube('motor-boom', attach, [x, y, z], cargo ? 0.043 : 0.103, PALETTE.white);
    b.tube('boom-brace', [attach[0], attach[1] - (cargo ? 0.042 : 0.17), attach[2]], [x, y - 0.045, z], cargo ? 0.018 : 0.036, PALETTE.dark, 'trim');
    b.add('motor-pod', new THREE.CylinderGeometry(motorRadius, motorRadius * 0.86, cargo ? 0.094 : 0.164, 16),
      PALETTE.dark, [x, y, z], ZERO, 'trim');
    b.add('motor-cap', new THREE.CylinderGeometry(motorRadius * 0.68, motorRadius * 0.8, cargo ? 0.043 : 0.062, 16),
      PALETTE.silver, [x, y + (cargo ? 0.066 : 0.094), z], ZERO, 'trim');
    const lamp = cargo ? 0.026 : 0.047;
    b.ball('navigation-light', [lamp, lamp * 0.63, lamp], side > 0 ? PALETTE.red : 0x47ff86,
      [x + side * motorRadius, y - 0.018, z], 'light');
    mounts.push({ position: [x, y + (cargo ? 0.1 : 0.151), z], direction: side * fore });
  }
  const group = b.finish();
  let cargoBox = null, statusLight = null;
  if (cargo) {
    const container = builder(materials);
    container.add('cargo-container', roundedBox(0.321, 0.205, 0.655, 0.047), PALETTE.yellow, [0, 0.323, 0]);
    cargoBox = container.finish();
    group.add(cargoBox);
    const beacon = builder(materials);
    beacon.ball('bottom-beacon', [0.038, 0.017, 0.036], PALETTE.light, [0, 0.109, -0.278], 'light');
    statusLight = beacon.finish();
    group.add(statusLight);
    group.userData.parts.push(...cargoBox.userData.parts, ...statusLight.userData.parts);
  }
  // 内置飞行员单独成组，玩家登机后整组隐藏，换成同一个玩家角色的坐姿。
  let pilot = null;
  if (!cargo) {
    const pilotMaterials = new Map();
    const pilotBuilder = builder(pilotMaterials);
    addSeatedPilot(pilotBuilder);
    pilot = pilotBuilder.finish();
    pilot.name = 'pilot';
    group.add(pilot);
    group.userData.parts.push(...pilot.userData.parts);
    pilot.traverse((mesh) => { if (mesh.isMesh) { mesh.castShadow = false; mesh.receiveShadow = false; } });
  }
  const bounds = new THREE.Box3().setFromObject(group, true);
  const template = makeRotor(materials, cargo);
  const rotors = mounts.map(({ position, direction }) => {
    const part = template.clone();
    part.position.set(...position);
    part.userData.direction = direction;
    part.userData.sweptRadius = rotorSweep(part, bounds);
    group.add(part);
    return part;
  });
  return { ...finalize(group, bounds), rotors, pilot, cargoBox, statusLight, seat: cargo ? null : EVTOL_SEAT,
    setOccupantVisible(visible) { if (pilot) pilot.visible = Boolean(visible); },
    update(dt, throttle = 0) {
    if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(throttle)) throw new Error('Invalid rotor update');
    const angularSpeed = THREE.MathUtils.clamp(throttle, 0, 1) * (cargo ? 137 : 73);
    for (const rotor of rotors) rotor.rotation.y = (rotor.rotation.y + dt * angularSpeed * rotor.userData.direction) % TURN;
  } };
}

function createEvtolMesh() { return createAircraft(false); }
function createCargoDroneMesh() { return createAircraft(true); }

export { PALETTE, VEHICLE_SPECS, createShenzhenCarMesh, createShenzhenBusMesh, createTrafficVehicleGeometry,
  createTrafficCarBody, createTrafficWheels, createSharedCycleMesh, createEvtolMesh, createCargoDroneMesh,
  wheelArchTop, rotorSweep, carStyleCode };
