import { baseAt, footprintParts, point } from './parts.js';
import { panelStrip, points, rect, solid, towerSegment } from './cultural-geometry.js';

const STAGE = 'way/914175439';
const HALL = 'way/914175440';
const SIDE = ['way/914175441', 'way/914175442', 'way/914175445', 'way/914175446', 'way/914175449'];
const HIGH = ['way/914175443', 'way/914175444'];
const ENTRY = 'way/914175450';
export const sourceIds = [STAGE, HALL, ...SIDE, ...HIGH, ENTRY];
export const optionalSkipIds = ['way/777460301'];

export function build(sources, terrain, { heightAt } = {}) {
  const stage = sources.get(STAGE), hall = sources.get(HALL), entry = sources.get(ENTRY);
  const x = stage.cx, z = stage.cz;
  const base = heightAt?.(hall.minX - 4, hall.cz) ?? baseAt(hall, terrain);
  const parts = [
    ...footprintParts(hall, base, 'operaPearl', { id: 'bay-opera:main-hall', min: -0.45 }),
    ...footprintParts(stage, base, 'operaPearl', { id: 'bay-opera:stage-base', min: -0.45, max: hall.height, derived: true })
  ];
  // 50米舞台体集中在南端。高体顶部微收，覆面与朝广场的低玻璃翼分开。
  const shape = points(rect(-28, -14, 28, 14));
  parts.push(towerSegment('bay-opera:fly-tower', stage, shape, base,
    [hall.height, 1, x - 1.2, z - 0.5], [50, 0.91, x + 1.2, z + 1.9], 'operaPearl', { heightSource: 'published' }));
  for (const id of SIDE) {
    const source = sources.get(id);
    parts.push(...footprintParts(source, base, 'cultureDarkGlass', { id: `bay-opera:low-wing:${id}`, min: -0.35 }));
  }
  // 南端低体保留玻璃立面；仅用屋盖跨过入口凹槽。
  const entryFace = points(rect(entry.minX + 4, entry.minZ + 2.6, entry.maxX - 3, entry.cz - 2));
  parts.push(solid('bay-opera:south-vestibule', entry, entryFace, base, -0.4, 6.5, 'cultureDarkGlass'));
  // 广场北侧留出正对门架的步行净空，避开东侧低翼。
  const portalX = hall.maxX + 1.2, portalZ = -195;
  parts.push(solid('bay-opera:entry-glazing', hall, points(rect(hall.maxX - 2, portalZ - 7.4, portalX - 1.25, portalZ + 7.4)),
    base, 0, 7.9, 'cultureDarkGlass'));
  for (const [i, pz] of [portalZ - 8.2, portalZ + 8.2].entries()) {
    parts.push(solid(`bay-opera:portal-jamb:${i}`, hall, points(rect(portalX - 1.2, pz - 0.82, portalX + 4.4, pz + 0.82)),
      base, -0.4, 7.9, 'operaCopper'));
  }
  parts.push(solid('bay-opera:portal-lintel', hall, points(rect(portalX - 1.2, portalZ - 9, portalX + 4.4, portalZ + 9)),
    base, 7.9, 9.6, 'operaCopper'));
  // 广场一侧的白色波形挑檐。分段板保留下面的开口，贴回主厅侧墙。
  const wave = [[-207, -18161, 15], [-193, -18160, 16.7], [-176, -18157, 17.9],
    [-162, -18158, 19.1], [-148, -18165, 18.0], [-136, -18170, 16.4],
    [-120, -18163, 15.2], [-104, -18153, 17.8], [-90, -18154, 19.4], [-83, -18160, 18.6]];
  const shell = wave.map(([z0, x0, y]) => [
    { ...point(x0 - 8, z0), y: base + y + 2.0, depth: 2.0 },
    { ...point(x0 + 2.5, z0), y: base + y - 0.7, depth: 2.7 }
  ]);
  parts.push(...panelStrip('bay-opera:plaza-wave', hall, shell, 'operaPearl'));
  return parts;
}
