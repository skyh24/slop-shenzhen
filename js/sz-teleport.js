import { findLandmarkArrival } from './sz-landmark-views.js';
import { parkAt } from './sz-park-arrivals.js';
import { polygonContainsInclusive } from './sz-polygon.js';

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

  function stationArrival(x, z, { entrances = [], exterior = [] }, exactWalk) {
    const anchors = [...entrances].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const stand = (px, pz, target) => {
      if (isWater(px, pz) !== false || carriagewayOccupied(px, pz, 0.58)
        || exterior.some(polygon => [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]
          .some(([dx, dz]) => polygonContainsInclusive(polygon, px + dx, pz + dz)))) return null;
      return exactWalk(px, pz, Math.atan2(target.x - px, target.z - pz));
    };
    // 福田优先找已建地面亭旁的落点；其余站点用站体或围挡外的路缘。
    for (const entrance of anchors) {
      for (const distance of [5, 8, 12, 18]) {
        for (let i = 0; i < 8; i++) {
          const angle = (entrance.yaw ?? 0) + Math.PI * i / 4;
          const point = stand(entrance.x + distance * Math.sin(angle), entrance.z + distance * Math.cos(angle), entrance);
          if (point) return point;
        }
      }
    }
    const target = { x, z };
    const radius = exterior.reduce((reach, polygon) => polygon.outer.reduce(
      (max, vertex) => Math.max(max, Math.hypot(vertex.x - x, vertex.z - z) + 80), reach), 220);
    const arrival = findGroundArrival(target, 'person', { roadside: true, radius: Math.min(radius, 1000),
      isClear: point => stand(point.x, point.z, target) });
    return arrival ? stand(arrival.x, arrival.z, target) : null;
  }

  function teleportFromMap(x, z, heading = Math.PI, options = {}) {
    if (!inBounds(x, z)) return null;
    const landmark = landmarkViews.get(options.landmarkId);
    const park = options.stationVisit ? null : options.park ?? parkAt(parks, x, z);
    const exactWalk = (px, pz, direction) => controllerManager.findTeleportPosition(
      px, pz, direction, 0, true, null, { exact: true, mode: 'person' });
    let destination;
    if (options.stationVisit) {
      destination = stationArrival(x, z, options.stationVisit, exactWalk);
    } else if (landmark) {
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
