import { STR } from './sz-strings.js';
import { buildTalentWaterfront } from './sz-talent-waterfront.js';
import { createTalentPedestrians } from './sz-talent-pedestrians.js';
import { createTalentDroneShow } from './sz-talent-drone-show.js';

export function prepareTalentPark(qa, scene, geo, site) {
  const source = geo.talentPark;
  const lake = geo.water[source?.lakeWaterIndex];
  const waterfront = qa.measureBuild('talent-waterfront', () => buildTalentWaterfront(scene, source, lake, site));
  function connect(colliders) {
    const people = createTalentPedestrians(scene, waterfront, colliders);
    const program = waterfront && qa.measureBuild('talent-program', () => createTalentDroneShow(scene, {
      airspace: waterfront.airspace, lake, colliders, lakeHeight: source.simulation.lakeHeightM
    }));
    const show = { entryIds: ['btn-talent-show', 'tp-talent-show'], program, labels: STR.talentShow,
      arrival: waterfront?.arrival, pitch: -0.61, range: 115 };
    return { people, program, show,
      update(dt, focus, camera, visible) {
        people?.update(dt, focus, camera, visible, program.active && program.cue < 8);
      }
    };
  }
  return { waterfront, connect };
}
