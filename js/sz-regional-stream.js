import { compatibleRegionalScene, createRegionalPackLoader } from './sz-regional-format.js';
import { spatialIndex } from './sz-spatial.js';

const SAFETY_M = 180;
const ENTER_M = 2000;
const EXIT_M = 2350;
const CONCURRENT = 4;
const DEADLINE_MS = 4;
const FLIGHT_KINDS = new Set(['flight', 'flight-line', 'drone-station']);
const corners = ([x, z, maxX, maxZ]) => [{ x, z }, { x: maxX, z: maxZ }];

function distanceTo([minX, minZ, maxX, maxZ], { x, z }) {
  return Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
}

export function createRegionalStream(manifest, { decode, mount, routeSelected, routeFlying, skip = () => false,
  request = fetch, nextFrame = run => document.hidden ? setTimeout(run, 16) : requestAnimationFrame(run), now = () => performance.now(), warn = console.warn } = {}) {
  const valid = compatibleRegionalScene(manifest);
  const packs = createRegionalPackLoader(manifest, request);
  if (!valid) warn('[regional scene] Missing or incompatible plan. Regenerate with tools/sz/build.py --rebuild-regional-scene.');
  const rows = valid ? manifest.cells.filter(row => !skip(row.kind)) : [];
  const nearby = spatialIndex(rows, row => corners(row.bounds));
  const contactRows = rows.filter(row => row.safety);
  const safety = spatialIndex(contactRows, row => corners(row.safety));
  const walkRows = rows.filter(row => row.kind.endsWith('-walk'));
  const walkIndex = spatialIndex(walkRows, row => corners(row.bounds));
  const flightRows = rows.filter(row => row.kind === 'flight');
  const active = new Map();
  const pinned = new Map();
  const failed = new Set();
  const blockers = new WeakMap();
  const jobs = [];
  const statistics = { loading: 0, bytes: {}, objects: {}, mounts: 0, releases: 0, cancelled: 0,
    maxSliceMs: 0, startup: null, failed: 0, safetyObjects: {} };
  let lastFocus = [];
  let lastFlying = '';
  let lastSelection = '';
  let pendingFrame = false;
  let disposed = false;

  function schedule() {
    if (pendingFrame || disposed || !jobs.length) return;
    pendingFrame = true;
    nextFrame(() => {
      pendingFrame = false;
      const started = now();
      // 每帧最多解析或创建两个有上限的小块。首帧之前只执行安全数据任务。
      for (let count = 0; count < 2 && jobs.length && now() - started < DEADLINE_MS; count++) jobs.shift()();
      statistics.maxSliceMs = Math.max(statistics.maxSliceMs, now() - started);
      schedule();
    });
  }

  function enqueue(task, urgent = false) {
    if (urgent) jobs.unshift(task);
    else jobs.push(task);
    schedule();
  }

  function drop(row, state) {
    active.delete(row);
    state.abort.abort();
    if (!state.ready) statistics.cancelled++;
    if (state.live) {
      state.live.dispose();
      statistics.releases++;
      statistics.objects[row.kind] -= row.count;
    }
    state.resolve(false);
  }

  function fail(row, state, error) {
    if (active.get(row) !== state) return;
    warn(`[regional scene] ${row.kind}/${row.id}: ${error.message}`);
    failed.add(row);
    statistics.failed++;
    drop(row, state);
  }

  function dispatch() {
    if (disposed) return;
    while (statistics.loading < CONCURRENT) {
      const state = [...active.values()].filter(item => item.waiting).sort((a, b) => a.priority - b.priority)[0];
      if (!state) return;
      state.waiting = false;
      const { row, abort } = state;
      statistics.loading++;
      packs.read(row).then(data => {
        if (active.get(row) !== state) return finishRequest();
        enqueue(() => {
          try {
            if (active.get(row) !== state) return;
            state.data = decode(row, data);
            statistics.bytes[row.kind] = (statistics.bytes[row.kind] ?? 0) + row.bytes;
            if (!started) statistics.safetyObjects[row.kind] =
              (statistics.safetyObjects[row.kind] ?? 0) + (state.data.colliders?.length ?? 0);
            state.ready = true;
            state.resolve(true);
            if (started) queueMount(row, state);
          } catch (error) {
            fail(row, state, error);
          } finally {
            finishRequest();
          }
        }, pinned.has(row));
      }).catch(error => {
        if (!abort.signal.aborted) fail(row, state, error);
        finishRequest();
      });
      function finishRequest() {
        statistics.loading--;
        dispatch();
      }
    }
  }

  function acquire(row, priority) {
    if (failed.has(row) || disposed) return Promise.resolve(false);
    let state = active.get(row);
    if (!state) {
      state = { row, priority, abort: new AbortController(), waiting: true, ready: false };
      state.done = new Promise(resolve => { state.resolve = resolve; });
      active.set(row, state);
    } else {
      state.priority = Math.min(priority, state.priority);
    }
    return state.done;
  }

  let started = false;
  function queueMount(row, state) {
    enqueue(() => {
      if (active.get(row) !== state || state.retained === false && !pinned.has(row)) return;
      try {
        state.live = mount(row, state.data);
        statistics.mounts++;
        statistics.objects[row.kind] = (statistics.objects[row.kind] ?? 0) + row.count;
      } catch (error) {
        warn(`[regional scene] ${row.kind}/${row.id} visual: ${error.message}`);
      }
    });
  }

  function refresh(foci, selected) {
    const wanted = new Map();
    for (const point of foci) {
      for (const row of nearby(point.x, point.z, EXIT_M)) {
        if (row.kind === 'flight-line' && !selected.has(row.routeId)) continue;
        const drone = FLIGHT_KINDS.has(row.kind);
        const radius = drone ? 850 : ENTER_M;
        const distance = distanceTo(row.bounds, point);
        if (distance > radius + (active.has(row) ? 350 : 0)) continue;
        wanted.set(row, Math.min(distance, wanted.get(row) ?? Infinity));
      }
    }
    for (const row of flightRows) {
      if (selected.has(row.routeId) || routeFlying?.(row.routeId)) wanted.set(row, -1);
    }
    for (const [row, state] of active) if (!wanted.has(row) && !pinned.has(row) && state.retained !== false) {
      state.retained = false;
      if (!state.live) drop(row, state);
      else enqueue(() => {
        if (!state.retained && active.get(row) === state && !pinned.has(row)) drop(row, state);
      });
    }
    for (const [row, distance] of wanted) {
      acquire(row, distance);
      const state = active.get(row);
      if (state) state.retained = true;
    }
    dispatch();
  }

  function prepare(point, radius = SAFETY_M, includeRoutes = false) {
    const pending = [...safety(point.x, point.z, radius)].filter(row => distanceTo(row.safety, point) <= radius);
    if (includeRoutes) {
      for (const row of walkIndex(point.x, point.z, radius)) {
        if (distanceTo(row.bounds, point) <= radius) pending.push(row);
      }
    }
    if (pending.every(row => active.get(row)?.ready || failed.has(row))) return null;
    for (const row of pending) pinned.set(row, (pinned.get(row) ?? 0) + 1);
    const work = pending.map(row => acquire(row, -2));
    dispatch();
    return Promise.all(work).then(() => {
      // 保持目标安全块到调用方提交位置后的下一帧。
      nextFrame(() => {
        if (disposed) return;
        for (const row of pending) {
          const count = pinned.get(row) - 1;
          if (count > 0) pinned.set(row, count);
          else pinned.delete(row);
        }
        lastFocus = [];
      });
    });
  }

  function colliders(x, z, radius, includePending = true) {
    const output = [];
    for (const row of safety(x, z, radius)) {
      if (distanceTo(row.safety, { x, z }) > radius) continue;
      const state = active.get(row);
      if (state?.ready) {
        for (const c of state.data.colliders ?? []) {
          if (c.minX <= x + radius && c.maxX >= x - radius && c.minZ <= z + radius && c.maxZ >= z - radius) output.push(c);
        }
      } else if (includePending && !failed.has(row)) {
        // 快速前往或网络延迟时，未就绪的实体范围先按保守包络参与碰撞。
        const [minX, minZ, maxX, maxZ] = row.safety;
        const [minY, maxY] = row.safetyY ?? [-100, 80];
        if (!blockers.has(row)) blockers.set(row, { type: 'regional-pending', minX, minZ, maxX, maxZ, minY, maxY });
        output.push(blockers.get(row));
      }
    }
    return output;
  }

  return { statistics, prepare, colliders,
    failedRoute: routeId => flightRows.some(row => row.routeId === routeId && failed.has(row)),
    visual(build, row) {
      const state = active.get(row);
      if (!state || state.visualPending) return;
      state.visualPending = true;
      enqueue(() => {
        state.visualPending = false;
        if (active.get(row) === state && state.retained) build();
      });
    },
    start() {
      statistics.startup = { bytes: { ...statistics.bytes }, objects: { ...statistics.objects },
        safetyObjects: { ...statistics.safetyObjects } };
      started = true;
      for (const [row, state] of active) if (state.ready) queueMount(row, state);
    },
    update(...foci) {
      if (!started || disposed) return;
      const selected = new Set(routeSelected?.().filter(Boolean) ?? []);
      const key = [...selected].join(',');
      const flying = flightRows.filter(row => routeFlying?.(row.routeId)).map(row => row.routeId).join(',');
      if (flying !== lastFlying || key !== lastSelection || foci.length !== lastFocus.length
        || foci.some((point, i) => Math.hypot(point.x - lastFocus[i].x, point.z - lastFocus[i].z) > 65)) {
        lastSelection = key;
        lastFlying = flying;
        lastFocus = foci.map(({ x, z }) => ({ x, z }));
        refresh(lastFocus, selected);
      }
      for (const state of active.values()) if (state.retained) state.live?.update?.(foci.at(-1));
    },
    routes(x, z, radius) {
      return [...walkIndex(x, z, radius)].flatMap(row => active.get(row)?.data?.routes ?? []);
    },
    dispose() {
      packs.dispose();
      disposed = true;
      for (const [row, state] of active) drop(row, state);
      jobs.length = 0;
      pinned.clear();
    }
  };
}
