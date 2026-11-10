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

// 控制标高：屋顶、观景层、擦窗机层取自业主表与 CTBUH；顶冠折面起点（579 m）与冠内空腔范围为照片判读，实心顶盖起点取源 590 m 组。
const LOBBY_TOP = 22; // EST：街面照里入口玻璃与上部幕墙的分界
const OBSERVATION_ROOF = 555.6; // PUBLISHED：CTBUH 最高使用层
const OBSERVATION_DECK = 562.1; // PUBLISHED：观景层
const BMU_FLOOR = 567.65; // PUBLISHED：擦窗机层
const VOID_BOTTOM = 579; // EST：顶冠折面起点兼空腔底，冠高约 20 m
const CROWN_BASE = 590; // DATA：源 590 m 组标高，模型用作实心顶盖起点
const TOTAL_HEIGHT = 599.1; // PUBLISHED：CTBUH 建筑总高

// 收分折线（各段直线，单位米）：0–120 m 保持满宽，之后按源分块足迹外框逐段收分。
// 源 590 m 组外框 43.1 m 与 20 m 冠高不能同时成立（冠只有 9.1 m 时会过平，见调研 A4），
// 这里把 43.1 m 读作冠体底部框架，冠底取 579 m、44.35 m，折面连续收到顶尖 11.9 m。
const TAPER = [[0, 76.5], [120, 76.5], [407, 62.7], [467, 52.8], [OBSERVATION_ROOF, 47],
  [VOID_BOTTOM, 44.35], [TOTAL_HEIGHT, 11.9]];
// 平面：源足迹是 76.5 × 75.8 m 外包、4 个 7.0–7.3 m 深角缺口的 20 顶点轮廓。
// loft 只接受凸截面，这里用 45° 切角八边形派生近似：中段幕墙 40.6 / 41.3 m 对源 40.7 / 41.1–41.2 m，
// 角缺口被简化为斜面，缺口返墙上的 8 根巨柱按源位置比例摆在斜面两侧。
const BASE_WIDTH = 76.5;
const BASE_DEPTH = 75.8;
const CHAMFER = 17.6;

// 巨柱：每角 2 根共 8 根（DATA），宽 5.7→2.8 m、深 2.7→1.15 m（EST，保持照片里 13–15% 的面宽占比），
// 外表面比幕墙凸出 0.4 m；两根分居切角斜面两侧，随收分内倾，形成照片里通高的长斜线（“V”）。
const COLUMN_TIERS = [0, 120, 407, 467, OBSERVATION_ROOF, VOID_BOTTOM];
const COLUMN_WIDTH = [5.7, 2.8];
const COLUMN_DEPTH = [2.7, 1.15];
const COLUMN_PROTRUSION = 0.4;
const COLUMN_POSITIONS = [0.26, 0.74];
// 四条 45° 切角斜面（八边形顶点 1→2、3→4、5→6、7→0）：8 根巨柱与 4 支顶冠钢腿都落在这四面。
const CORNER_FACES = [1, 3, 5, 7];
const LEG_WIDTH = [4.8, 3.2];
const LEG_DEPTH = [1.55, 1.25];
const LEG_PROTRUSION = 0.45;

function widthAt(y) {
  for (let i = 1; i < TAPER.length; i++) {
    const [y0, w0] = TAPER[i - 1];
    const [y1, w1] = TAPER[i];
    if (y <= y1) return blend(w0, w1, (y - y0) / (y1 - y0));
  }
  return TAPER.at(-1)[1];
}

function towerFrame(tip) {
  // 截面中心取源顶尖小方形中心，与塔基包围盒中心相差约一分米。
  const outline = width => {
    const s = width / BASE_WIDTH;
    const x = BASE_WIDTH * s / 2;
    const z = BASE_DEPTH * s / 2;
    const c = CHAMFER * s;
    return [[-(x - c), -z], [x - c, -z], [x, -(z - c)], [x, z - c],
      [x - c, z], [-(x - c), z], [-x, z - c], [-x, -(z - c)]]
      .map(([u, v]) => point(tip.cx + u, tip.cz + v));
  };
  return { outline };
}

function edgeFrame(ring, i) {
  const a = ring[i];
  const b = ring[(i + 1) % ring.length];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const d = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
  return { a, b, length, d, n: { x: d.z, z: -d.x } };
}

function rectangle(center, x, z, width, depth) {
  const w = width / 2, d = depth / 2;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([u, v]) =>
    point(center.x + x * u - z * v, center.z + z * u + x * v));
}

function towerShell(source, base, frame) {
  const levels = [
    [LOBBY_TOP, 'pingAnGlass'], [120, 'pingAnGlass'], [407, 'pingAnGlass'], [467, 'pingAnGlass'],
    [543.6, 'pingAnObservation'], [OBSERVATION_ROOF, 'pingAnObservation'],
    [OBSERVATION_DECK, 'pingAnObservation'], [BMU_FLOOR, 'pingAnGlass'], [VOID_BOTTOM, null]
  ].map(([y, style]) => ({ y, ring: frame.outline(widthAt(y)), style }));
  return levels.slice(0, -1).map((level, i) => {
    const next = levels[i + 1];
    return loftPart(`${source.id}:shaft:${i}`, source, level.ring, next.ring, base + level.y, base + next.y,
      level.style, { uvOriginY: base });
  });
}

function crownShell(source, tip, base, frame) {
  // 冠底 579–590 m 的折面是薄玻璃面，内部留空腔；顶盖 590–599.1 m 是实心折面，平顶取源顶尖小方形。
  // 两段共用同一条折线，外轮廓从 579 m 连续收到 599.1 m，不出现折角。
  const lower = frame.outline(widthAt(VOID_BOTTOM));
  const upper = frame.outline(widthAt(CROWN_BASE));
  const parts = [];
  for (let i = 0; i < lower.length; i++) {
    const low = edgeFrame(lower, i);
    const high = edgeFrame(upper, i);
    const a = point((low.a.x + low.b.x) / 2, (low.a.z + low.b.z) / 2);
    const b = point((high.a.x + high.b.x) / 2, (high.a.z + high.b.z) / 2);
    parts.push(spanPart(`${source.id}:crown-skirt:${i}`, source,
      { x: a.x, y: base + VOID_BOTTOM, z: a.z }, { x: b.x, y: base + CROWN_BASE, z: b.z },
      low.length, high.length, 1.2, 'pingAnGlass'));
  }
  parts.push(loftPart(`${tip.id}:diamond-crown`, tip, upper, frame.outline(widthAt(TOTAL_HEIGHT)),
    base + CROWN_BASE, base + TOTAL_HEIGHT, 'pingAnCrown', { heightSource: tip.heightSource, baseSourceId: source.id }));
  return parts;
}

function megaColumns(source, base, frame) {
  // 每个切角斜面摆 2 根，共 8 根，编号 0–7 与源构件顺序无关、只用于分层命名。
  const parts = [];
  CORNER_FACES.forEach((face, corner) => {
    COLUMN_POSITIONS.forEach((t, side) => {
      const index = corner * COLUMN_POSITIONS.length + side;
      const section = y => {
        const e = edgeFrame(frame.outline(widthAt(y)), face);
        const along = y / VOID_BOTTOM;
        const width = blend(COLUMN_WIDTH[0], COLUMN_WIDTH[1], along);
        const depth = blend(COLUMN_DEPTH[0], COLUMN_DEPTH[1], along);
        const offset = COLUMN_PROTRUSION - depth / 2;
        return rectangle(point(blend(e.a.x, e.b.x, t) + e.n.x * offset,
          blend(e.a.z, e.b.z, t) + e.n.z * offset), e.d.x, e.d.z, width, depth);
      };
      for (let i = 1; i < COLUMN_TIERS.length; i++) {
        parts.push(loftPart(`${source.id}:mega-column:${index}:${i}`, source,
          section(COLUMN_TIERS[i - 1]), section(COLUMN_TIERS[i]),
          base + COLUMN_TIERS[i - 1], base + COLUMN_TIERS[i], 'pingAnSteel'));
      }
    });
  });
  return parts;
}

function crownLegs(source, base, frame) {
  const lower = frame.outline(widthAt(BMU_FLOOR));
  const upper = frame.outline(widthAt(CROWN_BASE));
  return CORNER_FACES.map((face, k) => {
    const low = edgeFrame(lower, face);
    const high = edgeFrame(upper, face);
    const section = (e, width, depth) => rectangle(
      point((e.a.x + e.b.x) / 2 + e.n.x * (LEG_PROTRUSION - depth / 2),
        (e.a.z + e.b.z) / 2 + e.n.z * (LEG_PROTRUSION - depth / 2)),
      e.d.x, e.d.z, width, depth);
    return loftPart(`${source.id}:crown-leg:${k}`, source,
      section(low, LEG_WIDTH[0], LEG_DEPTH[0]), section(high, LEG_WIDTH[1], LEG_DEPTH[1]),
      base + BMU_FLOOR, base + CROWN_BASE, 'pingAnCrownEdge');
  });
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
  const frame = towerFrame(tip);
  return [...westLobby(source, base), ...towerShell(source, base, frame), ...crownShell(source, tip, base, frame),
    ...megaColumns(source, base, frame), ...crownLegs(source, base, frame), ...retailParts(buildings, terrain)];
}

export { sourceIds, build };
