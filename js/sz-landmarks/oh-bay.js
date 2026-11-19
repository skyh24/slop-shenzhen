import { baseAt, footprintParts, loftPart, spanPart } from './parts.js';
import { ellipse, rect, volume } from './model-profile.js';
import { cutRing } from './retail-sections.js';

// 轮心取 OSM node/7851738804；接待楼足迹单独放置。轮面方向与构件截面为估计。
export const wheel = {
  sourceIds: ['way/914175455'],
  build(source, terrain) {
    const hall = source.get(this.sourceIds[0]);
    const base = baseAt(hall, terrain);
    const at = (u, v) => ({ x: -17638.1 + u * 0.8 - v * 0.6, z: 248.7 + u * 0.6 + v * 0.8 });
    const p = (u, v, y) => ({ ...at(u, v), y: base + y });
    const parts = footprintParts(hall, base, 'shoppingParkGlass', { max: hall.height - 0.4, topFace: false });
    parts.push(...footprintParts(hall, base, 'operaPearl', {
      id: 'oh-bay:reception-eave', min: hall.height - 0.4, max: hall.height, bottomFace: false
    }));
    const radius = 56.65, hub = 128 - radius - 2.1;
    const rim = (angle, side) => p(radius * Math.cos(angle), side, hub + radius * Math.sin(angle));
    function beam(id, a, b, width, endWidth = width, style = 'bayWheelSteel') {
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      const rise = b.y - a.y;
      if (Math.abs(rise) > run) {
        const [low, high, w0, w1] = rise > 0 ? [a, b, width, endWidth] : [b, a, endWidth, width];
        const section = (c, w) => ellipse((x, z) => ({ x: c.x + x, z: c.z + z }), 0, 0, w / 2, w / 2, 8);
        parts.push(loftPart(id, hall, section(low, w0), section(high, w1), low.y, high.y, style));
      } else {
        parts.push(spanPart(id, hall, { ...a, y: a.y + width / 2 }, { ...b, y: b.y + width / 2 },
          width, endWidth, width, style));
      }
    }
    for (const side of [-1, 1]) {
      for (const foot of [-1, 1]) {
        beam(`oh-bay:fin:${side}:${foot}`, p(foot * 23, side * 11, 0), p(foot * 11, side * 8, 30), 3.1, 4.6);
        beam(`oh-bay:fin-tip:${side}:${foot}`, p(foot * 11, side * 8, 30), p(0, side * 4.8, hub), 4.6, 2.4);
      }
      for (let i = 0; i < 56; i++) {
        const angle = i * Math.PI / 28;
        const start = parts.length;
        beam(`oh-bay:rim:${side}:${i}`, rim(angle, side * 1.9), rim(angle + Math.PI / 28, side * 1.9), 0.85, 0.85, 'bayWheelRim');
        beam(`oh-bay:spoke:${side}:${i}`, p(0, side * 3.7, hub), rim(angle, side * 1.9), 0.20, 0.20, 'bayWheelWire');
        for (let j = start; j < parts.length; j++) parts[j].wheelMotion = 'rim';
      }
    }
    beam('oh-bay:axle', p(0, -6.5, hub), p(0, 6.5, hub), 5.4);
    for (let i = 0; i < 28; i++) {
      const a = i * Math.PI / 14;
      const u = radius * Math.cos(a), y = base + hub + radius * Math.sin(a);
      const outer = ellipse(at, u, 0, 2.5, 2.55), inner = ellipse(at, u, 0, 2.5 * 0.72, 2.55 * 0.72);
      const pod = `oh-bay:cabin:${i}`;
      const start = parts.length;
      parts.push(loftPart(pod + ':sill', hall, inner, outer, y - 2.1, y - 1.35, 'bayWheelSteel'),
        loftPart(pod + ':panorama', hall, outer, outer, y - 1.35, y + 1.35, 'bayCabinGlass', { smoothSides: true }),
        loftPart(pod + ':cap', hall, outer, inner, y + 1.35, y + 2.1, 'bayWheelSteel', { heightSource: i === 7 ? 'osm' : 'estimate' }));
      for (let j = start; j < parts.length; j++) parts[j].wheelMotion = i;
    }
    parts.push(volume('oh-bay:boarding', hall, rect(at, 0, 0, 21, 7.4), base, base + hub - radius - 2.14, 'shoppingParkStone'));
    return parts;
  }
};

export const eastShore = {
  sourceIds: ['way/902736738'],
  build(source, terrain) {
    const retail = source.get(this.sourceIds[0]);
    const base = baseAt(retail, terrain), outline = retail.polygons[0].outer;
    const parts = [];
    // 在商业东岸源面内留三条通向水岸的开敞巷道。退台和花园轮廓按设计资料概化。
    const cuts = [retail.minX - 1, -17816, -17736, -17660, retail.maxX + 1];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const block = cutRing(cutRing(outline, 'x', cuts[i] + (i ? 4 : 0), true),
        'x', cuts[i + 1] - (i < cuts.length - 2 ? 4 : 0), false);
      if (block.length < 3) continue;
      const id = `oh-bay:east:${i}`;
      const upper = cutRing(block, 'x', cuts[i + 1] - 10, false);
      const garden = cutRing(upper, 'x', cuts[i + 1] - 21, false);
      parts.push(volume(id + ':shops', retail, block, base, base + 4.5, 'shoppingParkStorefront'),
        volume(id + ':terrace', retail, block, base + 4.5, base + 5.1, 'operaPearl'),
        volume(id + ':glazing', retail, upper, base + 5.1, base + retail.height - 0.5, 'shoppingParkGlass'),
        volume(id + ':eave', retail, upper, base + retail.height - 0.5, base + retail.height, 'operaPearl'),
        volume(id + ':garden', retail, garden, base + retail.height, base + retail.height + 0.22, 'cultureRoofGarden'));
    }
    return parts;
  }
};

// 海府一号三组相邻源楼，每组由临海翼、中段和北翼拼合。保留北翼源高，向海分级退台。
export const haifu = [
  ['way/777460295', 'way/1269043225', 'way/777460294'],
  ['way/777460297', 'way/1269043226', 'way/777460296'],
  ['way/777460299', 'way/1269043227', 'way/777460298']
].map((sourceIds, index) => ({
  id: 'oh-bay-haifu-' + (index + 1),
  sourceIds,
  build(source, terrain) {
    return sourceIds.flatMap((id, i) => {
      const wing = source.get(id), ring = wing.polygons[0].outer;
      const base = baseAt(wing, terrain), roof = base + wing.height * [0.68, 0.84, 1][i];
      const key = 'haifu:' + id;
      const parts = [];
      let bottom = base;
      for (let floor = 1; floor <= 4; floor++) {
        const top = base + (roof - base) * floor / 4;
        parts.push(volume(key + ':glass:' + floor, wing, ring, bottom, top - 0.48, 'shoppingParkGlass'),
          volume(key + ':band:' + floor, wing, ring, top - 0.48, top, 'operaPearl',
            { heightSource: i === 2 && floor === 4 ? wing.heightSource : 'estimate' }));
        bottom = top;
      }
      const planting = ring.map(p => ({ x: wing.cx + (p.x - wing.cx) * 0.91, z: wing.cz + (p.z - wing.cz) * 0.91 }));
      parts.push(volume(key + ':planting', wing, planting, roof, roof + 0.18, 'cultureRoofGarden'));
      return parts;
    });
  }
}));
