import { baseAt, point, roofPanelPart } from './parts.js';
import { fittedRing, points, rect, solid, towerSegment } from './cultural-geometry.js';

export const sourceIds = ['way/1327466582'];

export function build(sources, terrain, { heightAt } = {}) {
  const source = sources.get(sourceIds[0]);
  const [footprint] = source.polygons;
  const base = heightAt?.(source.cx, source.cz + 53) ?? baseAt(source, terrain);
  const { cx, cz } = source;
  // 锁定足迹的四角沿东北、东南、西南、西北展开；以源多边形作为最宽一层的外檐。
  const outline = [...footprint.outer];
  const area = outline.reduce((sum, p, i) => {
    const q = outline[(i + 1) % outline.length];
    return sum + (p.x - cx) * (q.z - cz) - (p.z - cz) * (q.x - cx);
  }, 0);
  if (area < 0) outline.reverse();
  const shape = outline.map(p => point(p.x - cx, p.z - cz));
  const at = (h, k) => [h, k, cx, cz];
  const parts = [solid('qianhai-museum:recessed-lobby', source, fittedRing(shape, cx, cz, 0.52),
    base, -0.48, 8.7, 'cultureDarkGlass')];
  // 五级出檐由下到上展开。内收玻璃和金属斜檐分别成体，屋面不作公共通行面。
  const courses = [
    [8.7, 0.58, 12.8, 0.68, 15.2, 0.59],
    [18.0, 0.62, 23.9, 0.75, 26.2, 0.65],
    [29.0, 0.67, 36.8, 0.81, 39.0, 0.71],
    [42.0, 0.73, 48.7, 0.89, 51.6, 0.76],
    [54.8, 0.79, 61.1, 1.00, 67.1, 0.85]
  ];
  for (const [i, [start, inner, edge, widest, end, top]] of courses.entries()) {
    const prev = i === 0 ? 8.7 : courses[i - 1][4];
    if (start > prev) parts.push(towerSegment(`qianhai-museum:glass:${i}`, source, shape, base,
      at(prev, inner - 0.012), at(start, inner), 'cultureDarkGlass'));
    parts.push(towerSegment(`qianhai-museum:eave:${i}`, source, shape, base, at(start, inner), at(edge, widest), 'qianhaiTiles'));
    if (i < courses.length - 1) {
      parts.push(towerSegment(`qianhai-museum:eave-return:${i}`, source, shape, base,
        at(edge, widest), at(end, top), 'qianhaiTiles'));
    } else {
      // 顶层四侧上收，中央留真实凹园；环形盖板与绿心底板分开。
      const outer = fittedRing(shape, cx, cz, top);
      const rim = fittedRing(shape, cx, cz, widest);
      const garden = fittedRing(shape, cx, cz, 0.63);
      for (let k = 0; k < rim.length; k++) {
        const j = (k + 1) % rim.length;
        const p = (v, y) => ({ ...v, y: base + y });
        for (const [n, corners] of [[p(rim[k], edge), p(rim[j], edge), p(outer[j], end)],
          [p(rim[k], edge), p(outer[j], end), p(outer[k], end)]].entries()) {
          parts.push(roofPanelPart(`qianhai-museum:upper-slope:${k}:${n}`, source, corners, 2.0, 'qianhaiTiles'));
        }
      }
      parts.push(solid('qianhai-museum:garden-rim', source, outer, base, 62.2, 67.1, 'cultureStone', { holes: [garden] }));
      parts.push(solid('qianhai-museum:roof-garden', source, garden, base, 60.4, 63.1, 'cultureRoofGarden'));
      const square = points(rect(cx - 23, cz - 23, cx + 23, cz + 23));
      for (let k = 0; k < 4; k++) {
        parts.push(roofPanelPart(`qianhai-museum:skylight:${k}`, source,
          [{ ...square[k], y: base + 63.3 }, { ...square[(k + 1) % 4], y: base + 63.3 }, { x: cx, z: cz, y: base + 68 }],
          0.38, 'cultureSkylight', { heightSource: 'published' }));
      }
    }
  }
  return parts;
}
