import { findLandmarkArrival } from './sz-landmark-views.js';
import { parkAt } from './sz-park-arrivals.js';

export function createTeleportActions({ controllerManager, landmarkViews, parks, inBounds, isWater,
  carriagewayOccupied, findGroundArrival, roadHeight, flightStartAltitude, selectMode, onArrival, closeMap }) {
  function teleportTo(x, z, heading, options = {}) {
    if (!inBounds(x, z)) return null;
    const park = options.park ?? (controllerManager.activeMode === 'person' ? parkAt(parks, x, z) : null);
    const landmark = landmarkViews.get(options.landmarkId);
    const arrival = landmark && findLandmarkArrival(landmark, controllerManager,
      findGroundArrival, roadHeight, flightStartAltitude);
    if (landmark && !arrival) return null;
    const destination = arrival
      ? controllerManager.teleportActiveTo(arrival.x, arrival.z, arrival.heading, arrival.y, { exact: true })
      : controllerManager.teleportActiveTo(x, z, heading, null, { requireArrival: true, park, exact: options.exact === true });
    if (!destination) return null;
    onArrival(destination, options, park, landmark);
    return destination;
  }

  function teleportFromMap(x, z, heading = Math.PI, options = {}) {
    if (!inBounds(x, z)) return null;
    const landmark = landmarkViews.get(options.landmarkId);
    const park = options.park ?? parkAt(parks, x, z);
    const exactWalk = (px, pz, direction) => controllerManager.findTeleportPosition(
      px, pz, direction, 0, true, null, { exact: true, mode: 'person' });
    let destination;
    if (landmark) {
      const front = findLandmarkArrival(landmark, controllerManager,
        findGroundArrival, roadHeight, flightStartAltitude, 'person');
      if (front) destination = exactWalk(front.x, front.z, front.heading);
    } else if (park) {
      destination = controllerManager.findTeleportPosition(x, z, heading, 0, true, park, { mode: 'person' });
    } else {
      const isDry = isWater(x, z) === false;
      // 空地优先在点击位置落脚；车道或建筑内的点，改取附近可站的路缘外落点。
      if (isDry && !carriagewayOccupied(x, z, 0.58)) destination = exactWalk(x, z, heading);
      if (!destination && isDry) {
        const roadside = findGroundArrival({ x, z }, 'person', { roadside: true, radius: 80,
          isClear: point => !carriagewayOccupied(point.x, point.z, 0.58) && exactWalk(point.x, point.z, point.heading) });
        if (roadside) destination = exactWalk(roadside.x, roadside.z, roadside.heading);
      }
    }
    if (!destination || !selectMode('person', { ...destination, heading: destination.heading ?? heading })) return null;
    onArrival(destination, options, park, landmark);
    closeMap();
    return destination;
  }

  return { teleportTo, teleportFromMap };
}
