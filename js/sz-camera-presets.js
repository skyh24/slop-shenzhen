import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { terrainHeight } from './sz-terrain.js';

const landmarks = new Map(GEO.landmarks.map(l => [l.id, l]));
const nonferrousTower = REAL_BUILDINGS.find(b => b.id === 'way/1163682856');

function anchor(id, dx = 0, dy = 0, dz = 0) {
  const landmark = landmarks.get(id);
  if (!landmark) throw new Error(`Unknown scenic landmark: ${id}`);
  const base = terrainHeight(GEO.terrain, landmark.x, landmark.z);
  if (base === null) throw new Error(`Missing scenic terrain: ${id}`);
  return [landmark.x + dx, base + dy, landmark.z + dz];
}

function bayBridgeShot() {
  const park = GEO.parks.find(item => item.id === 'shenzhen-bay-park');
  const theater = park?.areas.find(area => area.osmId === 'way/571629065');
  const fallback = landmarks.get('shenzhen-bay-park');
  const [x, z] = theater?.arrivals.at(-1) ?? [fallback.x, fallback.z];
  const base = terrainHeight(GEO.terrain, x, z);
  if (base === null) throw new Error('Missing scenic terrain: bayBridge');
  const position = [x, base + 35, z];
  const bridge = GEO.bridges.find(item => item.id === 'shenzhen-bay-bridge');
  const landmark = landmarks.get('shenzhen-bay-bridge');
  if (!bridge) return { position, target: [landmark.x, position[1], landmark.z] };
  const [north, south] = bridge.spans.map(span => span.tower);
  return { position, target: [(north.x + south.x) / 2, (north.y + south.y) / 2, (north.z + south.z) / 2] };
}

function nonferrousShot() {
  // 缺失部件的旧包仍可在已核实的塔身足迹中心取景。
  const { cx = -3369.45, cz = 897.4 } = nonferrousTower ?? {};
  const base = terrainHeight(GEO.terrain, cx, cz);
  if (base === null) throw new Error('Missing scenic terrain: nonferrousTower');
  return { position: [cx - 55.55, base + 13.55, cz + 77.6], target: [cx - 6.55, base + 36.55, cz + 8.6] };
}

// 机位偏移是取景设计，不代表实测观景台位置或真实运营航线。
export function getScenicCamera(id, elapsed = 0) {
  switch (id) {
    case 'centralPark': return { position: anchor('lianhuashan', 0, 20, 0), target: anchor('civic-center', 0, 30, 0) };
    case 'fifthAve': return { position: anchor('shenzhen-bay-park', 0, 60, 100), target: anchor('chunsun', 0, 160, 0) };
    case 'timesSquare': return { position: anchor('civic-center', 0, 12, 140), target: anchor('lianhuashan', 0, 35, 0) };
    case 'chryslerGCT': return { position: anchor('talent-park', 80, 15, 0), target: anchor('chunsun', 0, 180, 0) };
    case 'observatory': return { position: anchor('ping-an', 100, 620, 100), target: anchor('civic-center', 0, 30, 0) };
    case 'bryantPark': return { position: anchor('tencent-binhai', -338, 145, 123), target: anchor('tencent-binhai', 4, 124, 0) };
    case 'waterfront': return { position: anchor('talent-park', 450, 120, 550), target: anchor('chunsun', 0, 160, 0) };
    case 'drone': return { position: anchor('civic-center', Math.cos(elapsed * 0.04) * 700, 450, Math.sin(elapsed * 0.04) * 700), target: anchor('civic-center', 0, 35, 0) };
    case 'djiSkyCity': return { position: anchor('dji-sky-city', 0, 115, -310), target: anchor('dji-sky-city', -6, 110, -1) };
    case 'pingAnTower': return { position: anchor('ping-an', -634, 274, 330), target: anchor('ping-an', 0, 299, 0) };
    case 'chunsunTower': return { position: anchor('talent-park', 32, 144, 83), target: anchor('chunsun', 0, 183, 0) };
    case 'civicRoof': return { position: anchor('civic-center', 1, 152, -480), target: anchor('civic-center', 1, 33, 0) };
    case 'chunjianShell': return { position: anchor('chunjian', 97, 113.2, 563.8), target: anchor('chunjian', 11, -8.8, 63.8) };
    case 'cultureSquare': {
      const id = 'shenzhen-bay-culture-square';
      return landmarks.has(id)
        ? { position: anchor(id, 290.7, 50, 54), target: anchor(id, 1.7, 17, -1) }
        : { position: anchor('talent-park', -56.5, 55, -95.3), target: anchor('talent-park', -345.5, 22, -150.3) };
    }
    case 'conventionCenter': return { position: anchor('convention-center', -140, 224.1, -522), target: anchor('convention-center', 0, -0.9, 0) };
    case 'upperhills': return { position: anchor('upperhills', -586.4, 196.2, 70.4), target: anchor('upperhills', -1.4, 171.2, 50.4) };
    case 'nonferrousTower': return nonferrousShot();
    case 'bayBridge': return bayBridgeShot();
    default: throw new Error(`Unhandled scenic camera: ${id}`);
  }
}
