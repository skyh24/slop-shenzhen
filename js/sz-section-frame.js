// 断面横位：断面上「距左路缘多少米」换算成世界坐标的唯一入口。
// 左侧法向 (dz,-dx)：面朝 +x 时 +z 是右（南），左（北）为正。
// 斜接/斜切策略也只有一份，标线与路缘偏移共用同一套符号约定。

const EPSILON = 1e-9;
// 斜接长度上限：超过后改用斜切，急弯处宁可切角也不让偏移线伸出路面或自交。
export const MAX_MITER_SCALE = 4;
const PAVEMENT_TOLERANCE = 0.02;

function requireWidth(widthM) {
  if (!Number.isFinite(widthM) || widthM <= 0) throw new Error('A section frame requires a positive width');
  return widthM;
}

function requirePoints(points, minimum = 2) {
  if (!Array.isArray(points) || points.length < minimum) throw new Error('A section frame requires at least two points');
  return points;
}

// 缺省 leftM 取断面中位；这是旧消费者各处 leftM 缺省值的同一条约定。
function leftOf(point, widthM) {
  return Number.isFinite(point?.leftM) ? point.leftM : widthM / 2;
}

function chord(points, index) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const dx = next.x - previous.x;
  const dz = next.z - previous.z;
  const length = Math.hypot(dx, dz);
  if (!(length > EPSILON)) return { dx: 0, dz: 0 };
  return { dx: dx / length, dz: dz / length };
}

// 逐点断面：弦向切线（首尾取相邻段），leftM 变成路缘两点的世界坐标。
export function sectionSpine(points, { widthM } = {}) {
  const width = requireWidth(widthM);
  requirePoints(points);
  let station = 0;
  return points.map((point, index) => {
    if (index) station += Math.hypot(point.x - points[index - 1].x, point.z - points[index - 1].z);
    const { dx, dz } = chord(points, index);
    const leftM = leftOf(point, width);
    return { x: point.x, z: point.z, station, dx, dz, nx: dz, nz: -dx, leftM, rightM: width - leftM };
  });
}

// 沿断面一侧外扩一条折线：side=+1 是左侧法向那一侧，marginM 在人行道外缘外继续外扩。
export function sectionSideLine(points, { widthM, side, marginM = 0 } = {}) {
  const width = requireWidth(widthM);
  if (side !== 1 && side !== -1) throw new Error('A section side must be 1 or -1');
  if (!Number.isFinite(marginM)) throw new Error('A section margin must be a finite distance');
  return sectionSpine(points, { widthM: width }).map(frame => {
    const offset = side === 1 ? frame.leftM + marginM : -(frame.rightM + marginM);
    return { x: frame.x + frame.nx * offset, z: frame.z + frame.nz * offset };
  });
}

// 车行道中心线：把每个断面点挪到「travel 左缘贴铺装左缘」的位置，等价于从左侧缘量 travelWidthM/2。
export function sectionTravelLine(points, { travelWidthM } = {}) {
  const travel = requireWidth(travelWidthM);
  requirePoints(points);
  const half = travel / 2;
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x, dz = next.z - previous.z;
    const length = Math.hypot(dx, dz);
    const offset = (half - leftOf(point, travel)) / length;
    return { x: point.x - dz * offset, z: point.z + dx * offset };
  });
}

// 单个断面点的左右路缘。dx/dz 是段方向，可以不归一化；零长段没有横位可算，返回 null。
export function sectionEdges(point, { widthM, dx, dz } = {}) {
  const width = requireWidth(widthM);
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) throw new Error('A section edge requires a finite point');
  const length = Math.hypot(dx, dz);
  if (!(length > EPSILON)) return null;
  const leftM = leftOf(point, width);
  const rightM = width - leftM;
  const left = leftM / length, right = rightM / length;
  return { leftM, rightM,
    left: { x: point.x + dz * left, z: point.z - dx * left },
    right: { x: point.x - dz * right, z: point.z + dx * right } };
}

// 按里程取一点：段向法线、leftM 线性插值，供沿路等距布点（灯杆、站点）用。
export function sectionAtStation(points, stationM, { widthM } = {}) {
  const width = requireWidth(widthM);
  requirePoints(points);
  if (!Number.isFinite(stationM)) throw new Error('A section station must be a finite distance');
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (travelled + segment >= stationM) {
      if (!(segment > 1e-6)) return null;
      const t = (stationM - travelled) / segment;
      const ux = (b.x - a.x) / segment, uz = (b.z - a.z) / segment;
      const aLeft = leftOf(a, width), bLeft = leftOf(b, width);
      const leftM = aLeft + (bLeft - aLeft) * t;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, station: stationM,
        dx: ux, dz: uz, nx: uz, nz: -ux, leftM, rightM: width - leftM };
    }
    travelled += segment;
  }
  return null;
}

// 左侧法向：sectionSideLine 与标线共用的符号约定。
export function sectionNormal(dx, dz) {
  const length = Math.hypot(dx, dz);
  if (!(length > EPSILON)) return null;
  return { nx: dz / length, nz: -dx / length };
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-9) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length)));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

// 逐段求偏移点：每个顶点用相邻两段的法线平分线做斜接，整段不再共用首尾弦方向。
// offsetM 从铺装中心量起，右为正；leftM 逐点变化时先换算成该断面自己的横位。
// 斜接点会伸出斜切路缘时改用斜切（两段各自法线偏移），保证线在路面内。
export function sectionMiteredLine(points, { widthM, offsetM } = {}) {
  const width = requireWidth(widthM);
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(offsetM)) return [];
  const halfWidth = width / 2;
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].z - points[i].z;
    const length = Math.hypot(dx, dz);
    segments.push(length < 1e-6 ? null : { ux: dx / length, uz: dz / length });
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const previous = segments[i - 1] ?? null;
    const next = segments[i] ?? null;
    if (!previous && !next) continue;
    const leftWidth = leftOf(points[i], width);
    const across = offsetM + (halfWidth - leftWidth);
    if (!previous || !next) {
      const only = previous ?? next;
      out.push({ x: points[i].x - only.uz * across, z: points[i].z + only.ux * across });
      continue;
    }
    let bx = -previous.uz - next.uz;
    let bz = previous.ux + next.ux;
    let length = Math.hypot(bx, bz);
    if (length < 1e-6) {
      // 180° 折返没有唯一平分线，退回本段法线。
      out.push({ x: points[i].x - next.uz * across, z: points[i].z + next.ux * across });
      continue;
    }
    bx /= length; bz /= length;
    const cosine = bx * -next.uz + bz * next.ux;
    const scale = cosine < 1 / MAX_MITER_SCALE ? MAX_MITER_SCALE : 1 / cosine;
    const miter = { x: points[i].x + bx * across * scale, z: points[i].z + bz * across * scale };
    let bevel = false;
    if (Math.abs(across) > 1e-6 && scale > 1.0001) {
      // 凸侧斜接点的垂足落到路段之外：只有斜接长度不超过斜切路缘（到平分线与路缘交点）时才算在路面内。
      const distance = Math.min(distanceToSegment(miter, points[i - 1], points[i]), distanceToSegment(miter, points[i], points[i + 1]));
      const inside = distance <= Math.abs(across) + 1e-6;
      const sideWidth = across < 0 ? leftWidth : 2 * halfWidth - leftWidth;
      const limit = sideWidth * cosine / Math.abs(across);
      bevel = !inside && scale > limit - PAVEMENT_TOLERANCE;
    }
    if (bevel) {
      // 斜接会伸出斜切路缘，改画斜切：两段法线偏移点连一条斜线。
      out.push({ x: points[i].x - previous.uz * across, z: points[i].z + previous.ux * across });
      out.push({ x: points[i].x - next.uz * across, z: points[i].z + next.ux * across });
    } else out.push(miter);
  }
  return out;
}
