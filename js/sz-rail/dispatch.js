// 演示调度。车站路径里程从进入端量到退出端，车头的里程是整列车的基准。
export const TRAIN = Object.freeze({ cars: 8, spacing: 25, carLength: 24.45, width: 3.25,
  length: 7 * 25 + 24.45 });
export const NORTH_DISPATCH = Object.freeze({ interval: 5, approachSpeed: 33, departureSpeed: 44,
  braking: 1.35, acceleration: 1.25, dwell: 11, ready: 3, poolSize: 16, history: 512 });

export function createRailDispatch(routes, options = {}) {
  const config = { ...NORTH_DISPATCH, ...options };
  const { interval, approachSpeed, departureSpeed, braking, acceleration, dwell, ready, poolSize, history } = config;
  if (![interval, approachSpeed, departureSpeed, braking, acceleration, dwell, ready].every(n => Number.isFinite(n) && n > 0)
    || ![poolSize, history].every(n => Number.isSafeInteger(n) && n > 0) || !routes.length) throw new Error('Invalid railway dispatch');
  const locks = new Map();
  const trains = Array.from({ length: poolSize }, (_, slot) => ({ slot, route: null }));
  const logs = [];
  const counts = { triggered: { arrival: 0, departure: 0 }, started: { arrival: 0, departure: 0 },
    stopped: 0, cleared: 0, delayed: { arrival: 0, departure: 0 }, maxDelay: 0, reasons: {} };
  // 两类等待队列各用事件编号表示。即使长时间拥堵，也不会为未执行事件无限分配内存。
  const streams = [{ kind: 'arrival', next: 1 }, { kind: 'departure', next: 2 }];
  let event = 0, sequence = 0, routeIndex = 0, time = 0, accumulator = 0;
  const step = 1 / 30;
  const emit = (state, detail) => {
    if (logs.length === history) logs.shift();
    logs.push({ state, time: +time.toFixed(3), ...detail });
  };
  const blocker = (resources, own) => resources.find(id => locks.has(id) && locks.get(id) !== own);
  function hold(train, resources) {
    for (const id of resources) locks.set(id, train.slot);
  }
  function release(train, resources) {
    for (const id of resources) if (locks.get(id) === train.slot) locks.delete(id);
  }
  function phase(train, state) {
    train.state = state;
    train.phaseTime = time;
    emit(state, { train: train.id, route: train.route.id, berth: train.route.berth });
  }
  const readyTrains = () => trains.filter(t => t.route && t.state === 'ready' && time >= t.phaseTime + ready)
    .sort((a, b) => a.phaseTime - b.phaseTime || a.id - b.id);
  function admit(stream, protect = null) {
    const { kind, next: ticket } = stream;
    if (ticket > event) return;
    let train, route, reason;
    if (kind === 'arrival') {
      train = trains.find(t => !t.route);
      reason = train ? 'no-free-berth' : 'pool-full';
      if (train) for (let i = 0; i < routes.length; i++) {
        const index = (routeIndex + i) % routes.length;
        const candidate = routes[index];
        const resources = [candidate.berth, ...candidate.inbound];
        const locked = blocker(resources) ?? (protect && resources.find(id => protect.has(id)));
        if (locked) {
          if (locked !== candidate.berth) reason = locked;
          continue;
        }
        route = candidate;
        routeIndex = (index + 1) % routes.length;
        break;
      }
    } else {
      const waiting = readyTrains();
      reason = 'no-ready-train';
      for (const candidate of waiting) {
        const locked = blocker(candidate.route.outbound, candidate.slot);
        if (locked) { reason = locked; continue; }
        train = candidate;
        route = train.route;
        break;
      }
    }
    if (!route) {
      if (stream.waitReason !== reason) {
        counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1;
        emit('waiting', { kind, ticket, reason });
        stream.waitReason = reason;
      }
      return;
    }
    const delay = Math.max(0, +(time - ticket * interval).toFixed(3));
    if (delay > step) counts.delayed[kind]++;
    counts.maxDelay = Math.max(counts.maxDelay, delay);
    counts.started[kind]++;
    stream.next += 2;
    stream.waitReason = null;
    if (kind === 'arrival') {
      Object.assign(train, { route, id: ++sequence, s: 0, speed: approachSpeed, berthHeld: true });
      hold(train, [route.berth, ...route.inbound]);
      phase(train, 'approach');
    } else {
      hold(train, route.outbound);
      phase(train, 'accelerate');
    }
    emit('started', { kind, ticket, delay, train: train.id, route: route.id });
  }

  function tick() {
    for (const train of trains) {
      const { route, state } = train;
      if (!route) continue;
      if (state === 'approach' || state === 'brake') {
        const left = route.stop - train.s;
        // 将制动曲线反解为时间，确保零速停在计划点，不依赖帧率也不超调。
        const brakeDistance = approachSpeed ** 2 / (2 * braking);
        const cruise = Math.max(0, (left - brakeDistance) / approachSpeed);
        if (cruise >= step) train.s += approachSpeed * step;
        else {
          if (state === 'approach') phase(train, 'brake');
          const t = Math.max(0, Math.sqrt(2 * Math.min(left, brakeDistance) / braking) - (step - cruise));
          train.speed = braking * t;
          train.s = route.stop - braking * t * t / 2;
          if (t === 0) {
            release(train, route.inbound.filter(id => !route.parked?.includes(id)));
            counts.stopped++;
            phase(train, 'dwell');
          }
        }
        if (route.inboundTail && train.state !== 'dwell') {
          const tail = train.s - TRAIN.length - 6;
          for (const [id, end] of route.inboundTail) if (tail > end) release(train, [id]);
        }
      } else if (state === 'dwell' && time >= train.phaseTime + dwell) phase(train, 'ready');
      else if (state === 'accelerate' || state === 'leave') {
        const t = Math.min(step, (departureSpeed - train.speed) / acceleration);
        train.s += train.speed * t + acceleration * t * t / 2 + departureSpeed * (step - t);
        train.speed = Math.min(departureSpeed, train.speed + acceleration * t);
        if (route.outboundTail) {
          const tail = train.s - TRAIN.length - 6;
          for (const [id, end] of route.outboundTail) if (tail > end) release(train, [id]);
        }
        if (train.berthHeld && train.s - TRAIN.length > route.berthExit) {
          release(train, [route.berth]);
          train.berthHeld = false;
        }
        if (state === 'accelerate' && (train.s > route.berthExit + TRAIN.length || train.speed >= departureSpeed)) phase(train, 'leave');
        if (train.s - TRAIN.length >= route.length) {
          release(train, [route.berth, ...route.outbound]);
          counts.cleared++;
          phase(train, 'cleared');
          train.route = null;
        }
      }
    }
    while ((event + 1) * interval <= time + 1e-6) {
      event++;
      const kind = streams[(event - 1) % 2].kind;
      counts.triggered[kind]++;
      emit('scheduled', { kind, ticket: event, scheduled: event * interval });
    }
    admit(streams[1]);
    const oldest = streams[1].next <= event ? readyTrains()[0] : null;
    admit(streams[0], oldest ? new Set(oldest.route.outbound) : null);
  }

  function update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // 页面隐藏时调用方传 0；掉帧只补有限时间，避免恢复时列车跳段。
    accumulator += Math.min(dt, 0.25);
    while (accumulator + 1e-9 >= step) {
      accumulator -= step;
      time += step;
      tick();
    }
  }
  function snapshot() {
    return { time: +time.toFixed(3), ...structuredClone(counts),
      queued: Object.fromEntries(streams.map(s => [s.kind, Math.max(0, Math.floor((event - s.next) / 2) + 1)])),
      trains: trains.filter(t => t.route).map(t => ({ id: t.id, route: t.route.id, state: t.state, s: t.s,
        speed: t.speed, berth: t.route.berth })),
      reservations: locks.size, log: logs.slice() };
  }
  return { trains, update, snapshot, time: () => time };
}
