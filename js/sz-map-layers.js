import { STR } from './sz-strings.js';
import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { ROADS } from './sz-city-config.js';

// 复用纽约的画布变换、分块路径、道路标注与玩家标记，坐标保持深圳真北向上。
const MAP = {
  water: '#0a1118',
  land: '#151a20',
  landEdge: '#252c35',
  islands: '#162019',
  islandsEdge: '#26392c',
  piers: '#283039',
  streets: '#363f4b',
  gardenPath: '#95856d',
  shore: '#4f5b6b',
  park: '#19301f',
  parkEdge: '#24432f',
  block: '#1c2128',
  blockEdge: '#272e37',
  lawn: '#1e3a26',
  drive: '#2c4033',
  transverse: '#22332a',
  pond: '#0f2535',
  pondEdge: '#1d3d54',
  buildings: ['#242a32', '#2b323c', '#343c48'],
  buildingEdge: '#171b21',
  landmarkFill: 'rgba(255, 255, 255, 0.06)',
  landmarkEdge: 'rgba(255, 255, 255, 0.38)',
  mainRoads: '#3a434f',
  highway: '#b27a35',
  bridge: '#c08a3e',
  route: '#ffc21a',
  rail: '#6f93c9',
  droneRoute: '#7fd0ff',
  droneStation: '#ffcf6b',
  railFill: 'rgba(111, 147, 201, 0.20)',
  search: '#5fd0ff',
  halo: 'rgba(8, 11, 15, 0.9)'
};

function accessor(pts) {
  const flat = typeof pts[0] === 'number';
  return {
    n: flat ? pts.length >> 1 : pts.length,
    X: flat ? (i) => pts[2 * i] : (i) => pts[i].x,
    Z: flat ? (i) => pts[2 * i + 1] : (i) => pts[i].z
  };
}

function boundsOf(pts) {
  const { n, X, Z } = accessor(pts);
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < n; i++) {
    const x = X(i);
    const z = Z(i);
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

function addRing(path, pts, hole = false) {
  if (!pts || pts.length < 3) return;
  const { n, X, Z } = accessor(pts);
  if (n < 3) return;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += X(j) * Z(i) - X(i) * Z(j);
  if ((a >= 0) !== hole) {
    path.moveTo(X(0), Z(0));
    for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
  } else {
    path.moveTo(X(n - 1), Z(n - 1));
    for (let i = n - 2; i >= 0; i--) path.lineTo(X(i), Z(i));
  }
  path.closePath();
}

function addLine(path, pts) {
  if (!pts || pts.length < 2) return;
  const { n, X, Z } = accessor(pts);
  path.moveTo(X(0), Z(0));
  for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
}

class TiledLayer {
  constructor(size = 500) {
    this.size = size;
    this.tiles = new Map();
  }

  pathFor(b) {
    const ix = Math.floor((b.minX + b.maxX) * 0.5 / this.size);
    const iz = Math.floor((b.minZ + b.maxZ) * 0.5 / this.size);
    const key = `${ix},${iz}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { path: new Path2D(), minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
      this.tiles.set(key, t);
    } else {
      t.minX = Math.min(t.minX, b.minX);
      t.maxX = Math.max(t.maxX, b.maxX);
      t.minZ = Math.min(t.minZ, b.minZ);
      t.maxZ = Math.max(t.maxZ, b.maxZ);
    }
    return t.path;
  }

  ring(pts, holes = []) {
    if (!pts || pts.length < 3) return;
    const path = this.pathFor(boundsOf(pts));
    addRing(path, pts);
    for (const hole of holes) addRing(path, hole, true);
  }

  line(pts) {
    if (pts && pts.length > 1) addLine(this.pathFor(boundsOf(pts)), pts);
  }

  each(v, fn) {
    for (const t of this.tiles.values()) {
      if (t.maxX < v.minX || t.minX > v.maxX || t.maxZ < v.minZ || t.minZ > v.maxZ) continue;
      fn(t.path);
    }
  }
}

class MapView {
  constructor(cx, cz, s, w, h, dpr = 1) {
    this.cx = cx;
    this.cz = cz;
    this.s = s;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.minX = cx - w / (2 * s);
    this.maxX = cx + w / (2 * s);
    this.minZ = cz - h / (2 * s);
    this.maxZ = cz + h / (2 * s);
  }

  world(ctx) {
    const { s, dpr } = this;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, dpr * (this.w * 0.5 - this.cx * s), dpr * (this.h * 0.5 - this.cz * s));
  }

  screen(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * this.w * 0.5, this.dpr * this.h * 0.5);
  }

  toX(x) {
    return (x - this.cx) * this.s;
  }

  toY(z) {
    return (z - this.cz) * this.s;
  }

  sees(b) {
    return b && b.maxX >= this.minX && b.minX <= this.maxX && b.maxZ >= this.minZ && b.minZ <= this.maxZ;
  }
}

function drawPlayerArrow(ctx, tipY, halfWidth, tailY) {
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(halfWidth, tailY);
  ctx.lineTo(0, tailY * 0.45);
  ctx.lineTo(-halfWidth, tailY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawWaypoint(ctx, x, y, r) {
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.route;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.38, 0, Math.PI * 2);
  ctx.fill();
}

const overlaps = (boxes, b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

const isElevated = road => !road.tunnel && (road.bridge || road.layer > 0);
const ROAD_LABELS = [];
for (const r of ROADS) {
  const text = r.name;
  if (!text || /^Unnamed/.test(text)) continue;
  const anchors = [];
  const pts = r.pts;
  for (let i = 0; i + 1 < pts.length;) {

    const a = pts[i];
    const dir = Math.atan2(pts[i + 1].z - a.z, pts[i + 1].x - a.x);
    let j = i + 1;
    while (j + 1 < pts.length) {
      const d = Math.atan2(pts[j + 1].z - pts[j].z, pts[j + 1].x - pts[j].x);
      let turn = Math.abs(d - dir);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > 0.09) break;
      j++;
    }
    const c = pts[j];
    i = j;
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (len < 20) continue;
    let ang = Math.atan2(c.z - a.z, c.x - a.x);
    if (ang >= Math.PI * 0.5 - 0.01) ang -= Math.PI;
    else if (ang < -Math.PI * 0.5 - 0.01) ang += Math.PI;
    const k = Math.max(1, Math.round(len / 260));
    for (let m = 0; m < k; m++) {
      const t = (m + 0.5) / k;
      anchors.push({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t, ang, len: len / k });
    }
  }
  if (!anchors.length) continue;
  ROAD_LABELS.push({
    text,
    lower: text.toLowerCase(),
    raw: r.name.toLowerCase(),
    road: r,
    elevated: isElevated(r),
    major: r.highway || r.w >= 15,
    highway: r.highway,
    anchors,
    ...boundsOf(r.pts)
  });
}
const ROAD_NAME_COUNT = new Set(ROAD_LABELS.map((l) => l.text)).size;


let LAYERS;
function droneMapLayer(stations, routes) {
  const markers = stations.map(station => ({ ...station, bounds: boundsOf([station]) }));
  const tracks = [];
  for (const route of routes) {
    const points = route.path?.points;
    if (!points) continue;
    const path = new Path2D();
    addLine(path, points);
    tracks.push({ id: route.id, path, bounds: boundsOf(points) });
  }
  return { routes: tracks, stations: markers };
}

function mapLayers() {
  if (LAYERS) return LAYERS;
  const layers = {};
  for (const name of ['coverage', 'land', 'green', 'wetland', 'water']) {
    layers[name] = new TiledLayer();
    for (const polygon of GEO[name] || []) layers[name].ring(polygon.outer, polygon.holes);
  }
  layers.roads = ROADS.map(road => {
    const path = new Path2D();
    addLine(path, road.pts);
    return { ...road, elevated: isElevated(road), path, bounds: boundsOf(road.pts) };
  });
  layers.gardenPaths = new TiledLayer();
  for (const { trianglesXZ } of GEO.golfCourse?.surfaces ?? []) {
    for (let i = 0; i < trianglesXZ.length; i += 6) layers.gardenPaths.ring(trianglesXZ.slice(i, i + 6));
  }
  // 全图高铁图层：只用 sites 段里已核实的站体/场地轮廓，不画没有来源的线路。
  layers.hsr = [];
  for (const station of [{ id: 'futian-station', role: 'station', name: '福田站', note: '地下高铁', underConstruction: false },
    { id: 'xili-station', role: 'site', name: '西丽站', note: '在建', underConstruction: true },
    { id: 'shenzhen-north', role: 'station', name: STR.hsr.north, note: STR.hsr.highSpeedRail, underConstruction: false }]) {
    const polygons = GEO.sites?.[station.id]?.[station.role]?.polygons;
    if (!Array.isArray(polygons) || polygons.length === 0) continue;
    const path = new Path2D();
    for (const polygon of polygons) {
      addLine(path, [...polygon.outer, polygon.outer[0]]);
      for (const hole of polygon.holes ?? []) addLine(path, [...hole, hole[0]]);
    }
    const points = polygons.flatMap(polygon => polygon.outer);
    layers.hsr.push({ ...station, path, bounds: boundsOf(points) });
  }
  const metroColours = new Map((GEO.metro?.lines || []).map(line => [line.ref, line.colour]));
  layers.metro = (GEO.metro?.segments || []).map(segment => {
    const path = new Path2D();
    addLine(path, segment.points);
    const lines = segment.lineRefs.map(ref => ({ ref, colour: metroColours.get(ref) || '#8995a3' }));
    return { path, bounds: boundsOf(segment.points), lines };
  });
  LAYERS = layers;
  return layers;
}
let FOOTPRINTS;
function footprintLayers() {
  if (FOOTPRINTS) return FOOTPRINTS;
  const tones = [new TiledLayer(), new TiledLayer(), new TiledLayer()];
  for (const building of REAL_BUILDINGS) {
    const layer = tones[building.height > 95 ? 2 : building.height > 45 ? 1 : 0];
    for (const polygon of building.polygons) layer.ring(polygon.outer, polygon.holes);
  }
  FOOTPRINTS = { tones, version: 1 };
  return FOOTPRINTS;
}
export { MAP, ROAD_LABELS, ROAD_NAME_COUNT, MapView, addLine, addRing, boundsOf, mapLayers, footprintLayers, droneMapLayer, drawPlayerArrow, drawWaypoint, overlaps };
