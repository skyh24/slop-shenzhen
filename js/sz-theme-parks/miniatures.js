import { ringCentroid } from '../sz-polygon.js';
import { disk, parkParts, rectangle, scaledParkParts } from './parts.js';

export const EIFFEL = 'way/264187661';
export const COLOSSEUM = 'way/1150884237';
export const PYRAMIDS = [
  ['way/1150884224', -8970, 1170, 90, 54],
  ['way/1150884225', -9055, 1112, 48, 29],
  ['way/1150884226', -9108, 1092, 28, 17]
];

export function eiffelTower(building, ground) {
  const id = 'theme-eiffel';
  const p = parkParts(id, ground, [], 'reference');
  const { x, z } = ringCentroid(building.polygons[0].outer);
  const height = 108;
  const a = Math.atan2(0.37, 0.93);
  const rings = [19.2, 15.5, 11.8, 7.4, 4.4, 2.6, 1.85, 1.7];
  const levels = [0, 13, 25, 42, 61, 79, 91, 97];
  const corners = rings.map(r => rectangle(x, z, r * 2, r * 2, a));
  const footings = corners[0].map(c => rectangle(c.x, c.z, 8, 8, a));
  const base = Math.max(...footings.map(ring => p.limits(ring)[1])) + 0.42;
  for (let k = 0; k < 4; k++) {
    p.solid(footings[k], p.limits(footings[k])[0] - 0.25, base, 'basalt');
    for (let i = 1; i < levels.length; i++) {
      const width = i === 1 ? 6.5 : i === 2 ? 4.6 : 2.7 - (i - 3) * 0.32;
      const low = corners[i - 1][k], high = corners[i][k];
      p.span({ ...low, y: base + levels[i - 1] + width }, { ...high, y: base + levels[i] + width * 0.6 },
        width, width, 'iron', width * 0.8);
    }
  }
  for (const [i, pad, thick] of [[2, 2.4, 3.5], [3, 1.8, 2.6], [6, 1.9, 2.8]]) {
    p.box(x, z, (rings[i] + pad) * 2, (rings[i] + pad) * 2, base + levels[i], base + levels[i] + thick, 'iron', a);
    p.box(x, z, (rings[i] + pad) * 2.04, (rings[i] + pad) * 2.04,
      base + levels[i] + thick, base + levels[i] + thick + 0.65, 'brass', a);
  }
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    // 底层拱和上半部只保留能读出剪影的杆件。
    const left = corners[1][k], right = corners[1][j];
    const arch = [0, 0.23, 0.5, 0.77, 1].map((t, i) => ({
      x: left.x + (right.x - left.x) * t, z: left.z + (right.z - left.z) * t,
      y: base + [15, 22, 24.7, 22, 15][i]
    }));
    for (let i = 1; i < arch.length; i++) p.span(arch[i - 1], arch[i], 1.35, 1.65, 'iron');
    for (let i = 4; i < 7; i++) {
      p.span({ ...corners[i - 1][i % 2 ? j : k], y: base + levels[i - 1] + 1 },
        { ...corners[i][i % 2 ? k : j], y: base + levels[i] + 1 }, 0.82, 0.85, 'iron');
    }
  }
  p.box(x, z, 4.3, 4.3, base + 95, base + 100, 'iron', a);
  p.loft(disk(x, z, 1.8, 8), disk(x, z, 0.14, 8), base + 100, base + height, 'brass');
  return { id, parts: p.parts, skipIds: [building.id] };
}

export function pyramid(building, ground, x, z, edge, height) {
  const id = `theme-giza-${building.id.split('/')[1]}`;
  const p = parkParts(id, ground);
  const angle = 0.18;
  const baseRing = rectangle(x, z, edge, edge, angle);
  const base = p.footing(baseRing, 0.38, 'sandstone');
  const slice = r => rectangle(x, z, edge * r, edge * r, angle);
  p.loft(baseRing, slice(0.26), base, base + height * 0.74, 'sandstone');
  p.loft(slice(0.26), slice(0.012), base + height * 0.74, base + height, 'sandcap');
  return { id, parts: p.parts, skipIds: [building.id] };
}

export function leaningTower(ground) {
  const id = 'theme-pisa';
  // node/10705991225 标识景观；移到其东北侧开阔地，高度按游戏内铁塔的约一半设计。
  const [x, z] = [-8662, 1150];
  const p = scaledParkParts(id, ground, x, z, 54 / 21.2);
  const base = p.footing(disk(x, z, 4.55, 16), 0.43, 'limestone');
  const ring = (y, r) => disk(x + y * 0.154, z + y * 0.038, r, 16);
  p.loft(ring(0, 3.7), ring(3.4, 3.65), base, base + 3.4, 'limestone');
  for (let i = 0; i < 6; i++) {
    const y = 3.4 + i * 2.45;
    p.loft(ring(y, 2.53), ring(y + 2.45, 2.53), base + y, base + y + 2.45, 'recess');
    p.loft(ring(y, 3.69), ring(y + 0.34, 3.69), base + y, base + y + 0.34, 'limestone');
    for (let j = 0; j < 12; j++) {
      const a = j * Math.PI / 6;
      const col = t => disk(x + t * 0.154 + Math.cos(a) * 3.25,
        z + t * 0.038 + Math.sin(a) * 3.25, 0.19, 5);
      p.loft(col(y + 0.33), col(y + 2.13), base + y + 0.33, base + y + 2.13, 'limestone');
    }
    p.loft(ring(y + 2.1, 3.52), ring(y + 2.45, 3.6), base + y + 2.1, base + y + 2.45, 'limestone');
  }
  p.loft(ring(18.1, 2.78), ring(20.8, 2.66), base + 18.1, base + 20.8, 'limestone');
  p.loft(ring(20.8, 2.93), ring(21.2, 2.93), base + 20.8, base + 21.2, 'limestone');
  return { id, parts: p.parts };
}

export function greatWall(ground) {
  const id = 'theme-great-wall';
  const p = parkParts(id, ground);
  // node/6269626844 标记长城模型；沿园界内侧的一小段折线为场景设计。
  const points = [[-6964, 1178], [-6947, 1169], [-6935, 1174], [-6924, 1186], [-6910, 1184],
    [-6897, 1176], [-6881, 1183], [-6865, 1193], [-6847, 1194], [-6835, 1205]];
  const line = points.map(([x, z], i) => ({ x, z, y: ground(x, z) + [2.4, 3.7, 4.4, 4.4, 4.9, 5.5, 4.5, 3.4, 2.9, 2.6][i] * 1.7 }));
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const angle = Math.atan2(b.z - a.z, b.x - a.x);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const ring = rectangle((a.x + b.x) / 2, (a.z + b.z) / 2, length, 4.5, angle);
    p.span(a, b, 4.4, Math.max(a.y, b.y) - p.limits(ring)[0] + 0.27, 'wallstone');
    p.solid(disk(a.x, a.z, 2.22, 8), ground(a.x, a.z) - 0.3, a.y, 'wallstone');
    for (let j = 1; j < length - 0.65; j += 2.25) {
      const t = j / length;
      for (const side of [-1, 1]) {
        const x = a.x + (b.x - a.x) * t - Math.sin(angle) * 1.75 * side;
        const z = a.z + (b.z - a.z) * t + Math.cos(angle) * 1.75 * side;
        const y = a.y + (b.y - a.y) * t;
        p.box(x, z, 1.16, 0.72, y - 0.16, y + 1, 'wallcap', angle);
      }
    }
  }
  for (const i of [0, 4, 9]) {
    const { x, z, y } = line[i];
    const r = rectangle(x, z, 6.3, 6.3);
    const base = p.limits(r)[0] - 0.3;
    p.loft(r, rectangle(x, z, 5.3, 5.3), base, y + 2.6, 'wallstone');
    p.box(x, z, 5.65, 5.65, y + 2.6, y + 3.05, 'wallcap');
    for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) {
      if (a || b) p.box(x + a * 2.13, z + b * 2.13, 1.16, 1.16, y + 3.05, y + 3.92, 'wallcap');
    }
  }
  return { id, parts: p.parts };
}

function hipRoof(p, x, z, y, w, d, rise, style) {
  const eave = rectangle(x, z, w, d);
  const shoulder = rectangle(x, z, w * 0.89, d * 0.76);
  p.solid(eave, y - 0.28, y, style);
  p.loft(eave, shoulder, y, y + rise * 0.28, style);
  // 梯形截面共用屋脊；四面都封闭并由殿身承托。
  p.loft(shoulder, rectangle(x, z, w * 0.64, 0.32), y + rise * 0.28, y + rise, style);
  p.box(x, z, w * 0.66, 0.53, y + rise - 0.06, y + rise + 0.29, 'brass');
}

export function forbiddenCity(ground) {
  const id = 'theme-forbidden-city';
  // 故宫落在御花园 node/3851480004 西侧空地；本模型不替换旁边身份不明的体块。
  const [x, z] = [-6949, 1283];
  const p = scaledParkParts(id, ground, x, z, 1.65);
  const base = p.footing(rectangle(x, z, 31, 56), 0.34, 'courtyard');
  for (const sign of [-1, 1]) {
    p.box(x + sign * 14.8, z, 0.85, 54, base, base + 2.0, 'vermilion');
    p.box(x + sign * 14.8, z, 1.14, 54, base + 2, base + 2.26, 'tilegold');
    p.box(x + sign * 8.7, z + 26.7, 12.2, 0.85, base, base + 2.0, 'vermilion');
    p.box(x + sign * 8.7, z + 26.7, 12.3, 1.06, base + 2, base + 2.26, 'tilegold');
  }
  for (const [offset, w, d, rise] of [[19, 14, 7, 3.3], [0, 22, 11, 4.3], [-19, 15, 8, 3.1]]) {
    const cz = z + offset;
    p.box(x, cz, w + 3.6, d + 2.8, base, base + 0.72, 'limestone');
    p.box(x, cz, w - 2, d - 1.4, base + 0.72, base + 3.55, 'vermilion');
    for (let i = -2; i <= 2; i++) p.box(x + i * w / 5, cz + d / 2 - 0.43, 0.55, 0.55,
      base + 0.72, base + 3.55, 'vermilion');
    hipRoof(p, x, cz, base + 3.59, w + 1.2, d + 1.4, rise, 'tilegold');
    if (offset === 0) {
      p.box(x, cz, w * 0.48, d * 0.43, base + 5.28, base + 6.05, 'vermilion');
      hipRoof(p, x, cz, base + 6.08, w * 0.71, d * 0.6, 2.75, 'tilegold');
    }
  }
  return { id, parts: p.parts };
}

export function potalaPalace(ground) {
  const id = 'theme-potala';
  // 园方确认景观身份；此空地落位、台地高度和建筑轮廓为估计。
  const [x, z] = [-7043, 1249];
  const p = scaledParkParts(id, ground, x, z, 1.58);
  const ridge = rectangle(x, z, 47, 32, -0.08);
  const [low, high] = p.limits(ridge);
  p.loft(ridge, rectangle(x - 1.5, z - 2.5, 35, 21, -0.08), low - 0.28, high + 5.3, 'rock');
  const base = high + 5.3;
  for (const [j, dx, dz, w, d, y, h] of [[0, 0, -2, 34, 19, 0, 3.4],
    [1, -9.5, -2, 17, 16.5, 3.4, 4], [2, 9.8, -3.6, 15, 15, 3.4, 3.1],
    [3, -10.4, -3.8, 11.7, 12, 7.4, 2.45], [4, 0.6, -4.7, 15, 13.5, 3.4, 7.4],
    [5, 0.6, -5.8, 11.1, 10, 10.8, 2.7]]) {
    const cx = x + dx, cz = z + dz, bottom = base + y;
    const style = j < 4 ? 'limestone' : 'vermilion';
    p.loft(rectangle(cx, cz, w, d), rectangle(cx, cz, w - 0.9, d - 0.9), bottom, bottom + h, style);
    p.box(cx, cz, w - 0.48, d - 0.48, bottom + h - 0.06, bottom + h + 0.28, j < 4 ? 'iron' : 'vermilion');
    for (let i = -2; i <= 2; i++) {
      p.box(cx + i * w / 6, cz + d / 2 - 0.24, 0.7, 0.19,
        bottom + h - 1.26, bottom + h - 0.57, 'recess');
      p.parts.at(-1).nearDetail = true;
    }
  }
  for (const dx of [-3.1, 3.3]) hipRoof(p, x + dx, z - 5.8, base + 13.78, 5.4, 5.7, 1.25, 'tilegold');
  return { id, parts: p.parts };
}

export function colosseum(building, ground) {
  const id = 'theme-colosseum';
  const p = parkParts(id, ground);
  // way/1150884237 标识园内模型；把主体放在铁塔东侧的空地。
  const [x, z] = [-8548, 1040];
  const rim = (a, r) => ({ x: x + 43 * r * Math.cos(a), z: z + 31 * r * Math.sin(a) });
  const n = 28, step = Math.PI * 2 / n;
  const deck = Array.from({ length: n }, (_, i) => rim(i * step, 1.03));
  const base = p.footing(deck, 0.52, 'arenaStone');
  const stage = (a, b, y, width, depth, style, r = 1) =>
    p.span({ ...rim(a, r), y: base + y }, { ...rim(b, r), y: base + y }, width, depth, style);
  for (let i = 0; i < n; i++) {
    const a = i * step, b = (i + 1) * step;
    const floors = i < 11 || i >= 24 ? 4 : i < 17 ? 3 : 2;
    const pier = rim(a, 1);
    for (let f = 0; f < floors; f++) {
      const y = f * 6.5;
      p.box(pier.x, pier.z, 2.05, 2.6, base + y, base + y + 6.5, 'arenaStone', a + Math.PI / 2);
      // 拱肩分三段抬升，拱洞下方留空。
      const arc = [0, 0.22, 0.5, 0.78, 1];
      const yArc = [3.5, 4.65, 5.24, 4.65, 3.5];
      for (let j = 1; j < arc.length; j++) {
        p.span({ ...rim(a + step * arc[j - 1], 1), y: base + y + yArc[j - 1] },
          { ...rim(a + step * arc[j], 1), y: base + y + yArc[j] }, 2.28, 1.5, 'arenaStone');
      }
      stage(a, b, y + 6.5, 2.7, 1.28, 'arenaTrim');
    }
    stage(a, b, 1.5, 3.6, 1.5, 'arenaTrim', 0.69);
    stage(a, b, 3.35, 4, 1.9, 'arenaStone', 0.80);
    stage(a, b, 5.35, 3.9, 2.1, 'arenaTrim', 0.90);
  }
  return { id, parts: p.parts, skipIds: [building.id] };
}

export function shaolinTemple(ground) {
  const id = 'theme-shaolin';
  const p = parkParts(id, ground);
  // 园方目录列有少林寺；此处是独立布置的寺院剪影，门朝南。
  const [x, z] = [-6826, 1375];
  const base = p.footing(rectangle(x, z, 53, 40), 0.35, 'courtyard');
  for (const [offset, w, d, body, rise] of [[13, 15, 8, 4.6, 3.4], [-7, 27, 13, 7, 5.4]]) {
    const cz = z + offset;
    p.box(x, cz, w + 3.4, d + 2.8, base, base + 0.7, 'wallstone');
    p.box(x, cz, w - 2.3, d - 2, base + 0.7, base + body, 'vermilion');
    for (let i = -3; i <= 3; i++) {
      p.box(x + i * w / 7.5, cz + d / 2 - 0.45, 0.74, 0.74, base + 0.7, base + body, 'vermilion');
    }
    hipRoof(p, x, cz, base + body, w + 2, d + 1.6, rise, 'templeTile');
  }
  for (const side of [-1, 1]) {
    p.box(x + side * 24.5, z - 1, 1, 30, base, base + 2.9, 'vermilion');
    p.box(x + side * 24.5, z - 1, 1.48, 30, base + 2.9, base + 3.22, 'templeTile');
  }
  return { id, parts: p.parts };
}

export function octagonalPavilion(ground) {
  const id = 'theme-octagonal-pavilion';
  const p = parkParts(id, ground);
  // 景真八角亭为造型参考，选在故宫南侧空地，八柱之间留空。
  const [x, z] = [-6950, 1390];
  const base = p.footing(disk(x, z, 10.8, 8), 0.24, 'limestone');
  const columns = disk(x, z, 6.8, 8);
  for (let i = 0; i < columns.length; i++) {
    const a = columns[i], b = columns[(i + 1) % columns.length];
    p.loft(disk(a.x, a.z, 0.54, 8), disk(a.x, a.z, 0.41, 8), base, base + 6.1, 'vermilion');
    p.span({ ...a, y: base + 6.1 }, { ...b, y: base + 6.1 }, 0.83, 0.78, 'vermilion');
  }
  const roof = (low, high, bottom, top) => p.loft(disk(x, z, low, 8), disk(x, z, high, 8),
    base + bottom, base + top, 'templeTile');
  roof(9.4, 9.4, 6.1, 6.48);
  roof(9.4, 6.8, 6.48, 7.36);
  roof(6.8, 3.5, 7.36, 9.4);
  roof(5.15, 0.85, 9.4, 12.5);
  p.loft(disk(x, z, 0.86, 8), disk(x, z, 0.12, 8), base + 12.5, base + 13.8, 'brass');
  return { id, parts: p.parts };
}
