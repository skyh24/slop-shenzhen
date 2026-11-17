// 活动表面图集：一次查询同时给出「这一点多高」和「属于哪一层、出处是什么」。
// 层按注册顺序分层，后注册的层覆盖先注册的层（地面 → 步行面 → 路侧 → 场地 → 站房），
// 因此装配顺序只体现在注册顺序里，读调用点即可判断一栋楼站在哪一层。
// 这里只做合成与出处的记账，不重复插值：每层仍由自己的采样器把三角面算成高度。

function requireLayer(layer) {
  if (!layer?.id) throw new Error('A surface layer requires identity');
  if (typeof layer.sample !== 'function') throw new Error(`A surface layer requires a sample function: ${layer.id}`);
  return layer;
}

export function createSurfaceAtlas({ groundHeight = null, layers = [] } = {}) {
  const stack = [];

  function add(layer) {
    requireLayer(layer);
    if (stack.some(existing => existing.id === layer.id)) throw new Error(`Duplicate surface layer: ${layer.id}`);
    stack.push({
      id: layer.id,
      surfaceId: layer.surfaceId ?? layer.id,
      heightSource: layer.heightSource ?? layer.id,
      sample: layer.sample
    });
    return atlas;
  }

  /** 最高优先级且真正覆盖该点的层；都未覆盖时返回 null，不向下一层编造高度。 */
  function at(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const layer = stack[i];
      const y = layer.sample(x, z);
      if (Number.isFinite(y)) return { y, surfaceId: layer.surfaceId, heightSource: layer.heightSource };
    }
    return null;
  }

  /** 该点覆盖到的全部层，按高度升序；用于核对"同一处被两层同时覆盖"的装配假设。 */
  function all(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const rows = [];
    for (const layer of stack) {
      const y = layer.sample(x, z);
      if (Number.isFinite(y)) rows.push({ y, surfaceId: layer.surfaceId, heightSource: layer.heightSource });
    }
    return rows.sort((a, b) => a.y - b.y || a.surfaceId.localeCompare(b.surfaceId));
  }

  /** 只要高度时走直通循环：落位阶段每秒要问几十万次，不在这里分配来源对象。 */
  function heightAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const y = stack[i].sample(x, z);
      if (Number.isFinite(y)) return y;
    }
    return null;
  }

  const atlas = { at, all, heightAt, add };
  if (groundHeight) add({ id: 'terrain', surfaceId: 'terrain', heightSource: 'terrain', sample: groundHeight });
  for (const layer of layers) add(layer);
  return atlas;
}