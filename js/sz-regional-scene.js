import * as THREE from 'three/webgpu';
import { buildSzMetroEntrances, createMetroStructureResources, metroEntranceCollider } from './sz-metro-entrances.js';
import { appendBayShoreFace, bayFixtureCollider, bayShoreSections,
  createBayWaterfrontResources, createBayPublicRoutes, mountBayWaterfrontBatch } from './sz-bay-waterfront.js';
import { createWaterfrontPublicRoutes, mountWaterfrontBank, mountWaterfrontBatch, waterfrontFixtureCollider } from './sz-waterfront.js';
import { buildSzDroneRoutes, droneStationColliders } from './sz-drone-routes.js';
import { createGreenwayLightMaterial, unpackFixtureRows, unpackGreenwayLightPools } from './sz-site-fixtures.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';
import { buildSzSea } from './sz-sea.js';
import { compatibleRegionalScene } from './sz-regional-format.js';
import { createRegionalStream } from './sz-regional-stream.js';

function fixtures(batch, keys) {
  for (const key of keys) {
    batch[key] = batch[key].map(([ax, ay, az, bx, by, bz, width, height]) => ({
      a: { x: ax, y: ay, z: az }, b: { x: bx, y: by, z: bz }, width, height
    }));
  }
  return batch;
}

export function createRegionalScene(scene, geo, { site, talentPark, trees, vegetation, elevatedRoads, bayPaths, waterfrontPaths }, skip) {
  const manifest = geo.regionalScene;
  const drone = compatibleRegionalScene(manifest) && !skip('drones') ? manifest.drone : { stations: [], routes: [] };
  const stations = new Map(drone.stations.map(station => [station.id, station]));
  const routes = drone.routes.map(route => ({ ...route, from: stations.get(route.fromStationId), to: stations.get(route.toStationId) }));
  const drones = buildSzDroneRoutes(scene, { air: geo.air, site, regional: { stations: drone.stations, routes },
    treeObstacles: bounds => [...trees.flightObstacles(bounds), ...vegetation.flightObstacles(bounds)] });
  const bay = new THREE.Group(), shore = new THREE.Group(), metro = new THREE.Group();
  bay.name = 'shenzhen-bay-central-waterfront';
  shore.name = 'shenzhen-waterfront-samples';
  metro.name = 'shenzhen-metro-entrances';
  scene.add(bay, shore, metro);
  let bayShared, metroShared, shoreLight;
  const entrances = new Map();
  const shoreSections = new Map();
  const walkSources = new Map(waterfrontPaths.routes.map(route => [route.id, route]));
  const bridgeHeight = createSurfaceHeightAt(elevatedRoads.surfaces);
  const stream = createRegionalStream(manifest, {
    routeSelected: () => [drones.previewRoute, drones.followedRoute],
    routeFlying: drones.isFlying,
    skip: kind => kind === 'metro' ? skip('metro')
      : (kind.startsWith('flight') || kind === 'drone-station') && skip('drones'),
    decode({ kind }, data) {
      switch (kind) {
        case 'bay':
        case 'shore': {
          const { batch } = data;
          const keys = kind === 'bay' ? ['metal', 'wood', 'light'] : ['steel', 'lamp'];
          for (const key of keys) batch[key] = unpackFixtureRows(batch[key]);
          const collider = kind === 'bay' ? bayFixtureCollider : waterfrontFixtureCollider;
          return { batch, colliders: keys.flatMap(key => batch[key].filter(row => row.colliderType)
            .map(row => collider(row, row.colliderType))) };
        }
        case 'metro': return { placed: data, colliders: data.map(metroEntranceCollider) };
        case 'drone-station': {
          const station = stations.get(data);
          if (!station?.available) throw new Error('Unknown regional drone station');
          return { station, colliders: droneStationColliders(station) };
        }
        case 'bay-walk': return { routes: createBayPublicRoutes(geo.shenzhenBay.walkRoute.map(([x, y, z]) => ({ x, y, z })), data.restSpots, bayPaths) };
        case 'shore-walk': {
          const route = walkSources.get(data.routeId), path = route?.paths[data.pathIndex];
          if (!path || path.points.length !== data.clear.length) throw new Error('Invalid waterfront path reference');
          const surfaceId = path.bridge ? `waterfront-bridge:${path.osmId}` : null;
          const points = path.points.map(([x, z]) => ({ x, z, y: surfaceId ? bridgeHeight(x, z, surfaceId) : site.heightAt(x, z) }));
          return { routes: createWaterfrontPublicRoutes([{ id: `waterfront:${route.id}:${data.pathIndex}`,
            points, clear: data.clear, surfaceId, widthM: path.widthM, mode: path.mode }], site.heightAt, elevatedRoads.surfaces,
          (x, z, radius) => site.nearObstacles(x, z, radius)) };
        }
        default: return data;
      }
    },
    mount(row, data) {
      switch (row.kind) {
        case 'metro': {
          metroShared ??= createMetroStructureResources();
          const live = buildSzMetroEntrances(metro, null, { placement: data, shared: metroShared, chunkSizeM: 500 });
          live.group.updateMatrixWorld(true);
          for (const entrance of live.entrances) entrances.set(entrance.id, entrance);
          return { update: live.update, dispose() {
            for (const entrance of live.entrances) entrances.delete(entrance.id);
            live.dispose();
          } };
        }
        case 'bay': {
          bayShared ??= createBayWaterfrontResources();
          const { batch } = data;
          batch.positions = []; batch.colors = []; batch.rockSites = [];
          for (const [index, station] of batch.shoreFaces) {
            const source = geo.shenzhenBay.shore[index];
            if (!shoreSections.has(index)) shoreSections.set(index, bayShoreSections(geo.shenzhenBay, source, site.isWater));
            appendBayShoreFace(batch, source, shoreSections.get(index), station);
          }
          unpackGreenwayLightPools(batch);
          const live = mountBayWaterfrontBatch(bay, batch, bayShared,
            build => stream.visual(build, row));
          bay.updateMatrixWorld(true);
          return live;
        }
        case 'shore': {
          // 近处才分配实例缓冲。离开细节范围就释放，保留已加载的接触数据。
          let live, desired = false;
          return { update(point) {
            const { batch } = data;
            const d = Math.hypot(point.x - batch.x, point.z - batch.z);
            desired = d < 275;
            if (live && d > 335) { live.dispose(); live = null; }
            else if (!live && desired) {
              stream.visual(() => {
                if (live || !desired) return;
                unpackGreenwayLightPools(batch);
                if (batch.poolPositions?.length) shoreLight ??= createGreenwayLightMaterial();
                live = mountWaterfrontBatch(shore, batch, shoreLight);
                shore.updateMatrixWorld(true);
              }, row);
            }
            live?.update();
          }, dispose() { live?.dispose(); } };
        }
        case 'shore-bank': {
          const source = geo.waterfront.dasha.banks[data.bankIndex];
          return mountWaterfrontBank(shore, { ...source, stations: source.stations.slice(data.start, data.start + data.count) });
        }
        case 'shore-water': {
          const live = buildSzSea(shore, { polygons: [geo.water[data.waterIndex]], heightM: data.heightM, source: data.id },
            { name: `waterfront-water:${data.id}`, coastal: false, cityReflection: false });
          live.mesh.updateMatrixWorld(true);
          return live;
        }
        case 'talent': return talentPark.mount(fixtures(data, ['steel', 'wall', 'timber', 'lamps']), data.colliders);
        case 'drone-station': return drones.mountStation(data.station);
        case 'flight': return drones.mountRoute(row.routeId, data);
        case 'flight-line': return drones.mountLine(row.routeId, data.map(([x, y, z]) => ({ x, y, z })));
        default: return { dispose() {} };
      }
    }
  });
  return { ...stream, drones,
    get statistics() { return { ...stream.statistics, sceneObjects: {
      metro: metro.children.reduce((count, group) => count + group.children.length, 0),
      waterfront: bay.children.length + shore.children.length + (talentPark.visualObjects ?? 0),
      drones: drones.group.children.length
    } }; },
    flightFailed: stream.failedRoute,
    prepareFlight(stationId) {
      const station = stations.get(stationId);
      return station?.available ? stream.prepare(station) : null;
    },
    metro: { group: metro, get entrances() { return [...entrances.values()]; },
      get statistics() { return { placed: entrances.size, ...stream.statistics }; } },
    dispose() {
      stream.dispose();
      drones.dispose();
      bayShared?.dispose();
      metroShared?.dispose();
      shoreLight?.dispose();
      for (const root of [bay, shore, metro]) root.removeFromParent();
    }
  };
}
