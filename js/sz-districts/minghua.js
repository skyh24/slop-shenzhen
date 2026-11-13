import { convexHull } from '../building-collision.js';
import { loftPart } from '../sz-landmarks/parts.js';
import { STR } from '../sz-strings.js';
import { frame, railing, solid } from './kit.js';

export const MINGHUA_ID = 'way/105683429';

export function buildMinghua(kit, source, waterY, quayHeight) {
  const outer = convexHull(source.polygons[0].outer);
  // 船首向东北。水线、舷弧和上层高度从照片估计，甲板平面以快照外廓为上限。
  const f = frame(source.cx, source.cz, 0.565, -0.825);
  const ring = scale => outer.map(p => ({
    x: source.cx + (p.x - source.cx) * scale,
    z: source.cz + (p.z - source.cz) * scale
  }));
  const hull = (id, a, b, bottom, top, style) => kit.part(loftPart(`minghua:${id}`, source,
    ring(a), ring(b), waterY + bottom, waterY + top, style, { smoothSides: true }));
  hull('keel', 0.75, 0.92, -2.1, -0.22, 'waterline');
  hull('boot-stripe', 0.92, 0.94, -0.22, 0.52, 'waterline');
  hull('flared-hull', 0.94, 1, 0.52, 9.5, 'hull');
  hull('main-deck', 1, 1, 9.5, 9.83, 'ivory');

  const Y = y => y + waterY;
  const block = (u, v, w, d, lo, hi, style, id) =>
    kit.box(f.at(u, v), Y(lo), Y(hi), w, d, f, style, source, id);
  for (const [i, u, w, d, bottom, top] of [
    [0, -2, 127, 16.2, 9.83, 12.95],
    [1, 0, 113, 14.2, 13.18, 16.30],
    [2, 6, 92, 12.4, 16.53, 19.64],
    [3, 19, 57, 10.4, 19.86, 22.79]
  ]) {
    block(u, 0, w, d, bottom, top, 'hull', `minghua:deckhouse:${i}`);
    block(u - 0.4, 0, w + 2.8, d + 2.15, top, top + 0.23, 'white', `minghua:deck:${i}`);
    for (const sign of [-1, 1]) {
      const side = sign * (d / 2 + 0.036);
      for (let x = u - w / 2 + 2.1; x < u + w / 2 - 1.6; x += 2.48) {
        kit.piece(f.at(x, side), Y(bottom + 1.67), 1.38, i === 3 ? 0.94 : 1.28, 0.1, f, 'glass', { detail: false });
      }
      railing(kit, f, Y(top + 0.23), u - w / 2, u + w / 2, sign * (d / 2 + 1), 'silver');
      for (let x = u - w / 2 + 2; x < u + w / 2; x += 6.8) {
        kit.piece(f.at(x, sign * (d / 2 + 1.08)), Y(top + 0.19), 1.9, 0.055, 0.1, f, 'lamp');
      }
    }
  }
  // 驾驶台横向窗带、双烟囱与救生艇按照片作轮廓表达。
  block(39, 0, 9, 13.2, 22.79, 25.25, 'white', 'minghua:bridge');
  const bow = f.at(43.55, 0);
  const bowFace = frame(bow.x, bow.z, -f.s, f.c);
  for (let v = -5.5; v <= 5.5; v += 1.22) {
    kit.piece(bowFace.at(v, 0), Y(24.19), 1.03, 1.08, 0.1, bowFace, 'glass', { detail: false });
  }
  block(39, 0, 10.1, 14, 25.25, 25.54, 'white', 'minghua:bridge-roof');
  for (const [u, v, w, h] of [[-11, -2.85, 3.4, 4.1], [-11, 2.85, 3.4, 4.1]]) {
    kit.piece(f.at(u, v), Y(22.86 + h / 2), w, h, 2.55, f, 'terra', { shape: 'cylinder', detail: false });
    kit.piece(f.at(u, v), Y(22.86 + h), w * 0.9, 0.56, 2.5, f, 'navy', { shape: 'cylinder', detail: false });
  }
  for (const [u, from, to] of [[38, 25.45, 34.1], [-56, 12.92, 23.1]]) {
    kit.piece(f.at(u, 0), Y((from + to) / 2), 0.27, to - from, 0.27, f, 'white', { detail: false });
    kit.piece(f.at(u, 0), Y(to - 1.45), 0.14, 0.13, 7.2, f, 'white', { detail: false });
    kit.piece(f.at(u, 0), Y(to - 3.15), 0.15, 0.14, 4.2, f, 'silver');
    kit.piece(f.at(u, 0), Y(to + 0.1), 0.25, 0.25, 0.25, f, 'lamp');
  }
  for (const sign of [-1, 1]) for (const u of [-43, -29, -15, -1]) {
    const p = f.at(u, sign * 8.55);
    kit.piece(p, Y(14.35), 8.6, 1.3, 2.1, f, 'white', { shape: 'cylinder', detail: false });
    kit.piece(p, Y(14.86), 7.7, 0.48, 1.75, f, 'orange', { shape: 'cylinder', detail: false });
    for (const offset of [-3.3, 3.3]) {
      kit.piece(f.at(u + offset, sign * 7.95), Y(15.65), 0.15, 1.7, 0.15, f, 'silver');
    }
  }
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    const edge = frame(a.x, a.z, b.x - a.x, b.z - a.z);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const count = Math.floor(len / 2.75);
    for (let j = 1; j <= count; j++) {
      for (const y of [4.2, 6.6]) {
        const p = edge.at(len * j / (count + 1), -0.05);
        const x = source.cx + (p.x - source.cx) * (y < 5 ? 0.968 : 0.983);
        const z = source.cz + (p.z - source.cz) * (y < 5 ? 0.968 : 0.983);
        kit.piece({ x, z }, Y(y), 0.55, 0.55, 0.23, edge, 'glass', { shape: 'disc' });
      }
    }
    railing(kit, edge, Y(9.83), 0, len, 0, 'white');
  }
  // 船名贴在按船体放样计算的前舷面上，避免平面牌穿进弧面。
  const toLong = p => (p.x - source.cx) * f.c + (p.z - source.cz) * f.s;
  const toSide = p => -(p.x - source.cx) * f.s + (p.z - source.cz) * f.c;
  const scale = 0.94 + 0.06 * (7.7 - 0.52) / (9.5 - 0.52);
  for (const [i, a] of outer.entries()) {
    const b = outer[(i + 1) % outer.length];
    const start = toLong(a), stop = toLong(b), along = 58;
    if (along < Math.min(start, stop) || along >= Math.max(start, stop)) continue;
    const t = (along - start) / (stop - start);
    const side = toSide(a) * (1 - t) + toSide(b) * t;
    const p = f.at(along * scale, side * scale);
    const face = frame(p.x, p.z, a.x - b.x, a.z - b.z);
    kit.label(face.at(0, 0.33), Y(7.7), 5.8, 1.32, face, STR.districts.minghua, '#273843', '#f0eee4');
  }
  const title = f.at(2, 7.4);
  kit.label(title, Y(18.95), 14.6, 2.05, f, STR.districts.seaWorld, '#9f3226', '#f0eee4');

  const end = { x: -14685.3, z: 6636.2 };
  const landY = quayHeight(end.x, end.z);
  if (Number.isFinite(landY)) {
    // 源步道 way/543176160–161 指向舷侧，具体接驳高程未知；栏门关闭，通道不注册为可走表面。
    const towardShip = frame(end.x, end.z, 0.82, 0.57);
    const walkY = landY + 0.08;
    const bridge = { outer: [towardShip.at(0, -0.95), towardShip.at(7.0, -0.95),
      towardShip.at(7.0, 0.95), towardShip.at(0, 0.95)], holes: [] };
    kit.part(solid('minghua:closed-gangway', source, bridge, walkY - 0.24, walkY, 'steel'));
    for (const v of [-0.95, 0.95]) railing(kit, towardShip, walkY, 0, 7.0, v, 'silver');
    const gate = frame(end.x, end.z, -towardShip.s, towardShip.c);
    railing(kit, gate, landY, -1, 1, 0, 'steel', { detail: false, height: 1.35 });
    kit.box(end, landY, landY + 1.35, 2.04, 0.12, gate, 'silver', source, 'minghua:closed-gate');
    kit.label(gate.at(0, 0.075), landY + 1.18, 1.35, 0.28, gate, STR.districts.closed);
  }
  return { base: waterY - 2.1, roof: Y(34.35), outline: outer };
}
