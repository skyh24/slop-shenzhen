// 昼夜通道：白天到深夜的灯光强度只在这里算。
// 时段本身的参数（太阳、天空、雾、interiorGlow）仍由 lighting.js 的 TIME_PRESETS 拥有并写入 uniform；
// 本模块只负责“现在有多黑 → 各类灯该多亮”的换算，消费方不再各自拿 sceneUniforms.night.value 比阈值。
// 窗格与店招的连续亮度留在各自材质里，等 facadeLook 候选再收。

export const DAY_PHASE_CHANNELS = Object.freeze(['night', 'lamps', 'show', 'headlights', 'deepNight']);

// 车灯投影强度的满档值，和 controllers.js 的聚光灯上限一致。
export const HEADLIGHTS_FULL = 1.28;

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const smoothstep = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// 曲线输入是两份全局参数：night（0 白天 … 0.28 黄昏 … 0.86 午夜）与 uInteriorGlow（0.24 正午 … 1.55 午夜）。
// 每条曲线的两端都钉在“白天严格为 0、午夜饱和”，中间段按各自该亮的时机取。
const CURVES = {
  // 原始昼夜系数：只给需要连续衰减的消费方（路灯照度、APEC 灯珠）。
  night: night => clamp01(night),
  // 街具、水池、绿地灯：黄昏一出现就亮，午夜到满。
  lamps: night => smoothstep(0, 0.45, night),
  // 楼体灯光秀：和着色器里的 fade 同一条曲线，黄昏最暗时才算亮起来。
  show: night => smoothstep(0.32, 0.68, night),
  // 车灯：跟着室内灯走，黄昏半亮、午夜满亮，乘回 HEADLIGHTS_FULL 就是聚光灯强度。
  headlights: (night, glow) => clamp01((glow - 0.60) * 1.45 / HEADLIGHTS_FULL),
  // 深夜档：烟火、环境音、CBD 屏保这类只在真正入夜后出现的东西。
  deepNight: night => smoothstep(0.35, 0.75, night)
};

/** 给定昼夜系数与室内灯系数，返回全部通道值；纯函数，测试直接用。 */
export function dayChannels(night, glow) {
  const channels = {};
  for (const name of DAY_PHASE_CHANNELS) channels[name] = CURVES[name](night, glow);
  return channels;
}

export function createDayPhase() {
  let id = null;
  let phases = null;
  let applyLighting = null;
  let applyLook = null;
  let readNight = () => 0;
  let readGlow = () => 0.48;
  return {
    get id() { return id; },
    /** 接上光照与调色两个执行端，以及通道要读的全局参数。 */
    wire(options = {}) {
      if (options.phases !== undefined) {
        if (!Array.isArray(options.phases) || options.phases.length === 0) {
          throw new Error('A day phase list requires at least one id');
        }
        if (options.phases.some(phase => typeof phase !== 'string' || !phase)) {
          throw new Error('A day phase id must be a non-empty string');
        }
        if (new Set(options.phases).size !== options.phases.length) {
          throw new Error('Duplicate day phase id');
        }
        phases = options.phases.slice();
      }
      if (options.applyLighting !== undefined) {
        if (typeof options.applyLighting !== 'function') throw new Error('applyLighting must be a function');
        applyLighting = options.applyLighting;
      }
      if (options.applyLook !== undefined) {
        if (typeof options.applyLook !== 'function') throw new Error('applyLook must be a function');
        applyLook = options.applyLook;
      }
      if (options.night !== undefined) {
        if (typeof options.night !== 'function') throw new Error('night must be a function');
        readNight = options.night;
      }
      if (options.glow !== undefined) {
        if (typeof options.glow !== 'function') throw new Error('glow must be a function');
        readGlow = options.glow;
      }
      return this;
    },
    /** 换时段：先写光照（通道读的就是它写入的参数），再写调色。未知 id 返回 false，不半途改状态。 */
    apply(nextId) {
      if (typeof nextId !== 'string' || !nextId) return false;
      if (phases && !phases.includes(nextId)) return false;
      applyLighting?.(nextId);
      applyLook?.(nextId);
      id = nextId;
      return true;
    },
    channels() { return dayChannels(readNight(), readGlow()); },
    channel(name) {
      const curve = CURVES[name];
      if (!curve) throw new Error(`Unknown day phase channel: ${name}`);
      return curve(readNight(), readGlow());
    },
    get isDeepNight() { return CURVES.deepNight(readNight(), readGlow()) >= 0.5; }
  };
}

// 全场一个实例：消费方 import 这个读通道，入口 main.js 负责 wire 与 apply。
export const dayPhase = createDayPhase();
