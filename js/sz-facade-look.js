// 立面窗格与亮灯噪声的公共参数和 CPU 版本。
// 着色器侧只在 sz-facade-nodes.js 里包一层 TSL，测试直接调用这里的纯函数算像素，
// 避免每份材质各写一套 smoothstep 与哈希常数。

// 窗格噪声的哈希常数：所有立面共用一份，改这里等于重新排布全城亮灯图案。
export const FACADE_NOISE = Object.freeze({ x: 12.9898, y: 78.233, scale: 43758.5453 });

// 窗格边缘抗锯齿的最小半宽（以开间/层高为单位的格坐标）。
// 地标幕墙原先分别写 0.003 / 0.004 / 0.005，像素覆盖不足时都会收敛到平均值。
export const PANE_SOFT_FLOOR = 0.004;

// 沿街店面夜间亮度曲线：黄昏 0.56 起亮，深夜 1.45 封顶。
export const SHOP_NIGHT_RAMP = Object.freeze({ from: 0.56, to: 1.45 });

const fract = (value) => value - Math.floor(value);

const smoothstep = (edge0, edge1, value) => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** 窗格遮罩：格坐标 cell 距格心的距离小于 edge 时为 1，边缘用 soft 过渡。
 *  与 TSL 的 smoothstep(edge-soft, edge+soft, |fract(cell)-0.5|).oneMinus() 等价。 */
export function paneMask(cell, edge, soft) {
  return 1 - smoothstep(edge - soft, edge + soft, Math.abs(fract(cell) - 0.5));
}

/** 楼层/开间噪声：同一个格心得到同一个 0–1 值，用来决定哪扇窗亮灯。 */
export function cellNoise(x, y, salt = FACADE_NOISE) {
  return fract(Math.sin(x * salt.x + y * salt.y) * salt.scale);
}

/** 沿街店面的夜间亮度：白天为 0，黄昏渐亮，深夜到 1。 */
export function shopNightGlow(interiorGlow) {
  return smoothstep(SHOP_NIGHT_RAMP.from, SHOP_NIGHT_RAMP.to, interiorGlow);
}
