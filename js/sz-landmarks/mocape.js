import { baseAt, point, spanPart } from './parts.js';
import { panelStrip, points, rect, solid, towerSegment } from './cultural-geometry.js';

export const sourceIds = ['way/456331569'];

export function build(sources, terrain, { heightAt } = {}) {
  const source = sources.get(sourceIds[0]);
  const { cx, cz } = source;
  const base = heightAt?.(source.minX - 6, cz) ?? baseAt(source, terrain);
  // 东侧北馆/南馆各成实体，西侧入口玻璃退在共享折面和拱檐之后。
  const wing = points([[-55, -27], [26, -27], [47, -15], [47, 27], [-42, 27], [-55, 17]]);
  const parts = [];
  for (const [i, dz] of [-43, 42].entries()) {
    const x = cx + 20;
    parts.push(towerSegment(`mocape:gallery:${i}:base`, source, wing, base,
      [-0.45, 0.83, x + 3, cz + dz], [9.4, 0.86, x + 1, cz + dz], 'cultureDarkGlass'));
    parts.push(towerSegment(`mocape:gallery:${i}:metal`, source, wing, base,
      [9.4, 0.86, x + 1, cz + dz], [35.9, 1, x - 1, cz + dz * 1.02], 'mocapeMetal'));
    parts.push(towerSegment(`mocape:gallery:${i}:top`, source, wing, base,
      [35.9, 1, x - 1, cz + dz * 1.02], [40, 0.96, x, cz + dz], 'mocapeMetal', { heightSource: 'published' }));
  }
  parts.push(solid('mocape:east-cleft', source, points(rect(cx + 16, cz - 22, cx + 58, cz + 22)),
    base, 1, 34.5, 'mocapeGlass'));
  parts.push(solid('mocape:shared-foyer', source, points(rect(cx - 28, cz - 29, cx + 12, cz + 32)),
    base, 8.9, 31.5, 'mocapeGlass'));
  const wedge = points([[-21, -25], [15, -26], [25, -11], [26, 18], [-11, 25], [-21, 14]]);
  for (const [i, dz, side] of [[0, -46, -1], [1, 48, 1]]) {
    parts.push(towerSegment(`mocape:west-fold:${i}`, source, wedge, base,
      [0, 0.71, cx - 25, cz + dz + side * 3],
      [38.7, 1, cx - 50, cz + dz], 'mocapeMetal'));
  }
  // 共享门厅前的拱檐用分段折面；中跨净高与内退玻璃真实分离。
  const rib = Array.from({ length: 13 }, (_, i) => {
    const t = (i - 6) / 6;
    const h = Math.sqrt(Math.max(0, 1 - t * t));
    const z = cz + t * 35;
    return [
      { x: cx - 64 - 7 * h, z, y: base + 35 + 2.8 * h, depth: 31.8 - 26.0 * h },
      { x: cx - 25, z, y: base + 36.6, depth: 9.1 - 5.0 * h }
    ];
  });
  parts.push(...panelStrip('mocape:west-entrance-arch', source, rib, 'mocapeMetal'));
  // 主层约10米，采用门外可踩踏的分段台阶；室内展区仍不建。
  const steps = 48;
  const foot = cx - 77, run = 46, width = 25;
  for (let i = 0; i < steps; i++) {
    const a = foot + i * run / steps, b = foot + (i + 1) * run / steps;
    parts.push(solid(`mocape:entrance-step:${i}`, source, points(rect(a, cz - width / 2, b, cz + width / 2)),
      base, -0.22, (i + 1) * 9.1 / steps, 'cultureStone'));
  }
  const lip = (x, y) => ({ ...point(x, cz), y: base + y });
  parts.push(spanPart('mocape:entry-landing', source, lip(cx - 31, 9.1), lip(cx - 28, 9.1),
    width, width, 0.38, 'cultureStone', { roofContact: true }));
  return parts;
}
