import { baseAt, footprintParts, loftPart } from './parts.js';
import { approach, ellipse, frameAt, rect, volume } from './model-profile.js';

// 父轮廓只用于身份；当前快照已由塔身、两组圆冠与裙房代表其实体。
const SHAFT = 'way/279950100';
const CROWNS = ['relation/10722606', 'relation/10722604'];
const TURRETS = ['relation/10722607', 'relation/10722605'];
const PODIUM = 'way/773700361';
const ENTRY_WING = 'way/1145586647';
export const sourceIds = [SHAFT, ...CROWNS, ...TURRETS, PODIUM, ENTRY_WING];
export const optionalSkipIds = ['way/64601041'];

export function build(sources, terrain) {
  const shaft = sources.get(SHAFT);
  const podium = sources.get(PODIUM);
  const wing = sources.get(ENTRY_WING);
  const crowns = CROWNS.map(id => sources.get(id));
  const turrets = TURRETS.map(id => sources.get(id));
  const base = baseAt(shaft, terrain);
  const centers = crowns.map(({ cx: x, cz: z }) => ({ x, z }));
  const at = frameAt({ x: shaft.cx, z: shaft.cz }, ...centers);
  const plaza = baseAt(podium, terrain);
  const parts = [
    ...footprintParts(shaft, base, 'diwangShaft', { id: 'diwang:shaft', min: -0.4, heightSource: shaft.heightSource }),
    ...footprintParts(podium, plaza, 'diwangPodium', { id: 'diwang:podium', min: -0.35 }),
    ...footprintParts(wing, plaza, 'diwangPodium', { id: 'diwang:entrance-wing', min: -0.35, baseSourceId: podium.id })
  ];
  for (const [i, crown] of crowns.entries()) {
    const turret = turrets[i];
    const ringAt = (rx, rz) => ellipse((u, v) => ({ x: turret.cx + u, z: turret.cz + v }), 0, 0, rx, rz, 12);
    // 圆翼由源高和源足迹限定；照片中可见顶部两次退台，尖杆只占细截面。
    parts.push(...footprintParts(crown, base, 'diwangGlass', { id: `diwang:wing:${i}`, min: -0.4, baseSourceId: shaft.id }));
    parts.push(...footprintParts(turret, base, 'diwangGlass', { id: `diwang:turret:${i}`, min: crown.height,
      baseSourceId: shaft.id }));
    parts.push(loftPart(`diwang:spire:${i}`, turret, ringAt(0.84, 0.84), ringAt(0.11, 0.11),
      base + turret.height, base + 384, 'landmarkEdge', { heightSource: 'published', baseSourceId: shaft.id }));
  }
  for (const side of [-1, 1]) {
    parts.push(volume(`diwang:crown-band:${side}`, shaft, rect(at, 0, side * 12.2, 27, 1.15),
      base + 290, base + 304, 'diwangPodium'));
  }
  return parts;
}

export function approaches(sources) {
  const wing = sources.get(ENTRY_WING);
  return [approach({ x: wing.cx, z: wing.maxZ }, { x: wing.cx - 4, z: wing.maxZ + 19 }, 4.2)];
}
