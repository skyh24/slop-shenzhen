export const REGIONAL_SCENE_VERSION = 1;
export const REGIONAL_SCENE_DIRECTORY = 'sz-regional';

export function compatibleRegionalScene(scene) {
  return scene?.version === REGIONAL_SCENE_VERSION && /^[a-f0-9]{64}$/.test(scene.fingerprint)
    && Array.isArray(scene.cells) && Array.isArray(scene.drone?.stations) && Array.isArray(scene.drone?.routes);
}
