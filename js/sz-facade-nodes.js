import { Fn, abs, dot, float, floor, fract, fwidth, max, sin, smoothstep, vec2 } from 'three/tsl';
import { FACADE_NOISE, PANE_SOFT_FLOOR, SHOP_NIGHT_RAMP } from './sz-facade-look.js';

// 立面着色的公共 TSL 节点：窗格 SDF、格心噪声、店面夜间曲线。
// 数值与 sz-facade-look.js 的 CPU 版本一一对应，参数只在那里定义。

// Fn 让哈希成为可复用函数节点，两次调用共用一张子图，冷编译节点数与改造前持平。
export const hash21Node = Fn(([point]) =>
  fract(sin(dot(point, vec2(FACADE_NOISE.x, FACADE_NOISE.y))).mul(FACADE_NOISE.scale)));

/** 格心噪声：floor 到整格后取哈希，同一扇窗恒定亮或不亮。 */
export const cellNoiseNode = (cellX, cellY) => hash21Node(vec2(floor(cellX), floor(cellY)));

/** 窗格遮罩，soft 为边缘半宽（一般传 fwidth(cell) 的放大值）。 */
export const paneMaskNode = (cell, edge, soft) => {
  const edgeNode = typeof edge === 'number' ? float(edge) : edge;
  return smoothstep(edgeNode.sub(soft), edgeNode.add(soft), abs(fract(cell).sub(0.5))).oneMinus();
};

/** 边缘半宽：像素覆盖率不足时抬到 softFloor，远景细节因此均匀收敛。 */
export const paneSoftNode = (cell, softFloor = PANE_SOFT_FLOOR) => max(fwidth(cell), softFloor);

/** 窗格遮罩，按像素覆盖率自动取边缘半宽。 */
export const paneMaskAutoNode = (cell, edge, softFloor = PANE_SOFT_FLOOR) =>
  paneMaskNode(cell, edge, paneSoftNode(cell, softFloor));

/** 沿街店面夜间亮度，与 sz-facade-look.js 的 shopNightGlow 同一条曲线。 */
export const shopNightNode = (interiorGlow) =>
  smoothstep(SHOP_NIGHT_RAMP.from, SHOP_NIGHT_RAMP.to, interiorGlow);
