import { roofPanelPart, spanPart } from '../sz-landmarks/parts.js';
import { STR } from '../sz-strings.js';
import { frame } from './kit.js';

export const SOUTH_GATE_ID = 'way/1183877518';

export function buildSouthGate(kit, source, heightAt) {
  // 源足迹的南北门洞中心取自 way/1436861800，两条外边取自门体足迹。
  const f = frame(-14279.05, 160.275, 0.971, -0.237);
  const base = heightAt(-14279.05, 160.275);
  const width = 13.3, depth = 9.31, clear = 2.18, wallTop = 6.78;
  const block = (u, v, lo, hi, w, d, style, id) =>
    kit.box(f.at(u, v), base + lo, base + hi, w, d, f, style, source, id);
  for (const sign of [-1, 1]) {
    const w = width / 2 - clear;
    block(sign * (clear + w / 2), 0, -0.22, wallTop, w, depth, 'oldBrick');
    block(sign * (clear + w / 2), 0, -0.22, 1.48, w, depth + 0.10, 'granite');
  }
  // 拱券的下沿按同一曲线生成斜棱柱；门洞净空与显示形状一致。
  const arch = (u, r, shoulder, rise) => shoulder + rise * Math.sqrt(Math.max(0, 1 - (u / r) ** 2));
  function archBand(id, a, b, d, spring, crown, outerSpring, outerCrown, r, style) {
    const u = f.at(a, 0), v = f.at(b, 0);
    const yA = base + arch(a, r, spring, crown);
    const yB = base + arch(b, r, spring, crown);
    const topA = base + (outerCrown === 0 ? outerSpring : arch(a, r, outerSpring, outerCrown));
    const topB = base + (outerCrown === 0 ? outerSpring : arch(b, r, outerSpring, outerCrown));
    const row = spanPart(id, source, { ...u, y: topA }, { ...v, y: topB }, d, d, 0.25, style);
    const bottom = [yA, yB, yB, yA];
    kit.part({ ...row, bottom, minY: Math.fround(Math.min(yA, yB)) });
  }
  for (let i = 0; i < 22; i++) {
    const a = clear * (i / 11 - 1), b = clear * ((i + 1) / 11 - 1);
    archBand(`nantou:south-gate:arch:${i}`, a, b, depth, 2.40, 1.9, wallTop, 0, clear, 'oldBrick');
    archBand(`nantou:south-gate:stones:${i}`, a, b, depth + 0.12, 2.40, 1.9, 2.76, 1.93, clear,
      i % 4 === 1 ? 'stone' : 'granite');
  }
  block(0, 0, wallTop - 0.06, wallTop + 0.23, width + 0.52, depth + 0.46, 'granite');
  for (const v of [-depth / 2 + 0.23, depth / 2 - 0.23]) {
    block(0, v, wallTop + 0.22, wallTop + 0.78, width + 0.32, 0.53, 'oldBrick');
    for (let u = -5.7; u < 6.1; u += 1.42) block(u, v, wallTop + 0.75, wallTop + 1.14, 0.72, 0.56, 'oldBrick');
  }
  kit.label(f.at(0, depth / 2 + 0.11), base + 5.13, 2.0, 0.74, f, STR.districts.ningnan, '#302d27', '#b3a898');
  kit.label(f.at(0, depth / 2 + 0.13), base + 6.17, 4.58, 0.72, f, STR.districts.nantouGate, '#d0af71', '#383632');
  for (const x of [-3.15, 3.15]) {
    kit.piece(f.at(x, depth / 2 + 0.16), base + 2.42, 0.25, 0.41, 0.24, f, 'lamp');
    kit.lamp(f.at(x, depth / 2 + 1.3), base + 2.3, 72, 13);
    kit.lamp(f.at(x, -depth / 2 - 0.8), base + 2.35, 36, 8);
  }
  return { base, roof: base + wallTop + 1.14 };
}

export function buildSouthPaifang(kit, heightAt, clear) {
  // 牌坊已见于运营方资料。快照无足迹，沿中山南街南段配准；尺寸与两翼墙均为场景设计。
  const source = { id: 'design:nantou-paifang', heightSource: 'estimate' };
  const f = frame(-14273.04, 282.4, 0.998, 0.063);
  const y = heightAt(-14273.04, 282.4);
  const block = (u, v, lo, hi, w, d, style, id) =>
    kit.box(f.at(u, v), y + lo, y + hi, w, d, f, style, source, id);
  for (const u of [-6.7, -3.4, 3.4, 6.7]) {
    block(u, 0, -0.12, 0.37, 1.26, 1.38, 'granite');
    block(u, 0, 0.35, Math.abs(u) > 5 ? 4.55 : 6.24, 0.66, 0.7, 'stone');
    block(u, 0, 0.42, 0.87, 0.9, 0.97, 'granite');
  }
  function roof(id, u, width, d, eave, ridge) {
    for (const sign of [-1, 1]) {
      const stations = [-1, -0.79, -0.48, 0, 0.48, 0.79, 1];
      for (let i = 1; i < stations.length; i++) {
        const tilePoint = (t, v, level) => ({ ...f.at(u + t * width / 2, v), y: y + level });
        const a = stations[i - 1], b = stations[i];
        const lift = t => 0.34 * Math.abs(t) ** 5;
        const A = tilePoint(a, sign * d / 2, eave + lift(a));
        const B = tilePoint(b, sign * d / 2, eave + lift(b));
        const C = tilePoint(b * 0.83, 0, ridge + lift(b));
        const D = tilePoint(a * 0.83, 0, ridge + lift(a));
        for (const [j, tri] of [[0, [A, B, C]], [1, [A, C, D]]]) {
          kit.part(roofPanelPart(`nantou:${id}:${sign}:${i}:${j}`, source, tri, 0.22, 'tile'), false);
        }
      }
      for (let t = -0.95; t <= 0.96; t += 0.047) {
        const q = f.at(u + t * width / 2, sign * d / 2);
        kit.piece(q, y + eave + 0.34 * Math.abs(t) ** 5, 0.13, 0.16, 0.19, f, 'tile');
      }
    }
    block(u, 0, ridge - 0.02, ridge + 0.19, width * 0.86, 0.23, 'tile');
  }
  for (const side of [-1, 1]) {
    block(side * 5.1, 0, 3.72, 4.56, 3.55, 0.69, 'stone');
    roof(`paifang-wing-${side}`, side * 5.12, 4.21, 1.89, 4.47, 5.36);
    kit.piece(f.at(side * 3.4, 0.48), y + 3.36, 0.18, 0.38, 0.15, f, 'lamp');
    kit.lamp(f.at(side * 3.4, 1.55), y + 3.4, 43, 11);
  }
  block(0, 0, 4.73, 6.2, 7.75, 0.83, 'stone');
  block(0, 0, 4.66, 4.84, 8.05, 1.01, 'granite');
  kit.label(f.at(0, 0.46), y + 5.5, 5.67, 1.01, f, STR.districts.nantouPaifang, '#574837', '#d5c5a4');
  roof('paifang-center', 0, 8.48, 2.56, 6.16, 7.41);

  for (const side of [-1, 1]) {
    const start = side < 0 ? 7.35 : 7.45, end = side < 0 ? 14.15 : 9.18;
    const wallX = side * (start + end) / 2;
    const length = end - start;
    const offset = -2.1;
    if (![start, (start + end) / 2, end].every(u => clear(f.at(side * u, offset), y, 3))) continue;
    block(wallX, offset, -0.15, 2.36, length, 1.24, 'oldBrick', `nantou:design-wall:${side}`);
    block(wallX, offset, -0.15, 0.65, length + 0.05, 1.34, 'granite');
    block(wallX, offset, 2.29, 2.51, length + 0.11, 1.40, 'granite');
    block(side * end, offset, -0.1, 2.62, 0.37, 1.36, 'oldBrick');
  }
}
