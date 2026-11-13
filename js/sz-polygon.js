// 纯几何工具：不依赖 three.js，浏览器运行时和 node 单元测试共用。
// 环是 { x, z } 点数组，首尾自动相连；多边形是 { outer, holes }。坐标单位为米，x 向东、z 向南。
//
// 点在多边形内有两种语义，调用点必须按原实现选择，不能互换：
// - ringContains / polygonContains：奇偶规则（射线法），点正好落在边上时结果不确定；
//   与 building-collision.js、sz-trees.js、sz-buildings.js、sz-pedestrians.js 的原实现一致。
// - ringContainsInclusive / polygonContainsInclusive：外环上落在边上的点算作在内；
//   与 sz-spatial.js 的原实现一致，用于空间索引的覆盖区和陆地区间判定。

// 环的有向面积（鞋带公式），不扣内院；凹多边形同样适用。
export function signedRingArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

export function ringArea(ring) {
  return Math.abs(signedRingArea(ring));
}

// 围绕中心构造旋转矩形；局部长轴在 xz 平面上的单位方向为 (cos, sin)。
export function orientedBoxRing(x, z, width, depth, cos, sin) {
  const hx = width / 2, hz = depth / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([u, v]) => ({
    x: x + u * cos - v * sin, z: z + u * sin + v * cos
  }));
}

export function ringPerimeter(ring) {
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return length;
}

// 环的几何中心（面积加权）。面积为 0 的退化环退回顶点平均，避免除零。
export function ringCentroid(ring) {
  let x = 0, z = 0, weight = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const cross = a.x * b.z - b.x * a.z;
    weight += cross;
    x += (a.x + b.x) * cross;
    z += (a.z + b.z) * cross;
  }
  if (Math.abs(weight) < 1e-9) {
    return { x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
      z: ring.reduce((sum, point) => sum + point.z, 0) / ring.length };
  }
  return { x: x / (3 * weight), z: z / (3 * weight) };
}

// 沿外环按周长比例 t∈[0,1) 取点，同时给出该处单位切线（x 向东、z 向南）。
export function sampleRing(ring, t) {
  const perimeter = ringPerimeter(ring);
  let target = (((t % 1) + 1) % 1) * perimeter;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (target <= length || i === ring.length - 1) {
      const u = length > 1e-9 ? Math.min(1, target / length) : 0;
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u,
        dx: length > 1e-9 ? (b.x - a.x) / length : 0, dz: length > 1e-9 ? (b.z - a.z) / length : 0 };
    }
    target -= length;
  }
  const a = ring[0], b = ring[1];
  return { x: a.x, z: a.z, dx: b.x - a.x, dz: b.z - a.z };
}

// 点到环边的最小平面距离（米）；点在环内时同样返回最近边的距离。
export function distanceToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

// 面积最大的外环；面积相同保留先出现的那个，保证结果确定。
export function largestRing(rings) {
  let best = rings[0];
  for (const ring of rings) if (ringArea(ring) > ringArea(best)) best = ring;
  return best;
}

// 共享包 sites 段解码后的外环列表：{ polygons: [{ outer: [{x,z}], holes }] }。
// 只保留顶点数 ≥3 且坐标有限的外环，顺序不变。
export function outerRings(site) {
  const rings = [];
  for (const polygon of site?.polygons ?? []) {
    const outer = polygon?.outer;
    if (Array.isArray(outer) && outer.length >= 3 && outer.every(finitePoint)) rings.push(outer);
  }
  return rings;
}

export function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.z);
}

// 地标中心点：找不到或坐标无效时返回 null，不猜最近点。
export function landmarkCenter(landmarks, id) {
  const landmark = (landmarks ?? []).find((item) => item?.id === id);
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.z)) return null;
  return { x: landmark.x, z: landmark.z };
}

// 射线法奇偶规则：点是否在单个环内。点正好落在边上时结果由边的方向决定，不是稳定语义。
export function ringContains(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
  }
  return inside;
}

// 奇偶规则下的多边形包含：外环和内院一起参与奇偶计数，内院内的点被翻转为外部。
// 数据正常（内院都在外环内且互不重叠）时等价于“在外环内且不在内院内”。
export function polygonContains(polygon, x, z) {
  let inside = false;
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
    }
  }
  return inside;
}

// 落在边上的点算在内：空间索引判断覆盖区、陆地和水面时用，边界点不能因为浮点落在缝里。
export function ringContainsInclusive(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (x - a.x) * (b.z - a.z) - (z - a.z) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)
      && z >= Math.min(a.z, b.z) && z <= Math.max(a.z, b.z)) return true;
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// 外环边界算在内，内院边界算在外（和 sz-spatial.js 原实现一致）。
export function polygonContainsInclusive(polygon, x, z) {
  return ringContainsInclusive(polygon.outer, x, z)
    && !(polygon.holes ?? []).some((ring) => ringContainsInclusive(ring, x, z));
}
