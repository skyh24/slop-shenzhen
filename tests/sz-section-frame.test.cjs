const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const frame = loadModule(read('sz-section-frame.js'));
// vm 里造的对象与本域原型不同，跨域比较前先落成普通 JSON 值。
const plain = value => JSON.parse(JSON.stringify(value));

// 旧消费者的就地实现，保留当回归基准：新模块的输出必须逐点相等。
function legacyOffsetPoints(points, offset, halfWidth) {
  const count = points.length;
  if (count < 2 || !Number.isFinite(offset)) return [];
  const segments = [];
  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].z - points[i].z;
    const length = Math.hypot(dx, dz);
    segments.push(length < 1e-6 ? null : { ux: dx / length, uz: dz / length });
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const previous = segments[i - 1] ?? null;
    const next = segments[i] ?? null;
    if (!previous && !next) continue;
    const leftWidth = points[i].leftM ?? halfWidth;
    const across = offset + (halfWidth - leftWidth);
    if (!previous || !next) {
      const only = previous ?? next;
      out.push({ x: points[i].x - only.uz * across, z: points[i].z + only.ux * across });
      continue;
    }
    let bx = -previous.uz - next.uz;
    let bz = previous.ux + next.ux;
    let length = Math.hypot(bx, bz);
    if (length < 1e-6) {
      out.push({ x: points[i].x - next.uz * across, z: points[i].z + next.ux * across });
      continue;
    }
    bx /= length; bz /= length;
    const cosine = bx * -next.uz + bz * next.ux;
    const scale = cosine < 1 / 4 ? 4 : 1 / cosine;
    const miter = { x: points[i].x + bx * across * scale, z: points[i].z + bz * across * scale };
    let bevel = false;
    if (Math.abs(across) > 1e-6 && scale > 1.0001) {
      const distanceToSegment = (point, a, b) => {
        const dx = b.x - a.x, dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-9) return Math.hypot(point.x - a.x, point.z - a.z);
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length)));
        return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
      };
      const distance = Math.min(distanceToSegment(miter, points[i - 1], points[i]), distanceToSegment(miter, points[i], points[i + 1]));
      const inside = distance <= Math.abs(across) + 1e-6;
      const sideWidth = across < 0 ? leftWidth : 2 * halfWidth - leftWidth;
      const limit = sideWidth * cosine / Math.abs(across);
      bevel = !inside && scale > limit - 0.02;
    }
    if (bevel) {
      out.push({ x: points[i].x - previous.uz * across, z: points[i].z + previous.ux * across });
      out.push({ x: points[i].x - next.uz * across, z: points[i].z + next.ux * across });
    } else out.push(miter);
  }
  return out;
}

function legacySideLine(points, side, widthM, marginM) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next.x - previous.x;
    let dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const { x, z, leftM = widthM / 2 } = points[i];
    const offset = side * ((side === 1 ? leftM : widthM - leftM) + marginM);
    result.push({ x: x + dz * offset, z: z - dx * offset });
  }
  return result;
}

function legacyTravelLine(points, travelWidthM) {
  const halfTravel = travelWidthM / 2;
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const offset = (halfTravel - p.leftM) / length;
    return { x: p.x - (b.z - a.z) * offset, z: p.z + (b.x - a.x) * offset };
  });
}

function legacySection(a, b, width) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  const section = p => {
    const left = (p.leftM ?? width / 2) / length;
    const right = width / length - left;
    return [{ x: p.x + dz * left, z: p.z - dx * left }, { x: p.x - dz * right, z: p.z + dx * right }];
  };
  return { start: section(a), end: section(b) };
}

// 固定种子的折线，弯道、回折和不对称 leftM 都要覆盖。
function randomPolyline(seed, count, widthM) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const points = [];
  let x = 0, z = 0;
  for (let i = 0; i < count; i++) {
    points.push({ x, z, leftM: widthM * (0.2 + next() * 0.6) });
    x += 20 + next() * 40;
    z += (next() - 0.5) * 30;
  }
  return points;
}

test('a spine names stations, tangents and both kerbs from the left kerb', () => {
  const points = [{ x: 0, z: 0, leftM: 3 }, { x: 100, z: 0, leftM: 4 }, { x: 100, z: 100 }];
  const spine = frame.sectionSpine(points, { widthM: 12 });
  assert.equal(spine.length, 3);
  assert.deepEqual(plain(spine.map(point => point.station)), [0, 100, 200]);
  // 弦向切线：中间点取前后邻点的连线，转角处斜切。
  assert.ok(Math.abs(spine[1].dx - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(spine[1].dz - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(spine[1].nx - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(spine[1].nz + Math.SQRT1_2) < 1e-12);
  assert.deepEqual(plain([spine[0].leftM, spine[0].rightM]), [3, 9]);
  assert.deepEqual(plain([spine[2].leftM, spine[2].rightM]), [6, 6]);
});

test('side lines reproduce the old sidewalk offset on both sides', () => {
  const points = randomPolyline(7, 9, 14);
  for (const side of [1, -1]) {
    for (const marginM of [0, 1.6, 4.25]) {
      assert.deepEqual(plain(frame.sectionSideLine(points, { widthM: 14, side, marginM })),
        plain(legacySideLine(points, side, 14, marginM)));
    }
  }
});

test('travel lines reproduce the old carriageway centering', () => {
  const points = randomPolyline(11, 7, 16);
  assert.deepEqual(plain(frame.sectionTravelLine(points, { travelWidthM: 9.5 })),
    plain(legacyTravelLine(points, 9.5)));
});

test('section edges place both kerbs and reject a zero-length direction', () => {
  const a = { x: 10, z: 20, leftM: 2.5 }, b = { x: 10, z: 75, leftM: 5 };
  const edges = frame.sectionEdges(a, { widthM: 13, dx: 0, dz: 55 });
  const legacy = legacySection(a, b, 13).start;
  assert.deepEqual(plain([edges.left, edges.right]), plain(legacy));
  assert.deepEqual(plain([edges.leftM, edges.rightM]), [2.5, 10.5]);
  assert.equal(frame.sectionEdges(a, { widthM: 13, dx: 0, dz: 0 }), null);
});

test('station sampling interpolates leftM along the segment and stops at the end', () => {
  const points = [{ x: 0, z: 0, leftM: 2 }, { x: 100, z: 0, leftM: 8 }, { x: 100, z: 54, leftM: 4 }];
  const mid = frame.sectionAtStation(points, 50, { widthM: 12 });
  assert.deepEqual(plain([mid.x, mid.z, mid.leftM, mid.rightM]), [50, 0, 5, 7]);
  assert.deepEqual(plain([mid.dx, mid.dz, mid.nx, mid.nz]), [1, 0, 0, -1]);
  const turned = frame.sectionAtStation(points, 127, { widthM: 12 });
  assert.deepEqual(plain([turned.x, turned.z, turned.leftM]), [100, 27, 6]);
  assert.deepEqual(plain([turned.nx, turned.nz]), [1, 0]);
  assert.equal(frame.sectionAtStation(points, 200, { widthM: 12 }), null);
});

test('mitered lines reproduce the old offset geometry, including bevels', () => {
  const cases = [
    [{ x: 0, z: 0 }, { x: 120, z: 0 }],
    [{ x: 0, z: 0 }, { x: 120, z: 0 }, { x: 120, z: 120 }],
    [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 61, z: 40 }, { x: 120, z: 41 }],
    [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 0, z: 0.4 }]
  ];
  let bevels = 0;
  for (const widthM of [6, 12, 20]) {
    for (const offsetM of [-widthM / 2 + 0.38, 0, widthM / 2 - 0.38, widthM * 0.3]) {
      for (const points of cases) {
        const produced = frame.sectionMiteredLine(points, { widthM, offsetM });
        assert.deepEqual(plain(produced), plain(legacyOffsetPoints(points, offsetM, widthM / 2)));
        if (produced.length > points.length) bevels++;
      }
    }
  }
  for (let seed = 1; seed <= 16; seed++) {
    const points = randomPolyline(seed, 8, 15);
    const offsetM = seed % 2 ? 3.1 : -4.4;
    assert.deepEqual(plain(frame.sectionMiteredLine(points, { widthM: 15, offsetM })),
      plain(legacyOffsetPoints(points, offsetM, 7.5)));
  }
  assert.ok(bevels > 0, 'sharp bends must exercise the bevel branch');
});

test('the module rejects widths and stations that cannot define a section', () => {
  assert.throws(() => frame.sectionSpine([{ x: 0, z: 0 }], { widthM: 12 }), /at least two points/);
  assert.throws(() => frame.sectionSpine([{ x: 0, z: 0 }, { x: 1, z: 0 }], { widthM: 0 }), /positive width/);
  assert.throws(() => frame.sectionSideLine([{ x: 0, z: 0 }, { x: 1, z: 0 }], { widthM: 4, side: 2 }), /side must be 1 or -1/);
  assert.throws(() => frame.sectionAtStation([{ x: 0, z: 0 }, { x: 1, z: 0 }], Number.NaN, { widthM: 4 }), /finite distance/);
  assert.equal(frame.sectionNormal(0, 0), null);
  const normal = frame.sectionNormal(0, 2);
  assert.deepEqual(plain([normal.nx, normal.nz]), [1, 0]);
});
