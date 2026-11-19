// 普通楼外观按名称选择；包内索引只用来解码名称。前八项与 Python 生成器的枚举由回归测试对照。
// 中性预设处理缺省或未知用途，兼容包里已有的外观估计。
// 这些是外观参数，不是逐楼实测的层数、用途或建成年份；缺失或矛盾的层数才按预设估计窗层。
// 字段：bayWidth/floorHeight 为米；winRatioW/H 是窗占开间/层高的比例；sill 是窗台相对层底的比例；
// glazing 0 实体墙 → 1 玻璃幕墙；warmth 是夜灯偏暖比例；litShare 是模拟亮灯比例；
// groundStyle 0 大堂 / 1 店面 / 2 单元入口 / 3 工业门洞；cornerMargin 墙角留白米数。
// detailBucket 指向共享近景材质；开关只决定模拟部件，不改变建筑用途或通行。
export const FACADE_PROFILES = Object.freeze([
  {
    name: 'glass_tower', bayWidth: 1.6, floorHeight: 4.2, winRatioW: 0.94, winRatioH: 0.84,
    sill: 0.12, glazing: 1.0, warmth: 0.12, litShare: 0.10,
    groundHeight: 5.2, groundStyle: 0,
    cornerMargin: 0.25, detailBucket: 3,
    wallA: 0x7d8f99, trim: 0xb9c4ca
  },
  {
    name: 'office', bayWidth: 3.0, floorHeight: 3.9, winRatioW: 0.96, winRatioH: 0.50,
    sill: 0.34, glazing: 0.62, warmth: 0.22, litShare: 0.13,
    groundHeight: 4.5, groundStyle: 0,
    cornerMargin: 0.4, detailBucket: 2,
    wallA: 0xaeb3ad, trim: 0x8e9491
  },
  {
    name: 'residential_tower', bayWidth: 3.4, floorHeight: 3.0, winRatioW: 0.80, winRatioH: 0.50,
    sill: 0.28, glazing: 0.28, warmth: 0.80, litShare: 0.18,
    groundHeight: 4.2, groundStyle: 2,
    cornerMargin: 0.4, detailBucket: 0,
    balcony: true, airConditioner: true, residential: true,
    wallA: 0xd8d0c2, trim: 0xb7ae9e
  },
  {
    name: 'residential_low', bayWidth: 3.2, floorHeight: 3.2, winRatioW: 0.78, winRatioH: 0.50,
    sill: 0.30, glazing: 0.25, warmth: 0.88, litShare: 0.17,
    groundHeight: 4.2, groundStyle: 2,
    cornerMargin: 0.35, detailBucket: 0,
    balcony: true, airConditioner: true, residential: true, waterTank: true,
    wallA: 0xc9b696, trim: 0xa8977c
  },
  {
    name: 'village', bayWidth: 2.6, floorHeight: 2.9, winRatioW: 0.38, winRatioH: 0.40,
    sill: 0.30, glazing: 0.15, warmth: 0.90, litShare: 0.11,
    groundHeight: 4.5, groundStyle: 1,
    cornerMargin: 0.28, detailBucket: 1,
    airConditioner: true, waterTank: true,
    wallA: 0xd9d6cd, trim: 0x9a978e
  },
  {
    name: 'industrial', bayWidth: 6.0, floorHeight: 6.0, winRatioW: 0.84, winRatioH: 0.26,
    sill: 0.56, glazing: 0.40, warmth: 0.35, litShare: 0.05,
    groundHeight: 6.0, groundStyle: 3,
    cornerMargin: 0.5, detailBucket: 2,
    wallA: 0x9aa3a4, trim: 0x7e8788
  },
  {
    name: 'public', bayWidth: 4.0, floorHeight: 4.5, winRatioW: 0.55, winRatioH: 0.55,
    sill: 0.22, glazing: 0.50, warmth: 0.50, litShare: 0.08,
    groundHeight: 4.8, groundStyle: 0,
    cornerMargin: 0.45, detailBucket: 2,
    wallA: 0xc8c3b5, trim: 0xa9a390
  },
  {
    name: 'landmark', bayWidth: 1.6, floorHeight: 4.4, winRatioW: 0.94, winRatioH: 0.88,
    sill: 0.10, glazing: 1.0, warmth: 0.18, litShare: 0.10,
    groundHeight: 5.2, groundStyle: 0,
    cornerMargin: 0.25, detailBucket: 3,
    wallA: 0x9ca9b0, trim: 0xc4cdd2
  },
  {
    name: 'unknown', bayWidth: 3.4, floorHeight: 3.3, winRatioW: 0.48, winRatioH: 0.48,
    sill: 0.24, glazing: 0.32, warmth: 0.5, litShare: 0.08,
    groundHeight: 4.2, groundStyle: 2, cornerMargin: 0.4, detailBucket: 2,
    wallA: 0xa7a7a1, trim: 0x92958e
  }
].map(profile => Object.freeze({ balcony: false, airConditioner: false, residential: false, waterTank: false, ...profile })));

const FACADE_INDICES = new Map(FACADE_PROFILES.map(({ name }, index) => [name, index]));

export function facadeIndex(name) {
  const index = FACADE_INDICES.get(name ?? 'unknown');
  if (index === undefined) throw new Error(`Unknown building facade: ${name}`);
  return index;
}

export function facadeProfile(name) {
  return FACADE_PROFILES[facadeIndex(name)];
}

// 外墙 UV 与近景阳台共用墙角余量、整数开间和窗框尺寸。
export const FACADE_GRID = Object.freeze({ cornerFraction: 0.18, minInnerLength: 0.2, frame: 0.04 });

export function fitFacadeBays(length, profile) {
  // 按顶点属性和着色器的 Float32 精度取整，避免名义半跨附近分成不同的整数开间。
  const f32 = Math.fround;
  const wallLength = f32(length);
  const margin = Math.min(f32(profile.cornerMargin), f32(wallLength * f32(FACADE_GRID.cornerFraction)));
  const inner = Math.max(f32(wallLength - f32(margin * 2)), f32(FACADE_GRID.minInnerLength));
  const count = Math.max(1, Math.floor(f32(f32(inner / f32(profile.bayWidth)) + 0.5)));
  return { margin, count, width: f32(inner / count) };
}

// 航天科技广场 A 座与深圳湾公馆的外观样本。大堂高度参考设计方资料，
// 窗格、阳台和雨棚尺寸取外观估计，坐标为正式包足迹的米制范围。
// materialSeed 取 Math.fround(buildingSeed(id) * 10)，与合批顶点属性一致。
export const HOUHAI_OFFICE = 'way/737426464';
export const SHENZHEN_BAY_MANSION = 'way/1352291472';
export const FACADE_SAMPLE_PROFILES = {
  [HOUHAI_OFFICE]: {
    appearanceSource: 'estimate', materialSeed: 2.5392842292785645, bounds: [-12104, -12049, 2568, 2626],
    lobbyHeight: 30, canopy: { width: 18, depth: 4.4, height: 5.8 }
  },
  [SHENZHEN_BAY_MANSION]: {
    appearanceSource: 'estimate', materialSeed: 7.08568000793457, bounds: [-13040, -12999, 4019, 4059],
    bayWidth: 4.8, floorHeight: 3.1, balconyDepth: 1.45,
    winRatioW: 0.91, winRatioH: 0.78, sill: 0.15, glazing: 0.9, wallColor: 0x8297a0
  }
};

// 总层数包含首层；标准窗、阳台和空调共用同一竖向网格，架空部分只裁切，不另起一套窗层。
export function fitFacadeFloors(building, profile = facadeProfile(building.facade)) {
  const sample = FACADE_SAMPLE_PROFILES[building.id];
  const nominal = sample?.floorHeight ?? profile.floorHeight;
  const height = Math.max(0.1, building.height);
  const levels = building.levels;
  const plausible = Number.isInteger(levels) && levels > 0 && levels <= 200
    && height / levels >= 2.2 && height / levels <= 8;
  const floors = plausible ? levels : Math.min(200, Math.max(1, Math.round(height / nominal)));
  const groundHeight = floors === 1 ? height
    : Math.min(profile.groundHeight, height - (floors - 1) * 2.2);
  const floorHeight = floors === 1 ? nominal : (height - groundHeight) / (floors - 1);
  return { floors, groundHeight: Math.fround(groundHeight), floorHeight: Math.fround(floorHeight) };
}
