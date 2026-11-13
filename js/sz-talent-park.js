import { compatibleRegionalScene } from './sz-regional-format.js';
import { STR } from './sz-strings.js';
import { buildTalentWaterfront, createTalentWaterfrontAccess, planTalentWaterfront } from './sz-talent-waterfront.js';
import { createTalentPedestrians } from './sz-talent-pedestrians.js';
import { createTalentDroneShow } from './sz-talent-drone-show.js';

export function prepareTalentPark(scene, geo, site, { offline, nearObstacles, elevatedSurfaces }) {
  const source = geo.talentPark;
  const lake = geo.water[source?.lakeWaterIndex];
  const plan = offline && source && lake ? planTalentWaterfront(source, site, nearObstacles, elevatedSurfaces) : null;
  const support = plan || (compatibleRegionalScene(geo.regionalScene) && geo.regionalScene.talent);
  const waterfront = support && createTalentWaterfrontAccess(source, support.surfaces, support.pilotTrees, elevatedSurfaces);
  let live = null;
  let program = null;
  const show = { entryIds: ['btn-talent-show', 'tp-talent-show'], available: Boolean(waterfront && lake),
    get program() {
      if (!program && waterfront && lake) program = createTalentDroneShow(scene, {
        airspace: waterfront.airspace, lake, colliders: nearObstacles(waterfront.airspace.x, waterfront.airspace.z, 500),
        lakeHeight: source.simulation.lakeHeightM
      });
      return program;
    },
    labels: STR.talentShow, arrival: waterfront?.arrival, pitch: -0.61, range: 115 };

  return { waterfront, plan, show,
    get people() { return live?.people; },
    get statistics() { return live?.visuals.statistics; },
    get visualObjects() { return live ? live.visuals.group.children.length + live.people.group.children.length : 0; },
    get program() { return program; },
    mount(chunk, colliders) {
      const visuals = buildTalentWaterfront(scene, source, lake, site, { ...chunk, ...support, colliders }, elevatedSurfaces);
      visuals.group.updateMatrixWorld(true);
      const { minX, maxX, minZ, maxZ } = waterfront.extent;
      const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + 30;
      const near = nearObstacles((minX + maxX) / 2, (minZ + maxZ) / 2, radius);
      const people = createTalentPedestrians(scene, waterfront, near);
      people.group.updateMatrixWorld(true);
      live = { people, visuals };
      return { dispose() {
        live = null;
        people.dispose();
        visuals.dispose();
      } };
    },
    update(dt, focus, camera, visible) {
      live?.people.update(dt, focus, camera, visible, program?.active && program.cue < 8);
    },
    nearColliders(x, z, radius) { return live?.people.nearColliders(x, z, radius) ?? []; }
  };
}
