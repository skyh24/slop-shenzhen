const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
// 只验证平面几何计划，不创建场景；Three 和材质用空壳，建筑模块的入口函数不在这里调用。
const emptyThree = {};
const layout = loadModule(read('sz-building-layout.js'), { imports: {
  './sz-terrain.js': loadModule(read('sz-terrain.js'))
} });
const buildingsModule = loadModule(read('sz-buildings.js'), { imports: {
  'three/webgpu': emptyThree,
  './sz-geodata.js': { CITY_PAYLOAD: { enums: { facade: ['office'] } } },
  './sz-geometry.js': loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': emptyThree } }),
  './sz-materials.js': { createBuildingMaterial: () => ({}) },
  './sz-building-layout.js': layout, './sz-polygon.js': polygonModule
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));

// 射线交叉法判断点是否在环内，不借助实现里的包含函数。
function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
  }
  return inside;
}

function insideEffectivePolygon(polygon, x, z) {
  if (!pointInRing(polygon.outer, x, z)) return false;
  return !(polygon.holes ?? []).some(hole => pointInRing(hole, x, z));
}

// 设备底面四角：中心加绕 y 轴旋转后的半尺寸偏移。yaw 缺省按 0（轴对齐）处理，顺时针或逆时针都得到同一组角。
function rectCorners(unit) {
  const yaw = unit.yaw ?? 0;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const halfX = unit.sizeX / 2, halfZ = unit.sizeZ / 2;
  return [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]]
    .map(([x, z]) => ({ x: unit.x + x * cos - z * sin, z: unit.z + x * sin + z * cos }));
}

// 从四个角反推矩形中心、半轴和局部坐标轴，检查器不读设备计划的任何其他字段。
function rectFrame(corners) {
  const centre = {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
    z: (corners[0].z + corners[1].z + corners[2].z + corners[3].z) / 4
  };
  const axisX = { x: (corners[1].x - corners[0].x) / 2, z: (corners[1].z - corners[0].z) / 2 };
  const axisZ = { x: (corners[2].x - corners[1].x) / 2, z: (corners[2].z - corners[1].z) / 2 };
  const halfX = Math.hypot(axisX.x, axisX.z), halfZ = Math.hypot(axisZ.x, axisZ.z);
  return {
    centre, halfX, halfZ,
    ex: { x: axisX.x / halfX, z: axisX.z / halfX },
    ez: { x: axisZ.x / halfZ, z: axisZ.z / halfZ }
  };
}

function pointInRect(point, frame) {
  const dx = point.x - frame.centre.x, dz = point.z - frame.centre.z;
  const localX = dx * frame.ex.x + dz * frame.ex.z;
  const localZ = dx * frame.ez.x + dz * frame.ez.z;
  return Math.abs(localX) < frame.halfX && Math.abs(localZ) < frame.halfZ;
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// 端点相接也算相交：0.5 m 净距要求下不允许任何接触。
function segmentsIntersect(a, b, c, d) {
  const orientation = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const epsilon = 1e-9;
  const onSegment = (p, q, r) => Math.abs(orientation(p, q, r)) <= epsilon &&
    q.x >= Math.min(p.x, r.x) - epsilon && q.x <= Math.max(p.x, r.x) + epsilon &&
    q.z >= Math.min(p.z, r.z) - epsilon && q.z <= Math.max(p.z, r.z) + epsilon;
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return onSegment(a, c, b) || onSegment(a, d, b) || onSegment(c, a, d) || onSegment(c, b, d);
}

// 完整底面校验：四角在有效屋顶内、矩形边不与任何边界边相交、边界顶点不在矩形内部、
// 角点到边界边以及边界顶点到矩形边的净距都不小于 margin。返回 null 表示通过，否则返回首个问题。
function insideEffectiveRoof(polygon, corners, margin) {
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  const frame = rectFrame(corners);
  if (!(frame.halfX > 0 && frame.halfZ > 0)) return 'unit rectangle is degenerate';
  const boundary = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      boundary.push([ring[j], ring[i]]);
    }
  }
  for (const corner of corners) {
    if (!pointInRing(polygon.outer, corner.x, corner.z)) {
      return `corner (${corner.x.toFixed(2)}, ${corner.z.toFixed(2)}) is outside the roof outer ring`;
    }
  }
  for (const hole of polygon.holes ?? []) {
    for (const corner of corners) {
      if (pointInRing(hole, corner.x, corner.z)) {
        return `corner (${corner.x.toFixed(2)}, ${corner.z.toFixed(2)}) is inside a courtyard`;
      }
    }
  }
  const edges = corners.map((corner, index) => [corner, corners[(index + 1) % 4]]);
  for (const [a, b] of boundary) {
    if (a.x === b.x && a.z === b.z) continue;
    for (const [p, q] of edges) {
      if (segmentsIntersect(p, q, a, b)) return 'unit edge crosses a roof boundary edge';
    }
  }
  for (const [a, b] of boundary) {
    for (const vertex of [a, b]) {
      if (pointInRect(vertex, frame)) return `roof vertex (${vertex.x.toFixed(2)}, ${vertex.z.toFixed(2)}) lies inside the unit`;
    }
  }
  let clearance = Infinity;
  for (const corner of corners) {
    for (const [a, b] of boundary) {
      clearance = Math.min(clearance, pointSegmentDistance(corner.x, corner.z, a.x, a.z, b.x, b.z));
    }
  }
  for (const [a, b] of boundary) {
    for (const vertex of [a, b]) {
      for (const [p, q] of edges) {
        clearance = Math.min(clearance, pointSegmentDistance(vertex.x, vertex.z, p.x, p.z, q.x, q.z));
      }
    }
  }
  if (clearance < margin) return `clearance ${clearance.toFixed(3)} m is under the required ${margin} m`;
  return null;
}

// 两台设备的底面矩形必须留 0.5 m 间隙：互相包含、边相交、或最近距离不足都算失败。
function rectsApart(a, b, gap) {
  const cornersA = rectCorners(a), cornersB = rectCorners(b);
  const frameA = rectFrame(cornersA), frameB = rectFrame(cornersB);
  if (cornersA.some(corner => pointInRect(corner, frameB))) return 'contain one another';
  if (cornersB.some(corner => pointInRect(corner, frameA))) return 'contain one another';
  const edgesA = cornersA.map((corner, index) => [corner, cornersA[(index + 1) % 4]]);
  const edgesB = cornersB.map((corner, index) => [corner, cornersB[(index + 1) % 4]]);
  let distance = Infinity;
  for (const [p, q] of edgesA) {
    for (const [r, s] of edgesB) {
      if (segmentsIntersect(p, q, r, s)) return 'overlap each other';
      distance = Math.min(distance,
        pointSegmentDistance(p.x, p.z, r.x, r.z, s.x, s.z),
        pointSegmentDistance(q.x, q.z, r.x, r.z, s.x, s.z),
        pointSegmentDistance(r.x, r.z, p.x, p.z, q.x, q.z),
        pointSegmentDistance(s.x, s.z, p.x, p.z, q.x, q.z));
    }
  }
  if (distance < gap) return `are only ${distance.toFixed(3)} m apart`;
  return null;
}

// 在设备底面细网格采样，返回落在有效屋顶之外的面积占比（0 表示整块底面都在屋顶上）。
function outsideArea(polygon, unit, samples = 80) {
  const frame = rectFrame(rectCorners(unit));
  let outside = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const localX = (-1 + (2 * (i + 0.5)) / samples) * frame.halfX;
      const localZ = (-1 + (2 * (j + 0.5)) / samples) * frame.halfZ;
      const x = frame.centre.x + frame.ex.x * localX + frame.ez.x * localZ;
      const z = frame.centre.z + frame.ex.z * localX + frame.ez.z * localZ;
      if (!insideEffectivePolygon(polygon, x, z)) outside++;
    }
  }
  return outside / (samples * samples);
}

const describeUnit = unit => `centre (${unit.x.toFixed(2)}, ${unit.z.toFixed(2)}) ` +
  `size ${unit.sizeX.toFixed(2)}x${unit.sizeZ.toFixed(2)} yaw ${(unit.yaw ?? 0).toFixed(2)}`;

// 计划入口：先明确要求导出，避免把“函数不存在”混成几何失败原因。
function planRoof(building) {
  assert.equal(typeof buildingsModule.roofPlan, 'function',
    `js/sz-buildings.js must export roofPlan(building, polygon) to place ${building.id} roof equipment`);
  return buildingsModule.roofPlan(building, building.polygons[0]);
}

function assertUnitsInside(polygon, units, margin, label) {
  units.forEach((unit, index) => {
    const problem = insideEffectiveRoof(polygon, rectCorners(unit), margin);
    assert.equal(problem, null, `${label} equipment[${index}] ${describeUnit(unit)}: ${problem}`);
  });
  for (let first = 0; first < units.length; first++) {
    for (let second = first + 1; second < units.length; second++) {
      const problem = rectsApart(units[first], units[second], 0.5);
      assert.equal(problem, null, `${label} equipment[${first}] and equipment[${second}] ${problem}`);
    }
  }
}

function makeBuilding(id, height, polygon) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of polygon.outer) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { id, height, minHeight: 0, polygons: [polygon], minX, maxX, minZ, maxZ,
    cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

const rectRing = (minX, minZ, maxX, maxZ) => [
  { x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }
];

const byId = new Map(buildings.map(building => [building.id, building]));
const realBuilding = id => {
  const building = byId.get(id);
  assert.ok(building, `shared city payload contains ${id}`);
  return building;
};

// 修复前（docs/REVIEW-FOLLOWUP-2026-11-10.md 1.2）的实测设备位置，只用来确认检查器不是空转。
const LEGACY_WITNESS = {
  'way/135961006': { x: 1082.79, z: 2963.39, sizeX: 9, sizeZ: 8.97, yaw: 0 },
  'relation/17457833': { x: -13032.48, z: 1634.16, sizeX: 4.17, sizeZ: 3.75, yaw: 0 }
};

test('roof equipment on real way/135961006 stays inside its irregular tower footprint', () => {
  const building = realBuilding('way/135961006');
  const polygon = building.polygons[0];
  // 23 号第 1 步删除 GloBFP 半覆盖继承后，这栋楼不再借 61.4 m，改走 estimate（36.3 m）。
  // 用例仍验证同一块真实不规则屋面的设备摆放，不再断言它是高层。
  assert.ok(building.height >= 30, 'the sample keeps a real mid-rise roof above the equipment height');
  assert.equal(building.heightSource, 'estimate', 'the removed overlap fallback leaves no inherited height');
  // 检查器自检：修复前的设备块必须被判为越界，否则下面的空结果会失去意义。
  const witness = LEGACY_WITNESS[building.id];
  assert.notEqual(insideEffectiveRoof(polygon, rectCorners(witness), 0.5), null,
    'checker rejects the pre-fix placement that hung off the tower footprint');
  assert.ok(outsideArea(polygon, witness) > 0, 'checker measures the pre-fix bottom face outside the roof');

  const units = planRoof(building).equipment;
  // 这栋楼按 estimate 只剩 36.3 m，低于放设备的层高门槛，允许空计划；
  // 真高楼放设备仍由 relation/17457833 与 150 m 合成屋面两个用例覆盖。
  assert.ok(units.length <= 3, 'equipment count stays within the budget');
  assertUnitsInside(polygon, units, 0.5, building.id);
  units.forEach((unit, index) => {
    assert.equal(outsideArea(polygon, unit), 0, `${building.id} equipment[${index}] bottom face leaves the roof`);
  });
});

test('roof equipment on real relation/17457833 avoids the courtyard hole', () => {
  const building = realBuilding('relation/17457833');
  const polygon = building.polygons[0];
  assert.ok(building.height >= 60 && polygon.holes.length >= 1, 'the sample keeps its courtyard');
  const witness = LEGACY_WITNESS[building.id];
  assert.notEqual(insideEffectiveRoof(polygon, rectCorners(witness), 0.5), null,
    'checker rejects the pre-fix unit that sat entirely in the courtyard');
  assert.ok(outsideArea(polygon, witness) > 0, 'checker measures the pre-fix bottom face inside the courtyard');

  const units = planRoof(building).equipment;
  assert.ok(units.length >= 1, 'a real roof with a clear bay still receives equipment');
  assert.ok(units.length <= 3, 'equipment count stays within the budget');
  assertUnitsInside(polygon, units, 0.5, building.id);
  units.forEach((unit, index) => {
    for (const hole of polygon.holes) {
      const corners = rectCorners(unit);
      assert.equal(corners.some(corner => pointInRing(hole, corner.x, corner.z)), false,
        `${building.id} equipment[${index}] corner enters the courtyard`);
    }
    assert.equal(outsideArea(polygon, unit), 0, `${building.id} equipment[${index}] bottom face enters the courtyard`);
  });
});

test('roof equipment fits a concave L-shaped roof instead of falling into the notch', () => {
  // 两臂各 12 m 宽的 L 形是敌意形状，允许不放设备，但绝不能放到底面出界。
  const hostile = { outer: [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 60, z: 12 }, { x: 12, z: 12 },
    { x: 12, z: 60 }, { x: 0, z: 60 }], holes: [] };
  const hostileBuilding = makeBuilding('way/900060', 150, hostile);
  assert.equal(pointInRing(hostile.outer, 60, 60), false, 'the bounding-box centre of the hostile L lies in the notch');
  const hostileUnits = planRoof(hostileBuilding).equipment;
  assertUnitsInside(hostile, hostileUnits, 0.5, hostileBuilding.id);

  // 宽大的 L（120x120 去掉 60x60 角）必须至少产出一个合法设备，证明修复没有一刀切删光。
  const generous = { outer: [{ x: 0, z: 0 }, { x: 120, z: 0 }, { x: 120, z: 60 }, { x: 60, z: 60 },
    { x: 60, z: 120 }, { x: 0, z: 120 }], holes: [] };
  const generousBuilding = makeBuilding('way/900120', 150, generous);
  assert.notEqual(insideEffectiveRoof(generous, rectCorners({ x: 60, z: 60, sizeX: 9, sizeZ: 9, yaw: 0 }), 0.5), null,
    'checker rejects the bounding-box centre of the generous L');
  assert.equal(insideEffectiveRoof(generous, rectCorners({ x: 30, z: 30, sizeX: 3, sizeZ: 3, yaw: 0 }), 0.5), null,
    'checker accepts a conservative unit that is clearly inside the generous L');
  const generousUnits = planRoof(generousBuilding).equipment;
  assert.ok(generousUnits.length >= 1, 'the generous L keeps at least one equipment unit');
  assertUnitsInside(generous, generousUnits, 0.5, generousBuilding.id);
});

test('roof equipment fits a 30-degree rotated roof instead of its bounding box', () => {
  const centreX = 400, centreZ = 700, radians = Math.PI / 6;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const local = [[-30, -8], [30, -8], [30, 8], [-30, 8]];
  const oblique = { outer: local.map(([x, z]) => ({
    x: centreX + x * cos - z * sin, z: centreZ + x * sin + z * cos
  })), holes: [] };
  const building = makeBuilding('way/900030', 150, oblique);
  const maxX = Math.max(...oblique.outer.map(point => point.x));
  // 轴对齐包围盒右边缘附近的 9x9 设备会跨出斜屋顶，检查器必须能识别。
  const witness = { x: maxX - 4.6, z: centreZ, sizeX: 9, sizeZ: 9, yaw: 0 };
  assert.notEqual(insideEffectiveRoof(oblique, rectCorners(witness), 0.5), null,
    'checker rejects the bounding-box edge placement on a rotated roof');

  const units = planRoof(building).equipment;
  assertUnitsInside(oblique, units, 0.5, building.id);
  units.forEach((unit, index) => {
    assert.equal(outsideArea(oblique, unit), 0, `${building.id} equipment[${index}] bottom face leaves the rotated roof`);
  });
});

test('roof equipment keeps clear of an inner courtyard and the outer edge', () => {
  const polygon = { outer: rectRing(0, 0, 60, 60), holes: [rectRing(20, 20, 40, 40)] };
  const building = makeBuilding('way/900900', 150, polygon);
  assert.notEqual(insideEffectiveRoof(polygon, rectCorners({ x: 30, z: 30, sizeX: 9, sizeZ: 9, yaw: 0 }), 0.5), null,
    'checker rejects a unit centred in the courtyard');
  assert.equal(insideEffectiveRoof(polygon, rectCorners({ x: 10, z: 10, sizeX: 3, sizeZ: 3, yaw: 0 }), 0.5), null,
    'checker accepts a conservative unit in the roof band');

  const units = planRoof(building).equipment;
  assertUnitsInside(polygon, units, 0.5, building.id);
  units.forEach((unit, index) => {
    const corners = rectCorners(unit);
    for (const hole of polygon.holes) {
      assert.equal(corners.some(corner => pointInRing(hole, corner.x, corner.z)), false,
        `${building.id} equipment[${index}] corner enters the courtyard`);
    }
    assert.equal(outsideArea(polygon, unit), 0, `${building.id} equipment[${index}] bottom face enters the courtyard`);
  });
});

test('roof plans are deterministic for the same building id and polygon', () => {
  const building = realBuilding('relation/17457833');
  const polygon = building.polygons[0];
  const first = planRoof(building);
  const second = planRoof(building);
  assert.deepEqual(second, first, 'repeated calls return the same plan');
  // 同一 id 的另一个对象（顶点数组也是新建的）必须得到同一计划，计划不能依赖调用顺序。
  const clone = { ...building, polygons: [{
    outer: polygon.outer.map(point => ({ x: point.x, z: point.z })),
    holes: polygon.holes.map(ring => ring.map(point => ({ x: point.x, z: point.z })))
  }] };
  planRoof(makeBuilding('way/900777', 150, { outer: rectRing(0, 0, 80, 80), holes: [] }));
  assert.deepEqual(planRoof(clone), first, 'the same id and polygon deep-equal the earlier plan');
  assert.deepEqual(planRoof(building), first, 'earlier planning of other buildings does not change the result');
});

test('roof plan keeps parapet and equipment budget rules for short, medium and tiny roofs', () => {
  const square = { outer: rectRing(0, 0, 60, 60), holes: [] };
  const medium = planRoof(makeBuilding('way/900040', 40, square));
  assert.equal(medium.parapet, 0.9, 'a 40 m building keeps a 0.9 m parapet');
  // 模块在 vm 里求值，返回的数组原型和本文件不同，空结果用长度断言。
  assert.equal(medium.equipment.length, 0, 'a 40 m building gets no roof equipment');

  const low = planRoof(makeBuilding('way/900019', 19, square));
  assert.equal(low.parapet, 0, 'a 19 m building has no parapet');
  assert.equal(low.equipment.length, 0, 'a 19 m building gets no roof equipment');

  // 61 m、约 15 m2 的带凹口小屋顶：可以不出设备，但不得抛错，出了就必须合法。
  const tinyPolygon = { outer: [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 1.5 },
    { x: 2, z: 1.5 }, { x: 2, z: 4.5 }, { x: 0, z: 4.5 }], holes: [] };
  const tinyBuilding = makeBuilding('way/900061', 61, tinyPolygon);
  let tinyPlan;
  assert.doesNotThrow(() => { tinyPlan = planRoof(tinyBuilding); }, 'a tiny irregular roof must not throw');
  assert.ok(tinyPlan.equipment.length <= 3, 'tiny roof stays within the equipment count budget');
  assertUnitsInside(tinyPolygon, tinyPlan.equipment, 0.5, tinyBuilding.id);

  const tall = planRoof(makeBuilding('way/900150', 150, square));
  assert.equal(tall.parapet, 0.9, 'a 150 m building keeps the parapet rule');
  assert.ok(tall.equipment.length >= 1 && tall.equipment.length <= 3, 'a 60x60 roof receives 1-3 units');
  for (const unit of tall.equipment) {
    assert.ok(unit.height >= 2 && unit.height <= 5, `unit height ${unit.height} stays in 2..5 m`);
    assert.ok(unit.sizeX > 0 && unit.sizeZ > 0, 'unit footprint sizes stay positive');
    assert.ok(Number.isFinite(unit.yaw), 'every unit carries a finite yaw');
  }
});

test('every sampled real tall building keeps its roof equipment inside the footprint', () => {
  // 按外环顶点数排序后均匀取样，覆盖少量到上百个顶点的真实屋顶，不依赖具体下标。
  const tall = buildings.filter(building => building.height >= 60 && building.minHeight === 0);
  const sorted = [...tall].sort((a, b) => a.polygons[0].outer.length - b.polygons[0].outer.length ||
    (a.id < b.id ? -1 : 1));
  const picks = Array.from({ length: 40 }, (_, index) => sorted[Math.round((index * (sorted.length - 1)) / 39)]);
  assert.equal(new Set(picks.map(building => building.id)).size, picks.length, 'batch picks are distinct');
  assert.ok(new Set(picks.map(building => building.polygons[0].outer.length)).size >= 8,
    'batch spans varied real ring vertex counts');
  let produced = 0;
  for (const building of picks) {
    const units = planRoof(building).equipment;
    assertUnitsInside(building.polygons[0], units, 0.5, building.id);
    produced += units.length;
  }
  assert.ok(produced >= 1, 'the sampled real tall towers still receive equipment');
});
