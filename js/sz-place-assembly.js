// 场所接入装配：一处场所只在自己的构造结果旁登记一次“我提供什么”，入口按固定顺序消费，
// 不再为每个场所分别在高度图集、控制器表面、树灯预留、行人排除和模式权限里各写一条并列链。
//
// 事实分表存放，互不派生：
// - ground：场地地面层，进入活动表面图集；注册顺序即覆盖顺序，后注册覆盖先注册。
// - standable：可站结构面，进入控制器接触候选；Surface 身份和三角面原样保留。
// - walkReserve：树、植被与设施避让的步道/铺装预留；只表示“这里不要摆东西”，不授予通行资格。
// - lampReserve：路灯按道路断面落位后的额外避让。与 walkReserve 分开：路灯另有断面、路口
//   与 walkPlacement 逻辑，两处预留范围目前并不相同，不能互相推导。
// - walkerExclusion：环境行人的排除范围；不改变可站面、高度或视觉几何。
// - publicRoutes：该场所提供的公共步行线路，交给环境行人使用。
// - access.restricted：场地围合范围。地面模式与地图落点各自带余量查询，余量由消费者决定。
//
// 装饰（铺装网格、花箱、招牌、灯带、铁轨等）不进任何一张表，因此不会自动获得通行资格。
// 本模块只登记与查询，不构造几何，也不改写各场所自己的采样与判定。

export const GROUND_MODE_CLEARANCE_M = 0.58;

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new Error(`A place facet requires a function: ${label}`);
  return value;
}

function requireIdentity(place, byId) {
  if (!place || typeof place !== 'object') throw new Error('A place registration requires an object');
  if (typeof place.id !== 'string' || place.id.length === 0) throw new Error('A place requires identity');
  if (byId.has(place.id)) throw new Error(`Duplicate place: ${place.id}`);
}

export function createPlaceAssembly() {
  const grounds = [];
  const standableSurfaces = [];
  const walkReserves = [];
  const lampReserves = [];
  const walkerExclusions = [];
  const routeBuilders = [];
  const accessRules = [];
  const byId = new Map();
  let appliedGrounds = 0;

  function register(place) {
    requireIdentity(place, byId);
    const entry = { id: place.id, ground: null };
    if (place.ground !== undefined) {
      if (!place.ground || typeof place.ground !== 'object') throw new Error(`A place ground requires an object: ${place.id}`);
      requireFunction(place.ground.sample, `${place.id}.ground.sample`);
      // 高度出处必须显式给出：场所自己的铺装/场地不能默认成地形或场所名。
      if (typeof place.ground.heightSource !== 'string' || place.ground.heightSource.length === 0) {
        throw new Error(`A place ground requires height provenance: ${place.id}`);
      }
      entry.ground = {
        id: place.id,
        surfaceId: place.ground.surfaceId ?? place.id,
        heightSource: place.ground.heightSource,
        sample: place.ground.sample
      };
      grounds.push(entry.ground);
    }
    if (place.standable !== undefined) {
      if (!Array.isArray(place.standable) || place.standable.some(surface => !surface || !surface.id)) {
        throw new Error(`A place standable facet requires identified surfaces: ${place.id}`);
      }
      standableSurfaces.push(...place.standable);
    }
    if (place.walkReserve !== undefined) walkReserves.push(requireFunction(place.walkReserve, `${place.id}.walkReserve`));
    if (place.lampReserve !== undefined) lampReserves.push(requireFunction(place.lampReserve, `${place.id}.lampReserve`));
    if (place.walkerExclusion !== undefined) {
      walkerExclusions.push(requireFunction(place.walkerExclusion, `${place.id}.walkerExclusion`));
    }
    if (place.publicRoutes !== undefined) routeBuilders.push(requireFunction(place.publicRoutes, `${place.id}.publicRoutes`));
    if (place.access !== undefined) {
      if (!place.access || typeof place.access !== 'object') throw new Error(`A place access facet requires an object: ${place.id}`);
      accessRules.push(requireFunction(place.access.restricted, `${place.id}.access.restricted`));
    }
    byId.set(place.id, entry);
    return entry;
  }

  /** 按注册顺序把尚未加入图集的地面层追加进去；同一场所只加一次。 */
  function applyGrounds(atlas) {
    if (!atlas || typeof atlas.add !== 'function') throw new Error('A place ground requires a surface atlas');
    for (; appliedGrounds < grounds.length; appliedGrounds += 1) atlas.add(grounds[appliedGrounds]);
    return atlas;
  }

  /** 复用单层声明（例如铺装专用图集），避免入口再抄一遍 id / 高度出处。 */
  function groundLayer(id) {
    const entry = byId.get(id);
    if (!entry?.ground) throw new Error(`No ground layer registered for place: ${id}`);
    return entry.ground;
  }

  const anyOf = fns => (x, z, radius) => fns.some(fn => fn(x, z, radius));
  const reservesWalk = anyOf(walkReserves);
  const reservesLampSites = anyOf(lampReserves);
  const excludesWalker = anyOf(walkerExclusions);

  /** 场地围合：查询方给出自己的余量，不在这里替消费者决定净距。 */
  function restricted(x, z, margin = 0) {
    return accessRules.some(rule => rule(x, z, margin));
  }

  /**
   * 地面模式放行：围合范围内只认该场地自己的非地形表面（铺装、桥面、站台），
   * 与改造前 `!restricted(x,z,0.58) || (surfaceId!=='terrain' && heightSource!=='terrain')` 一致。
   * 调用方仍保留模式本身的其它限制；本查询只回答“场所围合是否放行”。
   */
  function allowsGroundMode(mode, x, z, surface) {
    if (accessRules.length === 0) return true;
    const ownSurface = surface?.surfaceId !== 'terrain' && surface?.heightSource !== 'terrain';
    return !restricted(x, z, GROUND_MODE_CLEARANCE_M) || ownSurface;
  }

  function publicRoutes(context) {
    const rows = [];
    for (const build of routeBuilders) {
      const routes = build(context);
      if (!Array.isArray(routes)) throw new Error('A place publicRoutes facet must return an array');
      rows.push(...routes);
    }
    return rows;
  }

  return {
    register, applyGrounds, groundLayer,
    get standable() { return standableSurfaces; },
    reservesWalk, reservesLampSites, excludesWalker, publicRoutes,
    restricted, allowsGroundMode,
    get size() { return byId.size; },
    has: id => byId.has(id)
  };
}
