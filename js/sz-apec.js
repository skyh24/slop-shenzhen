// APEC 2026 深圳城市氛围：道旗、会场标识、花坛与转播车。
// 只用文字和中国红 / APEC 紫配色，不画 APEC 官方会徽；所有贴图在运行时用 canvas 画出，不加载外部素材。
import * as THREE from 'three/webgpu';
import { STR } from './sz-strings.js';
import { terrainHeight } from './sz-terrain.js';
import { landmarkCenter } from './sz-polygon.js';
import { sceneUniforms } from './sz-materials.js';

export { landmarkCenter };

// 工商领导人峰会 11 月 17—18 日，领导人非正式会议 11 月 18—19 日；会期 11 月 11—21 日
export const APEC_PERIOD = { firstDay: '2026-11-11', lastDay: '2026-11-21' };
export const APEC_BANNER_ROADS = ['深南大道', '滨河大道', '滨海大道'];
export const APEC_COLORS = {
  chinaRed: 0xc8102e,
  apecPurple: 0x5a2a66,
  gold: 0xd8b45a,
  ink: 0x241f24,
  white: 0xf5f1ea,
  pole: 0x3c3f43,
  bed: 0x2f4a2a,
  truck: 0xe6e2da
};
export const BANNER_WIDTH_M = 0.9;
export const BANNER_HEIGHT_M = 1.6;
export const BANNER_BOTTOM_M = 3.25;
const FLOWER_COLORS = [0xc8102e, 0x6d3f8f, 0xd9b45b, 0xf0e8dc];

// ---------- 纯函数：日期、路名、布点（不依赖渲染器，可在 node 测试） ----------

function pad2(value) {
  return String(value).padStart(2, '0');
}

// 用本地日期字符串比较，避免 UTC 偏移把会期边界挪到另一天
export function localDayString(date) {
  // 用鸭子类型判断，避免 vm 沙箱或跨 realm 的 Date 过不了 instanceof
  if (!date || typeof date.getFullYear !== 'function' || Number.isNaN(date.getTime())) {
    throw new Error('APEC date must be a valid Date');
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isApecEnabledAt(date = new Date(), period = APEC_PERIOD) {
  const day = localDayString(date);
  return day >= period.firstDay && day <= period.lastDay;
}

export function isApecBannerRoad(name, roads = APEC_BANNER_ROADS) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return roads.some((road) => name.includes(road));
}

// 只挂在已生成的路灯上，沿用灯杆位置、朝向和接触面标高。
export function bannerSites(lampSites) {
  return lampSites.filter(site => isApecBannerRoad(site.roadName));
}

// 固定哈希，替代随机数；同一输入每次结果一致
export function hash01(value) {
  const raw = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return raw - Math.floor(raw);
}

// 黄金角螺旋撒花，保证间距均匀且完全确定（不使用随机数）
export function flowerSites(center, { radiusXM = 12, radiusZM = radiusXM, count = 200, seed = 1 } = {}) {
  if (!Number.isFinite(center?.x) || !Number.isFinite(center?.z)) throw new Error('Flower bed requires a centre point');
  if (!(count > 0) || !(radiusXM > 0) || !(radiusZM > 0)) throw new Error('Flower bed options must be positive');
  const golden = Math.PI * (3 - Math.sqrt(5));
  const sites = [];
  for (let i = 0; i < count; i++) {
    const radial = Math.sqrt((i + 0.5) / count);
    const angle = i * golden + seed * 0.618;
    const wobble = 1 + (hash01(i * 1.7 + seed) - 0.5) * 0.12;
    sites.push({
      x: center.x + Math.cos(angle) * radiusXM * radial * wobble,
      z: center.z + Math.sin(angle) * radiusZM * radial * wobble,
      colorIndex: i % FLOWER_COLORS.length,
      scale: 0.75 + hash01(i * 3.1 + seed) * 0.5,
      rotation: hash01(i * 5.3 + seed) * Math.PI * 2,
      phase: hash01(i * 7.9 + seed) * Math.PI * 2
    });
  }
  return sites;
}

export function pointInArea(area, x, z) {
  if (!Array.isArray(area) || area.length !== 4 || !area.every(Number.isFinite)) return true;
  return x >= area[0] && x <= area[2] && z >= area[1] && z <= area[3];
}

// 地标绑定建筑里挑面积最大的主轮廓；没有绑定就没有真实体量依据
export function landmarkFootprint(buildings, id) {
  const matches = (buildings ?? []).filter((building) => building?.landmark === id
    && [building.minX, building.maxX, building.minZ, building.maxZ].every(Number.isFinite));
  if (matches.length === 0) return null;
  let best = matches[0];
  for (const building of matches) {
    const area = (building.maxX - building.minX) * (building.maxZ - building.minZ);
    if (area > (best.maxX - best.minX) * (best.maxZ - best.minZ)) best = building;
  }
  return { minX: best.minX, maxX: best.maxX, minZ: best.minZ, maxZ: best.maxZ,
    cx: (best.minX + best.maxX) / 2, cz: (best.minZ + best.maxZ) / 2 };
}

// 三处会场/展点标识。会展中心用真实建筑轮廓定位，其余用核实过的地标中心加示意偏移
export function apecSignSites({ landmarks = [], buildings = [], area = null, anchors = null } = {}) {
  const signs = [];
  const conventionBounds = landmarkFootprint(buildings, 'convention-center');
  const conventionCenter = landmarkCenter(landmarks, 'convention-center');
  if (conventionBounds || conventionCenter) {
    signs.push({
      id: 'convention-center-news-center',
      landmark: 'convention-center',
      kind: 'news-center',
      text: STR.apecTheme.newsCenter,
      subText: STR.apecTheme.bannerLine1,
      x: conventionBounds ? conventionBounds.cx : conventionCenter.x,
      z: conventionBounds ? conventionBounds.maxZ + 8 : conventionCenter.z + 40,
      yaw: 0,
      widthM: 9,
      heightM: 2.2,
      mountM: 2.4,
      source: conventionBounds ? 'landmark-building-bounds' : 'landmark-center+illustrative-offset'
    });
  }
  const xiangmihu = landmarkCenter(landmarks, 'iec-xiangmihu');
  const gate = anchors?.iecGate;
  if (xiangmihu || gate) {
    signs.push({
      id: 'iec-xiangmihu-gate',
      landmark: 'iec-xiangmihu',
      kind: 'venue-gate',
      text: STR.apecTheme.venueGate,
      subText: STR.apecTheme.venueGateSub,
      x: gate ? gate.x : xiangmihu.x,
      z: gate ? gate.z : xiangmihu.z + 70,
      baseY: gate && Number.isFinite(gate.baseY) ? gate.baseY : null,
      yaw: gate && Number.isFinite(gate.yaw) ? gate.yaw : 0,
      widthM: 10,
      heightM: 1.8,
      mountM: 1.1,
      source: gate ? 'landmark-model-gate' : 'landmark-center+illustrative-offset'
    });
  }
  const upperhills = landmarkCenter(landmarks, 'upperhills');
  if (upperhills) {
    signs.push({
      id: 'upperhills-gift-expo',
      landmark: 'upperhills',
      kind: 'gift-expo',
      text: STR.apecTheme.giftExpo,
      subText: STR.apecTheme.bannerLine1,
      x: upperhills.x,
      z: upperhills.z + 45,
      yaw: 0,
      widthM: 6,
      heightM: 1.4,
      mountM: 2,
      source: 'landmark-center+illustrative-offset'
    });
  }
  return area ? signs.filter((sign) => pointInArea(area, sign.x, sign.z)) : signs;
}

// 新闻中心门口两辆转播车（示意，不是实测停放位置）
export function apecSupportVehicles(signs) {
  const news = (signs ?? []).find((sign) => sign.kind === 'news-center');
  if (!news) return [];
  return [-11, 11].map((offset, index) => ({
    id: `apec-broadcast-truck-${index + 1}`,
    kind: 'broadcast-truck',
    x: news.x + offset,
    z: news.z + 7,
    yaw: 0,
    source: 'illustrative'
  }));
}

// 花田/花坛：地点来自核实过的地标中心，范围和花量为示意布置
export function apecFlowerBeds({ landmarks = [], area = null, anchors = null } = {}) {
  const beds = [];
  const xiangmihu = landmarkCenter(landmarks, 'iec-xiangmihu');
  const sea = anchors?.iecFlowerSea;
  if (xiangmihu || sea) {
    const baseX = sea ? sea.x : xiangmihu.x;
    const baseZ = sea ? sea.z : xiangmihu.z + 55;
    const baseY = sea && Number.isFinite(sea.baseY) ? sea.baseY : null;
    beds.push({ id: 'iec-xiangmihu-flower-sea', landmark: 'iec-xiangmihu', label: STR.apecTheme.flowerSea,
      x: baseX, z: baseZ, baseY, radiusXM: 18, radiusZM: 12, count: 220, seed: 11,
      source: sea ? 'landmark-model-lawn' : 'illustrative' });
    beds.push({ id: 'iec-xiangmihu-lake-bed', landmark: 'iec-xiangmihu', label: STR.apecTheme.flowerSea,
      x: baseX + 38, z: baseZ + 26, baseY, radiusXM: 26, radiusZM: 8, count: 160, seed: 12,
      source: sea ? 'landmark-model-lawn+illustrative-offset' : 'illustrative' });
  }
  const lianhuashan = landmarkCenter(landmarks, 'lianhuashan');
  if (lianhuashan) {
    beds.push({ id: 'lianhuashan-flower-bed', landmark: 'lianhuashan', label: STR.apecTheme.flowerBed,
      x: lianhuashan.x, z: lianhuashan.z, radiusXM: 20, radiusZM: 14, count: 300, seed: 21,
      source: 'landmark-center+illustrative-layout' });
  }
  return area ? beds.filter((bed) => pointInArea(area, bed.x, bed.z)) : beds;
}

// 计划层：只做布点和来源标注，不建几何；测试和统计都用它
export function planApecTheme({ lampSites = [], landmarks = [], buildings = [], area = null, anchors = null } = {}) {
  const banners = bannerSites(lampSites);
  const signs = apecSignSites({ landmarks, buildings, area, anchors });
  return { banners, signs, trucks: apecSupportVehicles(signs),
    flowerBeds: apecFlowerBeds({ landmarks, area, anchors }) };
}

// 统计口径：数量来自布点计划，渲染器只负责把计划变成网格
export function summarizeApecPlan(plan, { enabled = false } = {}) {
  const roads = [];
  for (const site of plan.banners) if (!roads.includes(site.roadName)) roads.push(site.roadName);
  return {
    period: { ...APEC_PERIOD },
    defaultEnabled: enabled,
    approach: 'text-and-colors-only-china-red-apec-purple-no-official-emblem',
    banners: {
      count: plan.banners.length,
      roads,
      mount: 'street-lamps',
      texture: 'runtime-canvas',
      source: 'osm-road-names'
    },
    signs: plan.signs.map((sign) => ({ id: sign.id, landmark: sign.landmark, kind: sign.kind,
      text: sign.text, x: sign.x, z: sign.z, source: sign.source })),
    trucks: plan.trucks.length,
    flowers: {
      beds: plan.flowerBeds.map((bed) => ({ id: bed.id, count: bed.count, source: bed.source })),
      count: plan.flowerBeds.reduce((sum, bed) => sum + bed.count, 0),
      source: 'illustrative'
    },
    illustrative: ['flower-bed layout and counts', 'broadcast trucks', 'gate offsets while venue massing is not modelled']
  };
}

// ---------- 运行时贴图：canvas 现画，不加载外部图片 ----------

function drawFiveStar(context, cx, cy, radius, rotation = -Math.PI / 2) {
  context.beginPath();
  for (let point = 0; point < 10; point++) {
    const step = point % 2 === 0 ? radius : radius * 0.382;
    const angle = rotation + (point * Math.PI) / 5;
    const x = cx + Math.cos(angle) * step;
    const y = cy + Math.sin(angle) * step;
    if (point === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.closePath();
  context.fill();
}

function createCanvasTexture(width, height, draw) {
  if (typeof document === 'undefined') throw new Error('APEC theme canvas textures require a browser');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  draw(context, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function drawBannerFace(context, width, height) {
  context.fillStyle = '#c8102e';
  context.fillRect(0, 0, width, height);
  // APEC 紫边条
  context.fillStyle = '#5a2a66';
  context.fillRect(0, 0, width * 0.06, height);
  context.fillRect(width * 0.94, 0, width * 0.06, height);
  context.strokeStyle = '#d8b45a';
  context.lineWidth = 4;
  context.strokeRect(width * 0.12, height * 0.05, width * 0.76, height * 0.9);
  // 五星图案（国旗元素，不是 APEC 会徽）
  context.fillStyle = '#f5f1ea';
  drawFiveStar(context, width * 0.3, height * 0.16, width * 0.09);
  drawFiveStar(context, width * 0.5, height * 0.08, width * 0.04);
  drawFiveStar(context, width * 0.58, height * 0.15, width * 0.04);
  drawFiveStar(context, width * 0.58, height * 0.23, width * 0.04);
  drawFiveStar(context, width * 0.5, height * 0.3, width * 0.04);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  context.font = 'bold 40px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText('APEC', width / 2, height * 0.46);
  context.fillText('CHINA', width / 2, height * 0.55);
  context.fillText('2026', width / 2, height * 0.64);
  context.fillStyle = '#d8b45a';
  context.font = 'bold 30px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(STR.apecTheme.bannerLine2, width / 2, height * 0.78);
}

function drawSignFace(title, subtitle) {
  return (context, width, height) => {
    context.fillStyle = '#c8102e';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#5a2a66';
    context.fillRect(0, 0, width, height * 0.14);
    context.fillRect(0, height * 0.86, width, height * 0.14);
    context.strokeStyle = '#d8b45a';
    context.lineWidth = 6;
    context.strokeRect(10, height * 0.16, width - 20, height * 0.68);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.font = `bold ${Math.round(height * 0.34)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    context.fillText(title, width / 2, height * 0.4);
    context.fillStyle = '#f3e2b4';
    context.font = `bold ${Math.round(height * 0.14)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    context.fillText(subtitle, width / 2, height * 0.68);
  };
}

// ---------- 几何：单位尺寸，实例按站点摆放 ----------

// 道旗是双面旗面：正反各一片三角面、背面 UV 镜像，两面文字都正向可读
function bannerGeometry() {
  const x0 = 0.02;
  const x1 = x0 + BANNER_WIDTH_M;
  const y0 = BANNER_BOTTOM_M;
  const y1 = y0 + BANNER_HEIGHT_M;
  const positions = [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0,
    x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1,
    1, 0, 0, 0, 0, 1, 1, 1];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
  geometry.computeBoundingBox();
  return geometry;
}

export function createApecGeometry() {
  const banner = bannerGeometry();
  const signBoard = new THREE.PlaneGeometry(1, 1);
  const signFrame = new THREE.BoxGeometry(1, 1, 0.12);
  const post = new THREE.BoxGeometry(0.18, 1, 0.18);
  const flower = new THREE.ConeGeometry(0.16, 0.32, 5);
  flower.translate(0, 0.16, 0);
  const bed = new THREE.CircleGeometry(1, 28);
  bed.rotateX(-Math.PI / 2);
  const truckBody = new THREE.BoxGeometry(1, 1, 1);
  return { banner, signBoard, signFrame, post, flower, bed, truckBody };
}

// ---------- 各图层：返回 group 节点、材质和 update 钩子 ----------

function buildBannerLayer(group, geometry, material, sites) {
  const banners = new THREE.InstancedMesh(geometry.banner, material, sites.length);
  banners.name = 'apec-banners';
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const oneVector = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const records = sites.map((site, index) => ({
    position: new THREE.Vector3(site.x, site.y, site.z),
    yaw: site.yaw,
    phase: hash01(index * 1.37 + site.stationM * 0.013) * Math.PI * 2
  }));
  records.forEach((record, index) => {
    quaternion.setFromAxisAngle(yAxis, record.yaw);
    matrix.compose(record.position, quaternion, oneVector);
    banners.setMatrixAt(index, matrix);
  });
  banners.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // 实例矩阵每帧由本模块改写，不能被场景静态剔除系统拆成空间分块，否则动画会写回已移除的网格
  banners.frustumCulled = false;
  group.add(banners);
  let parity = 0;
  return {
    objects: [banners],
    update(elapsed) {
      // 轻微摆动：绕灯杆轴 ±0.09 弧度，相位由确定性哈希给出。
      // 隔帧更新一半实例，控制每帧矩阵更新成本。
      parity ^= 1;
      for (let index = parity; index < records.length; index += 2) {
        const record = records[index];
        quaternion.setFromAxisAngle(yAxis, record.yaw + Math.sin(elapsed * 1.6 + record.phase) * 0.09);
        matrix.compose(record.position, quaternion, oneVector);
        banners.setMatrixAt(index, matrix);
      }
      banners.instanceMatrix.needsUpdate = true;
    }
  };
}

function buildSignLayer(group, geometry, textureFor, signs, groundY) {
  if (signs.length === 0) return null;
  const materials = [];
  const objects = [];
  for (const sign of signs) {
    const texture = textureFor(sign);
    const material = new THREE.MeshStandardNodeMaterial({
      map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.08, roughness: 0.7
    });
    const frameMaterial = new THREE.MeshStandardNodeMaterial({ color: APEC_COLORS.apecPurple, roughness: 0.68 });
    const postMaterial = new THREE.MeshStandardNodeMaterial({ color: APEC_COLORS.pole, roughness: 0.62, metalness: 0.4 });
    const signGroup = new THREE.Group();
    signGroup.name = `apec-sign:${sign.id}`;
    const signBaseY = Number.isFinite(sign.baseY) ? sign.baseY : groundY(sign.x, sign.z);
    signGroup.position.set(sign.x, signBaseY, sign.z);
    signGroup.rotation.y = sign.yaw;
    const board = new THREE.Mesh(geometry.signBoard, material);
    board.name = `apec-sign-board:${sign.id}`;
    board.scale.set(sign.widthM, sign.heightM, 1);
    board.position.set(0, sign.mountM, 0.08);
    const frame = new THREE.Mesh(geometry.signFrame, frameMaterial);
    frame.scale.set(sign.widthM + 0.4, sign.heightM + 0.4, 1);
    frame.position.set(0, sign.mountM, 0);
    const postHeight = sign.mountM - sign.heightM / 2;
    const posts = [-1, 1].map((side) => {
      const post = new THREE.Mesh(geometry.post, postMaterial);
      post.scale.set(1, Math.max(postHeight, 0.5), 1);
      post.position.set(side * (sign.widthM / 2 - 0.7), Math.max(postHeight, 0.5) / 2, 0);
      return post;
    });
    signGroup.add(frame, board, ...posts);
    group.add(signGroup);
    materials.push(material, frameMaterial, postMaterial);
    objects.push(signGroup);
  }
  return { objects, materials };
}

function buildFlowerLayer(group, geometry, beds, groundY) {
  if (beds.length === 0) return null;
  const materials = [];
  const objects = [];
  let flowers = 0;
  for (const bed of beds) {
    const centerY = Number.isFinite(bed.baseY) ? bed.baseY : groundY(bed.x, bed.z);
    const bedMaterial = new THREE.MeshStandardNodeMaterial({
      color: APEC_COLORS.bed, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    const base = new THREE.Mesh(geometry.bed, bedMaterial);
    base.name = `apec-flower-bed:${bed.id}`;
    base.position.set(bed.x, centerY + 0.06, bed.z);
    base.scale.set(bed.radiusXM, 1, bed.radiusZM);
    const flowerMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.72 });
    const sites = flowerSites({ x: bed.x, z: bed.z }, {
      radiusXM: bed.radiusXM, radiusZM: bed.radiusZM, count: bed.count, seed: bed.seed
    });
    const patch = new THREE.InstancedMesh(geometry.flower, flowerMaterial, sites.length);
    patch.name = `apec-flowers:${bed.id}`;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    sites.forEach((site, index) => {
      quaternion.setFromAxisAngle(yAxis, site.rotation);
      matrix.compose(new THREE.Vector3(site.x, centerY + 0.1, site.z), quaternion,
        new THREE.Vector3(site.scale, site.scale, site.scale));
      patch.setMatrixAt(index, matrix);
      patch.setColorAt(index, new THREE.Color(FLOWER_COLORS[site.colorIndex]));
    });
    patch.instanceColor.needsUpdate = true;
    group.add(base, patch);
    materials.push(bedMaterial, flowerMaterial);
    objects.push(base, patch);
    flowers += sites.length;
  }
  return { objects, materials, flowers };
}

function buildTruckLayer(group, geometry, trucks, groundY) {
  if (trucks.length === 0) return null;
  const bodyMaterial = new THREE.MeshStandardNodeMaterial({ color: APEC_COLORS.truck, roughness: 0.6, metalness: 0.08 });
  const glassMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x263239, roughness: 0.25, metalness: 0.35 });
  const objects = [];
  for (const truck of trucks) {
    const truckGroup = new THREE.Group();
    truckGroup.name = `apec-truck:${truck.id}`;
    truckGroup.position.set(truck.x, groundY(truck.x, truck.z), truck.z);
    truckGroup.rotation.y = truck.yaw;
    const body = new THREE.Mesh(geometry.truckBody, bodyMaterial);
    body.scale.set(6.2, 2.6, 2.3);
    body.position.set(0, 1.3, 0);
    const windshield = new THREE.Mesh(geometry.truckBody, glassMaterial);
    windshield.scale.set(1.8, 1.1, 2.32);
    windshield.position.set(2.2, 1.9, 0);
    truckGroup.add(body, windshield);
    group.add(truckGroup);
    objects.push(truckGroup);
  }
  return { objects, materials: [bodyMaterial, glassMaterial] };
}

// ---------- 对外入口 ----------

export function buildApecTheme(scene, {
  lampSites = [], lampChunkVisible = () => true, terrain = null, landmarks = [], buildings = [], area = null,
  now = null, anchors = null
} = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('APEC theme requires a scene');
  const group = new THREE.Group();
  group.name = 'shenzhen-apec-theme';
  group.visible = false;
  scene.add(group);

  const plan = planApecTheme({ lampSites, landmarks, buildings, area, anchors });
  const initialEnabled = isApecEnabledAt(now ?? new Date());
  const statistics = summarizeApecPlan(plan, { enabled: initialEnabled });
  const geometries = createApecGeometry();
  const groundY = (x, z) => {
    const height = terrain ? terrainHeight(terrain, x, z) : null;
    return Number.isFinite(height) ? height : 0;
  };

  const textures = [];
  const layers = [];
  const materials = [];
  const lit = [];
  const bannerChunks = new Map();
  // 没有道旗站点时不建贴图，空场景也能在无 canvas 的环境里构建和销毁
  if (plan.banners.length > 0) {
    const bannerTexture = createCanvasTexture(256, 512, drawBannerFace);
    textures.push(bannerTexture);
    const bannerMaterial = new THREE.MeshStandardNodeMaterial({ map: bannerTexture, roughness: 0.82, metalness: 0.02 });
    materials.push(bannerMaterial);
    const sitesByChunk = new Map();
    for (const site of plan.banners) {
      if (!sitesByChunk.has(site.chunkKey)) sitesByChunk.set(site.chunkKey, []);
      sitesByChunk.get(site.chunkKey).push(site);
    }
    for (const [key, sites] of sitesByChunk) {
      const layer = buildBannerLayer(group, geometries, bannerMaterial, sites);
      bannerChunks.set(key, layer);
      layers.push(layer);
    }
  }

  const signTextures = new Map();
  const textureFor = (sign) => {
    const key = `${sign.text}|${sign.subText}`;
    if (!signTextures.has(key)) {
      const texture = createCanvasTexture(1024, 256, drawSignFace(sign.text, sign.subText));
      textures.push(texture);
      signTextures.set(key, texture);
    }
    return signTextures.get(key);
  };
  const signs = buildSignLayer(group, geometries, textureFor, plan.signs, groundY);
  if (signs) {
    layers.push(signs);
    materials.push(...signs.materials);
    for (let i = 0; i < signs.materials.length; i += 3) lit.push([signs.materials[i], 0.08, 0.95]);
  }
  const trucks = buildTruckLayer(group, geometries, plan.trucks, groundY);
  if (trucks) { layers.push(trucks); materials.push(...trucks.materials); }
  const flowers = buildFlowerLayer(group, geometries, plan.flowerBeds, groundY);
  if (flowers) { layers.push(flowers); materials.push(...flowers.materials); }
  statistics.flowers.built = flowers?.flowers ?? 0;
  statistics.meshes = layers.reduce((sum, layer) => sum + layer.objects.length, 0);

  let enabled = initialEnabled;
  let elapsed = 0;
  const result = {
    group,
    enabled,
    statistics,
    bannerSites: plan.banners,
    setEnabled(value) {
      enabled = Boolean(value);
      result.enabled = enabled;
      group.visible = enabled;
      return enabled;
    },
    update(dt) {
      if (!enabled) return;
      elapsed += Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.05);
      for (const [key, layer] of bannerChunks) {
        const [mesh] = layer.objects;
        mesh.visible = lampChunkVisible(key);
        if (mesh.visible) layer.update(elapsed);
      }
      // 日夜系数直接读全局 uniform，入口不再逐个模块转抄。
      const nightValue = sceneUniforms.night.value;
      const night = Number.isFinite(nightValue) ? Math.min(Math.max(nightValue, 0), 1) : 0;
      for (const [material, day, nightIntensity] of lit) {
        material.emissiveIntensity = day + night * nightIntensity;
      }
    },
    dispose() {
      // 场景剔除可能把杆件等实例网格拆成空间分块，统一遍历整组释放实例缓冲
      group.traverse((object) => {
        if (object.isInstancedMesh) object.dispose();
      });
      scene.remove(group);
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      for (const geometry of Object.values(geometries)) geometry.dispose();
      layers.length = 0;
      materials.length = 0;
      textures.length = 0;
    }
  };
  result.setEnabled(initialEnabled);
  return result;
}
