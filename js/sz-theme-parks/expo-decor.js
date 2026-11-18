import { Group } from 'three/webgpu';
import { createDetailResidency } from '../sz-detail-residency.js';

export function createExpoDecor(parent) {
  const units = [], queue = [];
  const statistics = { active: 0, builds: 0, maxBuildMs: 0 };
  let lastX, lastZ;
  function add(bounds, populate) {
    const residency = createDetailResidency({ enterM: 550, exitM: 720, schedule: task => queue.push(task) });
    const build = () => {
      const started = performance.now();
      const group = new Group();
      populate(group);
      parent.add(group);
      group.updateMatrixWorld(true);
      statistics.active++;
      statistics.builds++;
      statistics.maxBuildMs = Math.max(statistics.maxBuildMs, performance.now() - started);
      return { dispose() {
        group.removeFromParent();
        group.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
        statistics.active--;
      } };
    };
    units.push({ bounds, residency, build });
  }
  return { add, statistics,
    update({ x, z }) {
      if (x !== lastX || z !== lastZ) {
        lastX = x; lastZ = z;
        for (const { bounds, residency, build } of units) {
          const dx = Math.max(0, bounds.minX - x, x - bounds.maxX);
          const dz = Math.max(0, bounds.minZ - z, z - bounds.maxZ);
          residency.update(Math.hypot(dx, dz), build);
        }
      }
      queue.shift()?.();
    },
    dispose() {
      for (const { residency } of units) residency.dispose();
      units.length = queue.length = 0;
    }
  };
}
