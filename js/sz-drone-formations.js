// 灯点由原创折线和字形生成；每个格点只容纳一架无人机。
const STEP = 4;
export const FLEET_SIZE = 196;
const WARM = [1, 0.19, 0.34], GOLD = [1, 0.71, 0.22], CYAN = [0.15, 0.91, 1];
const BLUE = [0.24, 0.51, 1], PURPLE = [0.75, 0.34, 1], WHITE = [0.95, 0.96, 1];
const DIM = [0.06, 0.13, 0.21];

const alphabet = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111']
};
const shenzhen = [
  // “深”三点水、宝盖、两撇与木；“圳”土和三川。
  [[0, 1], [2, 2]], [[0, 4], [2, 5]], [[0, 10], [2, 7]],
  [[4, 3], [4, 1], [12, 1], [12, 3]], [[7, 3], [5, 5]], [[9, 3], [11, 5]],
  [[4, 6], [12, 6]], [[8, 5], [8, 11]], [[8, 6], [4, 10]], [[8, 6], [12, 10]],
  [[16, 4], [20, 4]], [[18, 1], [18, 8]], [[16, 9], [20, 7]],
  [[22, 1], [22, 8], [21, 10]], [[25, 2], [25, 9]], [[28, 1], [28, 11]]
];
const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function formation(draw) {
  const grid = new Map();
  const point = (x, y, tint, essential = false) => {
    const ix = Math.round(x), iy = Math.round(y);
    const key = `${ix},${iy}`;
    if (!grid.has(key) || essential) grid.set(key, { u: ix * STEP, v: iy * STEP, tint, essential });
  };
  const stroke = (line, tint, essential = false) => {
    for (let i = 1; i < line.length; i++) {
      const [x, y] = line[i - 1], [a, b] = line[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(a - x, b - y) * 1.25));
      for (let k = 0; k <= steps; k++) point(x + (a - x) * k / steps, y + (b - y) * k / steps, tint, essential);
    }
  };
  const curve = (fn, tint, steps = 120) =>
    stroke(Array.from({ length: steps + 1 }, (_, i) => fn(i / steps)), tint);
  draw({ point, stroke, curve });
  // 先完整保留文字笔画。其余机位沿所有轮廓均匀稀释，避免把末尾笔画或浪线整体截掉。
  if (grid.size > FLEET_SIZE) {
    const required = [...grid.values()].filter(p => p.essential);
    const outline = [...grid.values()].filter(p => !p.essential);
    const count = FLEET_SIZE - required.length;
    if (count < 0) throw new Error('Drone lettering exceeds fleet capacity');
    return [...required, ...Array.from({ length: count }, (_, i) => outline[Math.floor((i + 0.5) * outline.length / count)])];
  }
  // 剩余机位组成低亮度背景星点；避免用多余的灯点填实图案。
  for (let i = 0; grid.size < FLEET_SIZE; i++) {
    const x = ((i * 87) % 1679) % 41 - 20;
    const y = Math.floor(((i * 87) % 1679) / 41) - 20;
    if (Math.abs(x) >= 18 || Math.abs(y) >= 15) point(x, y, DIM);
  }
  return [...grid.values()];
}

export function createDroneFormations() {
  const dock = formation(({ point }) => {
    for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) point(i - 7, j - 7, [0, 0, 0]);
  });
  return [
    { id: 'launch', hold: 1, points: dock, v: -25, depth: 38, motion: 0 },
    { id: 'gather', hold: 4, points: formation(({ curve }) => {
      for (let i = 0; i < 3; i++) curve(t => {
        const a = t * 2 * Math.PI + i * Math.PI * 2 / 3;
        const r = 2 + 14 * t;
        return [Math.cos(a) * r, Math.sin(a) * r * 0.7];
      }, [CYAN, GOLD, PURPLE][i]);
    }) },
    { id: 'flower', hold: 10, points: formation(({ curve, point, stroke }) => {
      for (let i = 0; i < 5; i++) {
        const axis = Math.PI / 2 - i * 2 * Math.PI / 5;
        curve(t => {
          const r = 2.8 + Math.sin(t * Math.PI) * 11.4, a = axis + (t - 0.5) * 1.18;
          return [Math.cos(a) * r, Math.sin(a) * r + 2];
        }, blend(WARM, PURPLE, i / 5));
      }
      curve(t => [Math.cos(t * 2 * Math.PI) * 2.4, 2 + Math.sin(t * 2 * Math.PI) * 2.4], GOLD);
      point(0, 2, WHITE);
      stroke([[0, -2], [0, -13], [-2, -17]], CYAN);
      curve(t => [-8 * t, -12 + 3 * Math.sin(t * Math.PI) + t], CYAN);
      curve(t => [8 * t, -14 + 3 * Math.sin(t * Math.PI) + t], CYAN);
    }) },
    { id: 'coast', hold: 10, points: formation(({ curve, stroke, point }) => {
      // 越过三道浪尖的海豚，留出腹部、尾鳍和背鳍的负空间。
      stroke([[-15, 0], [-12, 4], [-8, 8], [-2, 11], [4, 12], [8, 11], [10, 9],
        [14, 8], [15, 7], [12, 6], [9, 6], [5, 2], [0, 0], [-7, -1], [-12, -2]], CYAN);
      stroke([[-15, 0], [-19, 2], [-18, -2], [-19, -5], [-12, -2]], BLUE);
      stroke([[-3, 10], [-5, 14], [-2, 14], [2, 12]], CYAN);
      stroke([[6, 3], [4, -3], [1, -4], [2, 1]], BLUE);
      point(8, 9, WHITE);
      for (let j = 0; j < 3; j++) curve(t => [t * 38 - 19, -7 - j * 3 + Math.sin(t * 13 - j * 0.45) * 1.45],
        blend(CYAN, BLUE, j / 2));
    }) },
    { id: 'rocket', hold: 11, motion: 10, points: formation(({ stroke, curve }) => {
      stroke([[-5, -4], [-5, 6], [-3, 11], [0, 15], [3, 11], [5, 6], [5, -4], [-5, -4]], WHITE);
      stroke([[-5, 2], [-9, -4], [-9, -8], [-5, -6], [5, -6], [9, -8], [9, -4], [5, 2]], BLUE);
      curve(t => [2 * Math.cos(t * 2 * Math.PI), 5 + 2 * Math.sin(t * 2 * Math.PI)], CYAN);
      for (let i = 0; i < 5; i++) stroke([[i * 2 - 4, -8], [(i - 2) * 1.45, -12],
        [(i - 2) * 0.9, -13 - (2 - Math.abs(i - 2)) * 2.5]], blend(WARM, GOLD, i / 4));
    }) },
    { id: 'city', hold: 12, points: formation(({ stroke }) => {
      stroke([[-19, 0], [-16, 0], [-16, 5], [-14, 5], [-14, 0], [-11, 0], [-11, 8], [-8, 8], [-8, 0],
        [-6, 0], [-6, 13], [-5, 16], [-4, 17], [-3, 16], [-2, 13], [-2, 0], [1, 0], [1, 8],
        [3, 12], [4, 8], [4, 0], [7, 0], [7, 16], [8, 19], [10, 16], [10, 0], [13, 0],
        [13, 5], [17, 5], [18, 3], [18, 0], [20, 0]], CYAN);
      for (const line of shenzhen) stroke(line.map(([x, y]) => [x - 14, -4 - y]), GOLD, true);
    }) },
    { id: 'apec', hold: 12, points: formation(({ point, curve }) => {
      [...'APEC'].forEach((letter, k) => alphabet[letter].forEach((line, j) =>
        [...line].forEach((bit, i) => { if (bit === '1') point(-16 + k * 9 + i, 11 - j, [CYAN, BLUE, PURPLE, GOLD][k], true); })));
      for (let i = 0; i < 3; i++) curve(t => {
        const a = t * 2 * Math.PI;
        return [15 * Math.cos(a) + (i - 1) * 3, -6 + (4.5 + i * 1.65) * Math.sin(a)
          + (i - 1) * 3.3 * Math.cos(a)];
      }, [CYAN, PURPLE, GOLD][i]);
    }) },
    { id: 'farewell', hold: 7, points: formation(({ curve }) => {
      for (let i = 0; i < 5; i++) curve(t => [t * 38 - 19, (i - 2) * 3.2 + 6 * Math.sin(t * 6.28 + i * 0.28)],
        [WARM, GOLD, CYAN, BLUE, PURPLE][i]);
    }) },
    { id: 'return', hold: 1, points: dock, v: -25, depth: 38 }
  ];
}
