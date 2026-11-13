const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const { createRoadPolygonLayout } = require('./helpers/roads.cjs');
const root = join(__dirname, '..');
const modulePromise = import(`data:text/javascript;base64,${readFileSync(join(root, 'js/sz-data-format.js')).toString('base64')}`);
const bytes = readFileSync(join(root, 'js/sz-city.json.gz'));
const raw = JSON.parse(gunzipSync(bytes));

test('shared city loader accepts gzip and server-inflated data and rejects HTTP failures', async () => {
  const { readCityPayload } = await modulePromise;
  for (const body of [bytes, gunzipSync(bytes)]) {
    const result = await readCityPayload('fixture', async () => new Response(body));
    assert.equal(result.buildings.id.length, raw.buildings.h.length);
    assert.equal(result.origin[0], 114.0545);
  }
  await assert.rejects(() => readCityPayload('fixture', async () => new Response('', { status: 404 })), /404/);
  await assert.rejects(() => readCityPayload('fixture', async () => new Response(bytes.subarray(0, 80))));
});

test('runtime adapter preserves every building source, footprint, hole and vertical part', async () => {
  const { decodeCityPayload, decodePoly } = await modulePromise;
  const { buildings, geo } = decodeCityPayload(raw);
  assert.equal(buildings.length, raw.buildings.h.length);
  // 误识别过滤（docs/02-DATA-PIPELINE.md 第 4 节 + docs/21）会移除落在广场/绿地/车行道/水面/孤立小棚的补充轮廓，
  // 总数从约 39.9k 下降；这里只保留数量级保护，不锁定具体数量。
  assert.ok(buildings.length > 33000);
  let holes = 0, raisedParts = 0;
  buildings.forEach((building, i) => {
    assert.equal(building.id, raw.buildings.id[i]);
    assert.equal(building.heightSource, raw.enums.heightSource[raw.buildings.src[i]]);
    assert.equal(building.height, raw.buildings.h[i]);
    assert.equal(building.minHeight, raw.buildings.minH[i]);
    const rings = decodePoly(raw.buildings.rings[i]);
    const decoded = [building.polygons[0].outer, ...building.polygons[0].holes];
    assert.equal(decoded.length, rings.length);
    decoded.forEach((ring, j) => assert.deepEqual(ring.flatMap(p => [p.x, p.z]), Array.from(rings[j])));
    holes += building.polygons[0].holes.length;
    raisedParts += building.minHeight > 0;
  });
  assert.ok(holes > 0, 'courtyards remain open');
  assert.ok(raisedParts > 0, 'elevated parts retain their lower height');
  assert.equal(geo.roadGraph, raw.roadGraph);
  assert.equal(geo.terrain, raw.terrain);
  assert.equal(geo.frame.bearingDeg, 0);
});

test('city data rejects source loss, invalid topology and incompatible terrain before scene creation', async () => {
  const { validateCityPayload } = await modulePromise;
  const badOrigin = { ...raw, origin: [0, 0] };
  assert.throws(() => validateCityPayload(badOrigin), /origin/);
  assert.throws(() => validateCityPayload({ ...raw, version: 3 }), /version/);
  assert.throws(() => validateCityPayload({ ...raw, landmarks: [...raw.landmarks, raw.landmarks[0]] }),
    /landmark identity/);
  const graph = raw.roadGraph;
  assert.throws(() => validateCityPayload({ ...raw, roadGraph: { ...graph,
    links: [...graph.links, graph.links[0]], metadata: [...graph.metadata, graph.metadata[0]] } }), /road edge identity/);
  assert.throws(() => validateCityPayload({ ...raw, buildings: { ...raw.buildings, id: [] } }), /buildings.id/);
  const badGraph = { ...raw.roadGraph, links: [[-1, 0, 0, 7, 1, 0, []]], metadata: [{}] };
  assert.throws(() => validateCityPayload({ ...raw, roadGraph: badGraph }), /graph link/);
  assert.throws(() => validateCityPayload({ ...raw, terrain: { ...raw.terrain, diagonal: 'nw-se' } }), /terrain grid/);
  const ramp = raw.roadFrontage.features.find(feature => feature.id === 'shennan-hongshulin:ramp');
  assert.ok(ramp);
  for (const feature of [{ ...ramp, vertexRisesM: [0] }, { ...ramp, clipToRoadComplement: false }]) {
    assert.throws(() => validateCityPayload({ ...raw, roadFrontage: { ...raw.roadFrontage, features: [feature] } }),
      /road frontage clipped surface/);
  }
});

test('golf course paving shares sloped ground and keeps private paths out of the car network', async () => {
  const { decodeCityPayload } = await modulePromise;
  const { buildings, geo } = decodeCityPayload(raw);
  const site = geo.golfCourse;
  const pathIds = new Set(site.paths.map(path => path.osmId));
  assert.equal(site.publicAccess, 'unverified');
  assert.ok(site.paths.every(path => path.kind === 'garden-path' && path.publicAccess !== 'public'));
  assert.ok(geo.roadGraph.metadata.every(meta => !pathIds.has(meta.osmId)));
  assert.ok(geo.roadGraph.metadata.some(meta => meta.osmId === 'way/25423077' && meta.highway === 'trunk'));
  const bridge = site.paths.find(path => path.osmId === 'way/1057168056');
  assert.equal(bridge.heightSource, 'unresolved-structure');
  assert.ok(site.surfaces.every(surface => !surface.sourceIds.includes(bridge.osmId)));

  const read = name => readFileSync(join(root, 'js', name), 'utf8');
  const { createGroundSurfaceSampler } = loadModule(read('sz-ground-surface.js'));
  const ground = createGroundSurfaceSampler(geo.terrainSurface);
  const paving = createRoadPolygonLayout(site.surfaces.find(surface => surface.material === 'paved'), geo.terrainSurface);
  let low = Infinity, high = -Infinity;
  for (const { positions, origin } of paving.chunks) {
    for (let i = 0; i < positions.length; i += 9) {
      const x = origin[0] + (positions[i] + positions[i + 3] + positions[i + 6]) / 3;
      const y = (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3;
      const z = origin[1] + (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3;
      assert.ok(Number.isFinite(ground(x, z)) && Math.abs(ground(x, z) - y) < 0.001);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
  }
  assert.ok(high - low > 1);
  const terrain = loadModule(read('sz-terrain.js'));
  for (const { banks, heightM } of site.ponds) {
    for (const bank of banks) for (let i = 0; i < bank.length; i += 3) {
      const [x, y, z] = bank.slice(i, i + 3);
      assert.ok(y >= heightM && Math.abs(terrain.terrainHeight(geo.terrain, x, z) - y) < 0.001);
    }
  }
  const { buildingPlacement } = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
  const onSlope = buildings.find(building => building.foundation);
  const placement = buildingPlacement(onSlope, geo.terrain);
  assert.equal(placement.colliders[0].minY, onSlope.foundation.bottomY);
  assert.equal(placement.maxY, Math.fround(placement.baseY + onSlope.height));
});

test('coordinate decoder rejects truncated or fractional delta streams', async () => {
  const { decodeRing } = await modulePromise;
  assert.throws(() => decodeRing([1, 2, 3]), /coordinate sequence/);
  assert.throws(() => decodeRing([0, 0, 0.5, 3]), /coordinate delta/);
});

test('landmark sites decode verified OSM site polygons for model placement', async () => {
  const { decodeCityPayload } = await modulePromise;
  const { geo } = decodeCityPayload(raw);
  assert.ok(raw.sites && raw.sites.version === 1 && raw.sites.source === 'osm-guangdong');
  assert.ok(geo.sites && Object.keys(geo.sites).length >= 15);
  for (const [landmarkId, roles] of Object.entries(geo.sites)) {
    assert.equal(typeof landmarkId, 'string');
    for (const [role, site] of Object.entries(roles)) {
      assert.match(site.osmId, /^(?:way|relation)\/\d+$/);
      assert.ok(site.polygons.length > 0);
      for (const polygon of site.polygons) {
        assert.ok(polygon.outer.length >= 3);
        for (const point of polygon.outer) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z));
      }
      assert.ok(role.length > 0);
    }
  }
  const expected = {
    'super-hq': ['site', 'cmbTower', 'exhibitionHall', 'metroStation'],
    'iec-xiangmihu': ['site', 'lake', 'lakePark'],
    'xili-station': ['site'],
    'futian-station': ['station']
  };
  for (const [landmarkId, roles] of Object.entries(expected)) {
    for (const role of roles) assert.ok(geo.sites[landmarkId]?.[role], `${landmarkId}.${role} decoded`);
  }
});

test('air routes decode only source-endpoint schematic drone tracks', async () => {
  const { decodeCityPayload } = await modulePromise;
  const rawAir = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { geo } = decodeCityPayload(rawAir);
  assert.ok(rawAir.air && rawAir.air.version >= 3);
  assert.equal(geo.air.droneStations.length, 4);
  assert.equal(geo.air.droneRoutes.length, 2);
  for (const station of geo.air.droneStations) {
    assert.ok(Number.isFinite(station.x) && Number.isFinite(station.z));
    assert.ok(station.sourceUrls.length > 0);
    assert.match(station.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
  for (const route of geo.air.droneRoutes) {
    assert.equal(route.trackStatus, 'schematic');
    assert.equal(route.altitudeSource, 'estimate');
    assert.ok(route.lengthM > 1000);
    assert.ok(geo.air.droneStations.some(station => station.id === route.fromStationId));
    assert.ok(geo.air.droneStations.some(station => station.id === route.toStationId));
  }
  assert.ok(geo.air.apecSuspension.windows.length >= 2);
  // 把示意航迹写成实测、或删掉来源，都必须被校验拒绝。
  const measured = JSON.parse(JSON.stringify(rawAir));
  measured.air.droneRoutes[0].trackStatus = 'measured';
  assert.throws(() => decodeCityPayload(measured), /air drone route/);
  const unsourced = JSON.parse(JSON.stringify(rawAir));
  unsourced.air.droneStations[0].sourceUrls = [];
  assert.throws(() => decodeCityPayload(unsourced), /air drone station/);
});

test('building names and levels survive decoding and invalid indices are rejected', async () => {
  const { decodeCityPayload, validateCityPayload } = await modulePromise;
  const { buildings } = decodeCityPayload(raw);
  assert.ok(Array.isArray(raw.names) && raw.names.length > 0, 'shared payload carries a name table');
  assert.equal(raw.buildings.name.length, raw.buildings.h.length);
  assert.equal(raw.buildings.lv.length, raw.buildings.h.length);
  let named = 0;
  buildings.forEach((building, i) => {
    assert.equal(building.name, raw.buildings.name[i] >= 0 ? raw.names[raw.buildings.name[i]] : null);
    assert.equal(building.levels, raw.buildings.lv[i]);
    assert.ok(Number.isInteger(building.levels) && building.levels >= -1);
    if (building.name) named++;
  });
  assert.ok(named > 1000, 'ordinary buildings keep their source names');
  const brokenName = { ...raw, buildings: { ...raw.buildings, name: raw.buildings.name.slice() } };
  brokenName.buildings.name[0] = raw.names.length;
  assert.throws(() => validateCityPayload(brokenName), /building name index/);
  const missingTable = { ...raw, names: undefined, buildings: { ...raw.buildings, name: raw.buildings.name.slice() } };
  missingTable.buildings.name[0] = 0;
  assert.throws(() => validateCityPayload(missingTable), /building name index/);
});

test('city data failures carry the stage code the boot fallback maps to its messages', async () => {
  const { CityDataError } = await modulePromise;
  const error = new CityDataError('request', 'City data request failed: 404');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CityDataError');
  assert.equal(error.code, 'request');
  assert.equal(error.message, 'City data request failed: 404');
});

test('readCityPayload only downloads, decompresses and parses; failures keep a stage code', async () => {
  const { readCityPayload, CityDataError } = await modulePromise;
  const metrics = {};
  const unvalidated = { ...raw, version: 3 };
  const loaded = await readCityPayload('fixture', async () => new Response(JSON.stringify(unvalidated)), metrics);
  assert.equal(loaded.version, 3, 'read must not reject data that only validation rejects');
  for (const key of ['downloadMs', 'decompressMs', 'parseMs']) {
    assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0, `metrics.${key} is a finite duration`);
  }
  const failureOf = async (fetcher) => {
    try {
      await readCityPayload('fixture', fetcher);
    } catch (error) {
      return error;
    }
    assert.fail('readCityPayload should reject the injected failure');
  };
  const requestFailure = await failureOf(async () => new Response('', { status: 404 }));
  assert.ok(requestFailure instanceof CityDataError);
  assert.equal(requestFailure.code, 'request');
  assert.match(requestFailure.message, /404/);
  const gzipFailure = await failureOf(async () => new Response(new Uint8Array([0x1f, 0x8b, 0xde, 0xad, 0xbe, 0xef])));
  assert.ok(gzipFailure instanceof CityDataError);
  assert.equal(gzipFailure.code, 'decompress');
  const utf8Failure = await failureOf(async () => new Response(new Uint8Array([0xff, 0xfe, 0xfd])));
  assert.equal(utf8Failure.code, 'decompress');
  const parseFailure = await failureOf(async () => new Response('not json'));
  assert.equal(parseFailure.code, 'invalid');
});

test('decodeCityPayload validates once, preserves the source message and records timings', async () => {
  const { decodeCityPayload, validateCityPayload, CityDataError } = await modulePromise;
  const metrics = {};
  const { buildings, geo } = decodeCityPayload(raw, metrics);
  assert.equal(buildings.length, raw.buildings.h.length);
  assert.equal(geo.version, raw.version);
  for (const key of ['validateMs', 'decodeMs']) {
    assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0, `metrics.${key} is a finite duration`);
  }
  const failureOf = (payload) => {
    try {
      decodeCityPayload(payload);
    } catch (error) {
      return error;
    }
    assert.fail('decodeCityPayload should reject invalid data');
  };
  const versionFailure = failureOf({ ...raw, version: 3 });
  assert.ok(versionFailure instanceof CityDataError, 'validation failures use the startup error type');
  assert.equal(versionFailure.code, 'invalid');
  assert.match(versionFailure.message, /version/, 'the original validation message is preserved');
  const parkFailure = failureOf({ ...raw, parks: [{ ...raw.parks[0], source: '' }] });
  assert.equal(parkFailure.code, 'invalid');
  assert.match(parkFailure.message, /park source/);
  // validateCityPayload 本身的行为不变：仍是普通 Error，message 不变。
  let plainFailure;
  try {
    validateCityPayload({ ...raw, version: 3 });
  } catch (error) {
    plainFailure = error;
  }
  assert.ok(plainFailure instanceof Error);
  assert.ok(!(plainFailure instanceof CityDataError), 'validateCityPayload keeps throwing plain Error');
  assert.match(plainFailure.message, /version/);
});

test('the city payload is validated at exactly one call site', () => {
  const source = readFileSync(join(root, 'js/sz-data-format.js'), 'utf8');
  const calls = [...source.matchAll(/(?<!function\s)validateCityPayload\(raw\)/g)];
  assert.equal(calls.length, 1, 'validateCityPayload(raw) runs exactly once, in decodeCityPayload');
  const decodeStart = source.indexOf('function decodeCityPayload');
  assert.ok(decodeStart >= 0, 'decodeCityPayload is exported');
  assert.ok(calls[0].index > decodeStart,
    'the single validation call belongs to decodeCityPayload, not readCityPayload');
});

test('expanded districts expose searchable sites and the sourced western bridge segments', async () => {
  const { decodeCityPayload, validateCityPayload } = await modulePromise;
  const { geo } = decodeCityPayload(raw);
  const { polygonContainsInclusive } = await import(
    `data:text/javascript;base64,${readFileSync(join(root, 'js/sz-polygon.js')).toString('base64')}`);
  for (const id of ['huangbeiling', 'shenzhen-north', 'oh-bay', 'taizi-bay']) {
    const place = geo.landmarks.find(item => item.id === id && item.phase === 1);
    assert.ok(place, id);
    assert.ok(geo.coverage.some(poly => polygonContainsInclusive(poly, place.x, place.z)), id);
    assert.ok(geo.land.some(poly => polygonContainsInclusive(poly, place.x, place.z)), id);
  }
  assert.equal(geo.sites['shenzhen-north'].station.osmId, 'way/1212433645');
  assert.equal(geo.sites['oh-bay'].site.osmId, 'way/771513760');
  assert.equal(geo.sites['taizi-bay'].terminal.osmId, 'relation/12528133');
  assert.ok(geo.metro.stations.some(station => station.name === '黄贝岭' && station.lineRefs.includes('5')));
  assert.ok(geo.metro.stations.some(station => station.name === '深圳北站' && station.lineRefs.includes('4')));
  assert.ok(geo.metro.stations.some(station => station.name === '太子湾' && station.lineRefs.includes('12')));
  for (const [x, z] of [[1491.5, 3798.3], [-1285.8, 6234.5], [7457.5, 2690.9]]) {
    assert.ok(!geo.coverage.some(poly => polygonContainsInclusive(poly, x, z)));
    assert.ok(!geo.land.some(poly => polygonContainsInclusive(poly, x, z)));
  }
  const expressway = geo.yanjiangExpressway;
  assert.equal(expressway.source.osmRelationId, 6371344);
  assert.equal(expressway.source.heightSource, 'estimate');
  assert.ok(expressway.segments.some(segment => segment.osmWayId === 311100020));
  assert.ok(expressway.segments.some(segment => segment.osmWayId === 596950400));
  assert.ok(expressway.segments.reduce((sum, segment) => sum + segment.stations.at(-1).stationM, 0) > 15000);
  assert.throws(() => validateCityPayload({ ...raw, yanjiangExpressway: { ...expressway, segments: [null] } }),
    /Yanjiang bridge segment/);
});

test('north-east coverage and six map landmarks use the sourced positions and labels', async () => {
  const { decodeCityPayload, validateCityPayload } = await modulePromise;
  const { geo } = decodeCityPayload(raw);
  const { polygonContainsInclusive } = await import(
    `data:text/javascript;base64,${readFileSync(join(root, 'js/sz-polygon.js')).toString('base64')}`);
  for (const [x, z] of [[874.3, -7496.9], [2108.7, -4839.2], [3343, -8272.1]]) {
    assert.ok(geo.coverage.some(poly => polygonContainsInclusive(poly, x, z)));
    assert.ok(geo.land.some(poly => polygonContainsInclusive(poly, x, z)));
  }
  assert.ok(!geo.coverage.some(poly => polygonContainsInclusive(poly, 4783.1, -7054)));
  const landmarks = new Map(geo.landmarks.map(place => [place.id, place]));
  for (const [id, name] of [
    ['oct-loft', '华侨城'], ['sea-world', '海上世界'], ['tencent-towers', '腾讯大厦'],
    ['nantou-ancient-city', '南头古城'], ['kk100', '京基100'], ['dongmen', '东门']
  ]) {
    const place = landmarks.get(id);
    assert.equal(place.phase, 1, id);
    assert.equal(place.short ?? place.name, name);
    assert.equal(place.mapPriority, true);
    assert.ok(geo.land.some(poly => polygonContainsInclusive(poly, place.x, place.z)), id);
  }
  assert.ok(landmarks.get('kk100').aliases.includes('京基一百'));
  assert.notEqual(landmarks.get('tencent-towers').z, landmarks.get('tencent-binhai').z);
  assert.equal(geo.sites['tencent-towers'].building.osmId, 'way/600815118');
  assert.equal(geo.sites['nantou-ancient-city'].site.osmId, 'way/219961346');
  assert.throws(() => validateCityPayload({ ...raw, landmarks: [{ ...raw.landmarks[0], aliases: 1 }] }),
    /landmark map labels/);
});
