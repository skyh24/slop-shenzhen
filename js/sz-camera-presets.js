import { GEO } from './sz-geodata.js';
import { terrainHeight } from './sz-terrain.js';

const landmarks = new Map(GEO.landmarks.map(l => [l.id, l]));

function anchor(id, dx = 0, dy = 0, dz = 0) {
  const landmark = landmarks.get(id);
  if (!landmark) throw new Error(`Unknown scenic landmark: ${id}`);
  const base = terrainHeight(GEO.terrain, landmark.x, landmark.z);
  if (base === null) throw new Error(`Missing scenic terrain: ${id}`);
  return [landmark.x + dx, base + dy, landmark.z + dz];
}

// 机位偏移是取景设计，不代表实测观景台位置或真实运营航线。
export function getScenicCamera(id, elapsed = 0) {
  switch (id) {
    case 'centralPark': return { position: anchor('lianhuashan', 0, 20, 0), target: anchor('civic-center', 0, 30, 0) };
    case 'fifthAve': return { position: anchor('shenzhen-bay-park', 0, 60, 100), target: anchor('chunsun', 0, 160, 0) };
    case 'timesSquare': return { position: anchor('civic-center', 0, 12, 140), target: anchor('lianhuashan', 0, 35, 0) };
    case 'chryslerGCT': return { position: anchor('talent-park', 80, 15, 0), target: anchor('chunsun', 0, 180, 0) };
    case 'observatory': return { position: anchor('ping-an', 100, 620, 100), target: anchor('civic-center', 0, 30, 0) };
    case 'bryantPark': return { position: anchor('tencent-binhai', 200, 90, 250), target: anchor('tencent-binhai', 0, 120, 0) };
    case 'waterfront': return { position: anchor('talent-park', 450, 120, 550), target: anchor('chunsun', 0, 160, 0) };
    case 'drone': return { position: anchor('civic-center', Math.cos(elapsed * 0.04) * 700, 450, Math.sin(elapsed * 0.04) * 700), target: anchor('civic-center', 0, 35, 0) };
    default: throw new Error(`Unhandled scenic camera: ${id}`);
  }
}
