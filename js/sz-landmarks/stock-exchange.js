import { baseAt, footprintParts } from './parts.js';
import { approach } from './model-profile.js';

export const sourceIds = ['relation/12502052', 'relation/12502051', 'way/529086136', 'way/776182829'];
export const optionalSkipIds = ['way/923157986'];

export function build(sources, terrain) {
  const [core, podium, tower] = sourceIds.map(id => sources.get(id));
  const base = baseAt(core, terrain);
  // OMA 照片中的西侧是地面广场，沿用现有地表，避免把底板推高成挡路的一层实墙。
  return [
    ...footprintParts(core, base, 'stockExchangeLobby', { id: 'stock-exchange:core', min: -0.45, max: podium.minHeight,
      heightSource: podium.heightSource, topFace: false }),
    ...footprintParts(podium, base, 'stockExchangePodium', { id: 'stock-exchange:raised-podium', baseSourceId: core.id }),
    ...footprintParts(tower, base, 'stockExchangeTower', { id: 'stock-exchange:tower', baseSourceId: core.id, bottomFace: false })
  ];
}

export function approaches(sources) {
  const core = sources.get(sourceIds[0]);
  const podium = sources.get(sourceIds[1]);
  return [approach({ x: core.cx, z: core.maxZ }, { x: core.cx, z: podium.maxZ + 15 }, 6)];
}
