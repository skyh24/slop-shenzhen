import { MAP, addRing, boundsOf, overlaps } from './sz-map-layers.js';
import { distanceToRing, polygonContainsInclusive } from './sz-polygon.js';
import { spatialIndex } from './sz-spatial.js';
import { STR } from './sz-strings.js';

const REGION_COLOURS = Object.freeze({
  retail: '#d6ac69', public: '#79bddb', park: '#85c78f', residential: '#ba9bd9',
  office: '#68c6bb', village: '#d99590', unknown: '#a9b4c2'
});

function regionName(region) {
  return region.name || STR.map.regionUnnamed[region.type];
}

function regionZoom(region) {
  if (region.level === 'building') return 1.15;
  if (region.level === 'block') return 0.45;
  if (region.areaM2 >= 180000) return 0.018;
  if (region.areaM2 >= 35000) return 0.055;
  if (region.areaM2 >= 10000) return 0.13;
  if (region.areaM2 >= 2600) return 0.26;
  return 0.57;
}

function insideBounds({ minX, minZ, maxX, maxZ }, x, z) {
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}

function boundaryDistance(polygon, x, z) {
  let d = distanceToRing(polygon.outer, x, z);
  for (const hole of polygon.holes) d = Math.min(d, distanceToRing(hole, x, z));
  return d;
}

function createMapRegions(records = []) {
  const regions = records.map((data) => {
    const { polygons } = data;
    const path = new Path2D();
    const bounds = boundsOf(polygons.flatMap(polygon => polygon.outer));
    const region = { ...data, path, bounds, minZoom: regionZoom(data) };
    region.pieces = polygons.map((polygon) => {
      addRing(path, polygon.outer);
      for (const hole of polygon.holes) addRing(path, hole, true);
      return { region, polygon, bounds: boundsOf(polygon.outer) };
    });
    return region;
  });
  // 大区域先画；命中则反过来，先选更具体的对象，同级时先选面积小的。
  const specificity = { block: 0, place: 1, building: 2 };
  const compare = (a, b) => specificity[a.level] - specificity[b.level]
    || b.areaM2 - a.areaM2 || (a.id < b.id ? -1 : Number(a.id !== b.id));
  regions.sort(compare);
  const atPoint = spatialIndex(regions.flatMap(region => region.pieces), piece => piece.polygon.outer);
  const visible = (region, zoom, layers) => zoom >= region.minZoom
    && (region.type === 'retail' ? layers.retail : layers.regions);

  function hit(x, z, zoom, layers, previous = null) {
    if (!layers.retail && !layers.regions) return null;
    let best = null;
    for (const piece of atPoint(x, z)) {
      if (!visible(piece.region, zoom, layers) || !insideBounds(piece.bounds, x, z)) continue;
      if (best && compare(piece.region, best.region) <= 0) continue;
      if (polygonContainsInclusive(piece.polygon, x, z)) best = piece;
    }
    // 仅在新位置确实属于另一对象时使用边界缓冲。道路、水面或空白处立即清除。
    if (best && previous && previous !== best.region && visible(previous, zoom, layers)) {
      const margin = 1.8 / zoom;
      if (boundaryDistance(best.polygon, x, z) < margin && previous.pieces.some(({ polygon, bounds }) =>
        x >= bounds.minX - margin && x <= bounds.maxX + margin
        && z >= bounds.minZ - margin && z <= bounds.maxZ + margin
        && boundaryDistance(polygon, x, z) < margin)) return previous;
    }
    return best?.region ?? null;
  }

  function draw(ctx, view, layers, buildings = false) {
    if (!layers.retail && !layers.regions) return;
    for (const region of regions) {
      if ((region.level === 'building') !== buildings
        || !visible(region, view.s, layers) || !view.sees(region.bounds)) continue;
      const color = REGION_COLOURS[region.type];
      ctx.fillStyle = color + '38';
      ctx.fill(region.path, 'evenodd');
      ctx.strokeStyle = color + 'aa';
      ctx.lineWidth = 1 / view.s;
      ctx.stroke(region.path);
    }
  }

  function drawLabels(ctx, view, layers, placed, font, textWidth) {
    if (!layers.retail && !layers.regions) return;
    ctx.font = `650 11px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    let count = 0;
    for (const region of regions) {
      if (!visible(region, view.s, layers) || !view.sees(region.bounds)) continue;
      const name = regionName(region);
      const half = textWidth(ctx, name) / 2 + 4;
      for (const [x, z, clearance] of region.anchors) {
        if (clearance * view.s < Math.hypot(half, 8)) continue;
        const X = view.toX(x), Y = view.toY(z);
        const box = [X - half, Y - 8, X + half, Y + 8];
        if (box[0] < -view.w / 2 || box[1] < -view.h / 2 || box[2] > view.w / 2
          || box[3] > view.h / 2 || overlaps(placed, box)) continue;
        placed.push(box);
        ctx.fillStyle = REGION_COLOURS[region.type];
        ctx.strokeText(name, X, Y);
        ctx.fillText(name, X, Y);
        count++;
        break;
      }
      if (count >= 64) break;
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawHighlight(ctx, view, region, layers) {
    if (!region || !visible(region, view.s, layers) || !view.sees(region.bounds)) return;
    ctx.save();
    view.world(ctx);
    // 只画内侧轮廓。复用静态底图，且不让高亮伸入车行道或水体。
    ctx.clip(region.path, 'evenodd');
    ctx.strokeStyle = REGION_COLOURS[region.type] + 'ee';
    ctx.lineWidth = 4.5 / view.s;
    ctx.stroke(region.path);
    ctx.restore();
  }

  return { regions, hit, draw, drawLabels, drawHighlight };
}

export { createMapRegions, REGION_COLOURS, regionName };
