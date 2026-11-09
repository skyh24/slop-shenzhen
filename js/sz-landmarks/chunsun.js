import { baseAt, blend, loftPart, point } from './parts.js';

const CORE = 'way/1270310100';
const sourceIds = Array.from({ length: 73 }, (_, index) => `way/${1270310028 + index}`);
const GROUPS = 28;
const SECTOR = 2 * Math.PI / GROUPS;
const DESIGN_HEIGHT = 400;
const WAIST = 127.5;
const SHOULDER = 258;
const CROWN = 327;
const LOW = [0, 27.75, 55.5];
const MID = [55.5, 90, WAIST, 170, 213, SHOULDER];
const HIGH = [SHOULDER, 292.5, CROWN];
const TOP = [CROWN, 350, 372, 390, 398.5, DESIGN_HEIGHT];

// KPF 参数图给出 258 米处 R28、设计顶高 400 米和上段弧半径 638.979967 米。
const UPPER_ARC_RADIUS = 638.979967;
const rise = DESIGN_HEIGHT - SHOULDER;
const chord = Math.hypot(28, rise);
const distanceToChord = Math.sqrt(UPPER_ARC_RADIUS ** 2 - (chord / 2) ** 2);
const arcX = 14 - rise * distanceToChord / chord;
const arcY = (DESIGN_HEIGHT + SHOULDER) / 2 - 28 * distanceToChord / chord;
const shoulderSlope = -(SHOULDER - arcY) / (28 - arcX);

function cubic(y, a, b, radiusA, radiusB, slopeA, slopeB) {
  const t = (y - a) / (b - a);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * radiusA + (t3 - 2 * t2 + t) * slopeA * (b - a)
    + (-2 * t3 + 3 * t2) * radiusB + (t3 - t2) * slopeB * (b - a);
}

function profileRadius(y) {
  if (y <= WAIST) return cubic(y, 0, WAIST, 31, 33.75, 0.045, 0);
  if (y <= SHOULDER) return cubic(y, WAIST, SHOULDER, 33.75, 28, 0, shoulderSlope);
  return Math.max(0.055, arcX + Math.sqrt(UPPER_ARC_RADIUS ** 2 - (y - arcY) ** 2));
}

function build(buildings, terrain) {
  const source = buildings.get(CORE);
  const base = baseAt(source, terrain);
  const { cx, cz } = source;
  const east = source.polygons[0].outer.reduce((a, b) => a.x > b.x ? a : b);
  const origin = Math.atan2(east.z - cz, east.x - cx);
  // 设计图只用于形态比例，整塔竖向归到 CTBUH 与当前 OSM 的建成高度。
  const worldY = designY => base + source.height * designY / DESIGN_HEIGHT;
  const location = (r, angle) => point(cx + r * Math.cos(angle), cz + r * Math.sin(angle));
  const ring = (r, angle) => Array.from({ length: GROUPS * 2 }, (_, i) => location(r, angle + i * SECTOR / 2));
  const facade = designY => {
    // 实景首层玻璃退至斜交柱后，支柱之间的外围可通行。逐个门扇位置暂无测绘。
    const lobbySetback = 2.8 * Math.max(0, 1 - designY / LOW.at(-1));
    return ring(profileRadius(designY) - lobbySetback, origin - SECTOR / 4);
  };

  const parts = [];
  const shell = [0, 13.875, ...LOW.slice(1), ...MID.slice(1), ...HIGH.slice(1), ...TOP.slice(1)];
  for (let i = 1; i < shell.length; i++) {
    const a = shell[i - 1], b = shell[i];
    const style = a >= CROWN ? 'chunsunCrown' : a < LOW.at(-1) ? 'chunsunLobby' : 'chunsunGlass';
    parts.push(loftPart(`${source.id}:skin:${i}`, source, facade(a), facade(b), worldY(a), worldY(b), style,
      { uvOriginY: base, heightSource: b === DESIGN_HEIGHT ? source.heightSource : 'estimate' }));
  }

  function addRib(name, a, b, angleA, angleB, tangent, style) {
    const s = Math.sin(tangent), c = Math.cos(tangent);
    const section = (y, angle) => {
      const r = profileRadius(y);
      const center = location(r + 0.13, angle);
      const halfWidth = y >= CROWN ? Math.min(r * 0.26, blend(0.18, 0.145, y / DESIGN_HEIGHT)) : blend(0.22, 0.17, y / DESIGN_HEIGHT);
      const depth = Math.min(r * 0.31, y <= LOW.at(-1) ? 0.64 : 0.43);
      return [[-halfWidth, depth], [halfWidth, depth], [halfWidth, -depth], [-halfWidth, -depth]].map(([u, v]) =>
        point(center.x - s * u + c * v, center.z + c * u + s * v));
    };
    parts.push(loftPart(`${source.id}:${name}`, source, section(a, angleA), section(b, angleB), worldY(a), worldY(b), style));
  }

  for (let i = 0; i < GROUPS; i++) {
    const axis = origin + i * SECTOR;
    for (const sign of [-1, 1]) {
      const tag = `${i}:${sign}`;
      const midAngle = axis + sign * SECTOR / 4;
      const jointAngle = axis + sign * SECTOR / 2;
      addRib(`diagrid-base:${tag}:1`, LOW[0], LOW[1], axis, jointAngle, midAngle, 'chunsunEntrySteel');
      addRib(`diagrid-base:${tag}:2`, LOW[1], LOW[2], jointAngle, midAngle, midAngle, 'chunsunEntrySteel');
      for (let j = 1; j < MID.length; j++) {
        addRib(`vertical-rib:${tag}:${j}`, MID[j - 1], MID[j], midAngle, midAngle, midAngle, 'chunsunSteel');
      }
      addRib(`diagrid-crown:${tag}:1`, HIGH[0], HIGH[1], midAngle, jointAngle, midAngle, 'chunsunCrownSteel');
      addRib(`diagrid-crown:${tag}:2`, HIGH[1], HIGH[2], jointAngle, axis, midAngle, 'chunsunCrownSteel');
    }
    for (let j = 1; j < TOP.length - 1; j++) {
      addRib(`peak-rib:${i}:${j}`, TOP[j - 1], TOP[j], axis, axis, axis, 'chunsunCrownSteel');
    }
  }
  return parts;
}

export { sourceIds, build };
