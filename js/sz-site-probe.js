// 落点试探：中心加四周探针取最低地面，再按固定顺序判定冲突。
// 树木、路灯、地铁口和街景附件共用一套探针几何与拒绝顺序，避免同一个坑在不同
// 街景里报出不同原因，也让 QA 能横向比较各街景的跳过口径。
import { polygonBoxOverlaps } from './building-collision.js';

// 单位偏移表：十字五点为默认，四角四点为地铁口这类占地矩形。
export const CROSS_PROBES = Object.freeze([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]);
export const SQUARE_PROBES = Object.freeze([[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]);

// 各街景仍用各自的 skipped 键记账，类别只用于跨街景统计。
export const SITE_CATEGORIES = Object.freeze({
  noGround: 'no-ground', road: 'road', path: 'path', water: 'water', building: 'building',
  duplicate: 'duplicate', reserved: 'reserved', layout: 'layout', median: 'median', deck: 'deck',
  frontage: 'frontage', overlap: 'overlap'
});

export function rotatePoint(x, z, yaw, lx, lz) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return { x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos };
}

function requireProbes(probes) {
  if (!Array.isArray(probes) || !probes.length) throw new Error('A site probe table requires at least one offset');
  for (const offset of probes) {
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite)) {
      throw new Error('A site probe offset must be a finite [x, z] pair');
    }
  }
}

/** 把局部单位偏移按半径缩放、按朝向旋转，得到世界坐标探针。 */
export function probePoints({ x, z, yaw = 0, radius = 0, radiusZ = radius, probes = CROSS_PROBES } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('A site probe requires a finite site position');
  if (!Number.isFinite(radius) || !Number.isFinite(radiusZ) || radius < 0 || radiusZ < 0) {
    throw new Error('A site probe requires non-negative probe radii');
  }
  requireProbes(probes);
  return probes.map(([lx, lz]) => rotatePoint(x, z, yaw, lx * radius, lz * radiusZ));
}

/** 取探针地面最低点，再按规则顺序给出第一个拒绝原因。
 *  rules 项：{ reason, category = reason, at = 'probe' | 'site', test }。
 *  'probe' 逐探针调用 test(probe, site)，'site' 只调用一次 test(site)。
 *  resolveY 可在取最低点后改写落位高度（例如改用铺装面），返回非有限值按无地面处理。 */
export function probeSite({ x, z, yaw = 0, radius = 0, radiusZ = radius, probes = CROSS_PROBES,
  groundProbes = probes, ground, resolveY = null, rules = [], noGroundReason = 'no-ground' } = {}) {
  if (typeof ground !== 'function') throw new Error('A site probe requires a ground height sampler');
  if (!Array.isArray(rules)) throw new Error('Site probe rules must be an array');
  const points = probePoints({ x, z, yaw, radius, radiusZ, probes });
  const groundPoints = groundProbes === probes ? points
    : probePoints({ x, z, yaw, radius, radiusZ, probes: groundProbes });
  const probeList = points.map(point => ({ x: point.x, z: point.z }));
  let y = Infinity;
  for (const point of groundPoints) {
    const height = ground(point.x, point.z);
    if (!Number.isFinite(height)) {
      return { y: NaN, reason: noGroundReason, category: SITE_CATEGORIES.noGround, probes: probeList };
    }
    if (height < y) y = height;
  }
  if (resolveY) {
    const resolved = resolveY(x, z, y);
    if (!Number.isFinite(resolved)) {
      return { y: NaN, reason: noGroundReason, category: SITE_CATEGORIES.noGround, probes: probeList };
    }
    y = resolved;
  }
  const site = { x, z, y, probes: probeList };
  for (const rule of rules) {
    if (!rule || typeof rule.test !== 'function') throw new Error('A site probe rule requires a test');
    const at = rule.at ?? 'probe';
    if (at !== 'probe' && at !== 'site') throw new Error(`Unknown site probe scope: ${at}`);
    const hit = at === 'site' ? rule.test(site) : probeList.some(point => rule.test(point, site));
    if (!hit) continue;
    const reason = rule.reason ?? 'conflict';
    return { y, reason, category: rule.category ?? reason, probes: probeList };
  }
  return { y, reason: null, category: null, probes: probeList };
}

/** 建筑与障碍的最近点判定：三轴 AABB 预筛，有轮廓时再精判。
 *  halfX/halfZ 是占地半宽，height 是净高；y 是落位地面高度。 */
export function nearbyObstacle(colliders, { x, y, z, halfX, halfZ, height }) {
  if (!Array.isArray(colliders)) return false;
  for (const collider of colliders) {
    if (!Number.isFinite(collider?.minX) || !Number.isFinite(collider?.maxX)
      || !Number.isFinite(collider?.minZ) || !Number.isFinite(collider?.maxZ)) continue;
    if (!(collider.minY < y + height && collider.maxY > y)) continue;
    if (!(collider.minX < x + halfX && collider.maxX > x - halfX
      && collider.minZ < z + halfZ && collider.maxZ > z - halfZ)) continue;
    if (!collider.polygon || polygonBoxOverlaps(collider.polygon, x, z, halfX, halfZ)) return true;
  }
  return false;
}

/** 落点计数：一个落点要么放行要么按原因拒绝；reasons 预置零，供 QA 稳定读字段。 */
export function createPlacementTally(reasons = []) {
  const skipped = {};
  const categories = {};
  for (const reason of reasons) skipped[reason] = 0;
  let placed = 0;
  return {
    place() { placed += 1; return placed; },
    skip(reason, category = reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      categories[category] = (categories[category] ?? 0) + 1;
      return skipped[reason];
    },
    count(reason) { return skipped[reason] ?? 0; },
    get placed() { return placed; },
    get skipped() { return skipped; },
    get categories() { return categories; },
    summary() {
      return { placed, skipped: { ...skipped }, categories: { ...categories } };
    }
  };
}
