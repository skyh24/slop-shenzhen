// 沿城市坐标轴截取已绑定的商铺足迹，保留切线两端与原立面的交点。
export function cutRing(ring, axis, limit, keepGreater) {
  const result = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const inside = p => keepGreater ? p[axis] >= limit : p[axis] <= limit;
    if (inside(a)) result.push(a);
    if (inside(a) === inside(b)) continue;
    const t = (limit - a[axis]) / (b[axis] - a[axis]);
    result.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return result;
}
