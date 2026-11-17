// 街具分块批：分块键、相机距离、迟滞与档位切换只写一份。
// 每块显示什么仍由调用方在 add() 里声明，本模块只回答「这一块现在处于哪个状态」，
// 因此不 import three：树、路灯、地铁口共用一套进出规则，测试也能直接喂坐标。
// 可见性用 <=（进入和保持都含边界），档位带用 <（与树冠近景的现状一致）。

export function chunkKey(x, z, sizeM) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('A chunk key requires a finite position');
  if (!Number.isFinite(sizeM) || sizeM <= 0) throw new Error('A chunk key requires a positive chunk size');
  return `${Math.floor(x / sizeM)},${Math.floor(z / sizeM)}`;
}

function requireDistance(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`A street batch requires a finite ${label}`);
  return value;
}

function requireBox(box, key) {
  const ordered = ['minX', 'maxX', 'minZ', 'maxZ'].every(edge => Number.isFinite(box[edge]));
  if (!ordered || box.minX > box.maxX || box.minZ > box.maxZ) {
    throw new Error(`A street batch unit requires an ordered box: ${key}`);
  }
}

function boxDistance(box, x, z) {
  const dx = x < box.minX ? box.minX - x : x > box.maxX ? x - box.maxX : 0;
  const dz = z < box.minZ ? box.minZ - z : z > box.maxZ ? z - box.maxZ : 0;
  return Math.hypot(dx, dz);
}

/**
 * 一块一个状态：'hidden' → 'base'（可见但用远景表示）→ levels 里的近景档。
 * enterM 是进入可见的距离，exitM 是保持可见的距离；两者相等就是硬阈值。
 * levels 按由近到远声明，只有可见时才参与选择。
 */
export function createStreetBatch({ enterM, exitM = enterM, levels = [] } = {}) {
  requireDistance(enterM, 'enter distance');
  requireDistance(exitM, 'exit distance');
  if (exitM < enterM) throw new Error('A street batch exit distance cannot be shorter than its enter distance');
  const bands = levels.map((level) => {
    if (!level?.id) throw new Error('A street batch level requires identity');
    const enter = requireDistance(level.enterM, `enter distance for ${level.id}`);
    const exit = requireDistance(level.exitM ?? enter, `exit distance for ${level.id}`);
    if (exit < enter) throw new Error(`A street batch level exit distance cannot be shorter than its enter distance: ${level.id}`);
    return { id: level.id, enterM: enter, exitM: exit };
  });
  if (new Set(bands.map(band => band.id)).size !== bands.length) throw new Error('Duplicate street batch level');

  const units = new Map();

  function add({ key, box = null, center = null, apply } = {}) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('A street batch unit requires a key');
    if (units.has(key)) throw new Error(`Duplicate street batch unit: ${key}`);
    if (typeof apply !== 'function') throw new Error(`A street batch unit requires an apply function: ${key}`);
    if (box) requireBox(box, key);
    else if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.z)) {
      throw new Error(`A street batch unit requires a box or a centre: ${key}`);
    }
    units.set(key, {
      key,
      box: box ? { minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ } : null,
      center: box ? null : { x: center.x, z: center.z },
      apply,
      // null 表示还没按相机算过；第一帧一定会调用 apply，三维对象不会停在默认可见上。
      state: null
    });
  }

  function nextState(unit, distance) {
    const entering = unit.state === null || unit.state === 'hidden';
    const visible = entering ? distance <= enterM : distance <= exitM;
    if (!visible) return 'hidden';
    for (const band of bands) {
      const reach = unit.state === band.id ? band.exitM : band.enterM;
      if (distance < reach) return band.id;
    }
    return 'base';
  }

  function summary() {
    const counts = { hidden: 0, visible: 0, levels: {} };
    for (const band of bands) counts.levels[band.id] = 0;
    for (const unit of units.values()) {
      const state = unit.state ?? 'hidden';
      if (state === 'hidden') counts.hidden += 1;
      else {
        counts.visible += 1;
        if (state !== 'base') counts.levels[state] += 1;
      }
    }
    return counts;
  }

  /** 按相机水平位置推进一帧；只有状态变化时才调用该块的 apply。 */
  function update(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('A street batch update requires a finite camera position');
    for (const unit of units.values()) {
      const distance = unit.box ? boxDistance(unit.box, x, z) : Math.hypot(x - unit.center.x, z - unit.center.z);
      const state = nextState(unit, distance);
      if (state === unit.state) continue;
      unit.state = state;
      unit.apply(state);
    }
    return summary();
  }

  /** 未登记的键返回 null，别把"没有这一块"误读成"隐藏"。 */
  function state(key) {
    return units.get(key)?.state ?? null;
  }

  return { add, update, state, summary, size: () => units.size };
}
