import { baseAt, blend, footprintParts, loftPart, point, spanPart } from './parts.js';

const NORTH = 'overture/825c9559-0144-4342-a025-a1e4b93d49a0';
const TIP = 'way/1472466096';
const MALL = 'way/773719239';
const BRIDGE = 'way/773719241';
const SOUTH_PODIUM = 'way/773719242';
// 源快照用多组地面垂直挤出的足迹表示不同楼高，细片 6055 未进入运行包。
const NORTH_PARTS = Array.from({ length: 54 }, (_, index) => 1472466043 + index)
  .filter(id => id !== 1472466055).map(id => `way/${id}`);
const sourceIds = [NORTH, ...NORTH_PARTS, MALL, BRIDGE, SOUTH_PODIUM];

// 相对建筑基准。塔身屋顶、擦窗机层出自业主表和剖面，截面间收分按源足迹与建成照片派生。
const LOBBY_TOP = 22;
const OBSERVATION_ROOF = 555.6;
const BMU_FLOOR = 567.65;
const VOID_BOTTOM = 579;
const CROWN_BASE = 590;

function towerFrame(source, tip) {
  const { cx, cz } = tip;
  // 源主立面与坐标轴平行，顶冠小方形的中心与底部外框中心相差约一分米。
  const foot = (source.maxX - source.minX + source.maxZ - source.minZ) / 4;
  const crown = (tip.maxX - tip.minX + tip.maxZ - tip.minZ) / 4;
  const outline = (half, chamfer) => {
    const side = half - chamfer;
    return [[-side, -half], [side, -half], [half, -side], [half, side],
      [side, half], [-side, half], [-half, side], [-half, -side]]
      .map(([x, z]) => point(cx + x, cz + z));
  };
  return { foot, crown, outline };
}

function towerShell(source, tip, base, frame) {
  const { foot, crown, outline } = frame;
  const profile = [
    [LOBBY_TOP, foot - 0.18, 17.5, 'pingAnGlass'],
    [63, foot - 1.65, 17, 'pingAnGlass'],
    [120, 31.25, 13.9, 'pingAnGlass'],
    [407, 29.95, 15.1, 'pingAnGlass'],
    [467, 27.8, 14.8, 'pingAnGlass'],
    [OBSERVATION_ROOF - 12, 23, 11.6, 'pingAnObservation'],
    [OBSERVATION_ROOF, 20.1, 10.2, 'pingAnObservation'],
    [BMU_FLOOR, 13.4, 6.1, 'pingAnObservation'],
    [VOID_BOTTOM, 7.8, 3.8, null]
  ];
  const levels = profile.map(([y, half, chamfer, style]) => ({ y, ring: outline(half, chamfer), style }));
  const shell = levels.slice(0, -1).map(({ y, ring, style }, i) => {
    const next = levels[i + 1];
    return loftPart(`${source.id}:shaft:${i}`, source, ring, next.ring, base + y, base + next.y,
      style, { uvOriginY: base });
  });
  // 实景照片可透过钻石顶冠下方。承托顶盖的四支钢腿单独建，不填成玻璃锥体。
  const crownFoot = outline(crown, 0.38);
  const crownCap = outline(0.055, 0.01);
  shell.push(loftPart(`${tip.id}:diamond-crown`, tip, crownFoot, crownCap,
    base + CROWN_BASE, base + tip.height, 'pingAnCrown', { heightSource: tip.heightSource, baseSourceId: source.id }));
  return { shell, levels, crownFoot };
}

function rectangle(center, x, z, width, depth) {
  const w = width / 2, d = depth / 2;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([u, v]) =>
    point(center.x + x * u - z * v, center.z + z * u + x * v));
}

function structuralSteel(source, base, frame, levels, crownFoot) {
  const ground = { y: 0, ring: frame.outline(frame.foot - 2.4, 15.2) };
  const supports = [];
  const tiers = [ground, ...levels.filter(level => level.y <= BMU_FLOOR)];
  for (let i = 0; i < 8; i++) {
    const xAxis = i % 4 <= 1;
    const section = (p, y) => {
      const t = y / BMU_FLOOR;
      return rectangle(p, xAxis ? 1 : 0, xAxis ? 0 : 1, blend(5.7, 2.8, t), blend(2.7, 1.15, t));
    };
    for (let j = 1; j < tiers.length; j++) {
      const a = tiers[j - 1], b = tiers[j];
      supports.push(loftPart(`${source.id}:mega-column:${i}:${j}`, source,
        section(a.ring[i], a.y), section(b.ring[i], b.y), base + a.y, base + b.y, 'pingAnSteel'));
    }
  }
  const lower = tiers.at(-1);
  for (let i = 1; i < 8; i += 2) {
    const j = (i + 1) % 8;
    const mid = ring => point(blend(ring[i].x, ring[j].x, 0.5), blend(ring[i].z, ring[j].z, 0.5));
    const x = Math.sign(lower.ring[j].x - lower.ring[i].x) * Math.SQRT1_2;
    const z = Math.sign(lower.ring[j].z - lower.ring[i].z) * Math.SQRT1_2;
    supports.push(loftPart(`${source.id}:crown-leg:${i}`, source, rectangle(mid(lower.ring), x, z, 4.8, 1.55),
      rectangle(mid(crownFoot), x, z, 2.05, 1.3), base + lower.y, base + CROWN_BASE, 'pingAnCrownEdge'));
  }
  return supports;
}

function westLobby(source, base) {
  const plazaX = source.minX;
  const setback = plazaX + 4.9;
  // 西立面建成照片可见柱间门厅和折板雨篷。退界、尺寸按照片与源面宽估计。
  const clip = ring => ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const inside = a.x >= setback;
    const points = inside ? [a] : [];
    if (inside !== (b.x >= setback)) points.push(point(setback, blend(a.z, b.z, (setback - a.x) / (b.x - a.x))));
    return points;
  });
  const lobby = { ...source, polygons: [{ outer: clip(source.polygons[0].outer), holes: [] }] };
  const at = (x, z, y) => ({ x: plazaX + x, y: base + y, z: source.cz + z });
  return [
    ...footprintParts(lobby, base, 'pingAnLobby', { id: `${source.id}:lobby`, max: LOBBY_TOP, derived: true }),
    spanPart(`${source.id}:lobby-canopy`, source, at(0, -13.2, 8.4), at(0, 13.2, 8.4), 9, 9, 0.7, 'pingAnSteel'),
    spanPart(`${source.id}:canopy-fold:north`, source, at(0, -13.2, 8.4), at(1.3, -18, 4.5), 9, 4.3, 0.7, 'pingAnSteel'),
    spanPart(`${source.id}:canopy-fold:south`, source, at(0, 13.2, 8.4), at(1.3, 18, 4.5), 9, 4.3, 0.7, 'pingAnSteel')
  ];
}

function retailParts(buildings, terrain) {
  const north = buildings.get(MALL);
  const bridge = buildings.get(BRIDGE);
  const south = buildings.get(SOUTH_PODIUM);
  const northY = baseAt(north, terrain);
  const southY = baseAt(south, terrain);
  const entranceHeight = 8.8;
  return [
    ...footprintParts(north, northY, 'pingAnMallBase', { id: `${north.id}:base`, max: entranceHeight, derived: true }),
    ...footprintParts(north, northY, 'pingAnMall', { id: `${north.id}:mall`, min: entranceHeight, derived: true }),
    ...footprintParts(bridge, baseAt(bridge, terrain), 'pingAnMall', { roofContact: true }),
    ...footprintParts(south, southY, 'pingAnMallBase', { id: `${south.id}:base`, max: entranceHeight, derived: true }),
    ...footprintParts(south, southY, 'pingAnMall', { id: `${south.id}:mall`, min: entranceHeight, derived: true })
  ];
}

function build(buildings, terrain) {
  const source = buildings.get(NORTH);
  const tip = buildings.get(TIP);
  const base = baseAt(source, terrain);
  const frame = towerFrame(source, tip);
  const { shell, levels, crownFoot } = towerShell(source, tip, base, frame);
  return [...westLobby(source, base), ...shell, ...structuralSteel(source, base, frame, levels, crownFoot),
    ...retailParts(buildings, terrain)];
}

export { sourceIds, build };
