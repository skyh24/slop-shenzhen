// 圆形补植区在项目锁定的 OSM 园界或山林面内选取，离源道路、步道、广场和球场留有净空。
// 中心、半径、树种及树点均为场景设计。只在这些空地补植，保留其余活动草坪和观景面。
const GROVES = {
  'flower-expo': [[-5480, 440, 102], [-5640, 600, 48], [-5360, 280, 43]],
  'lotus-hill': [[-280, -1680, 77], [-840, -1040, 62], [200, -1480, 68]],
  'bijia-hill': [[2800, -2360, 102], [2120, -2240, 102]],
  'nanshan': [[-16000, 4920, 102], [-15400, 5200, 102], [-15640, 5600, 102], [-16000, 5520, 102]],
  'tanglang': [[-6840, -3920, 102], [-6520, -3800, 102], [-6160, -2320, 102], [-6240, -2000, 102]]
};

const SPACING_M = 10.5;

// 坐标哈希让重载结果一致；每格最多一个候选，树点随地块边缘逐渐稀疏。
function variation(ix, iz, salt) {
  let bits = Math.imul(ix, 0x1f123bb5) ^ Math.imul(iz, 0x5f356495) ^ Math.imul(salt, 0x9e3779b9);
  bits = Math.imul(bits ^ (bits >>> 16), 0x45d9f3b);
  return ((bits ^ (bits >>> 16)) >>> 0) / 4294967296;
}

export function planWoodlandTrees() {
  const trees = [];
  for (const [site, patches] of Object.entries(GROVES)) {
    for (const [cx, cz, radius] of patches) {
      for (let iz = Math.floor((cz - radius) / SPACING_M); iz <= Math.floor((cz + radius) / SPACING_M); iz++) {
        for (let ix = Math.floor((cx - radius) / SPACING_M); ix <= Math.floor((cx + radius) / SPACING_M); ix++) {
          const x = (ix + 0.29 + 0.42 * variation(ix, iz, 1)) * SPACING_M;
          const z = (iz + 0.29 + 0.42 * variation(ix, iz, 2)) * SPACING_M;
          const distance = Math.hypot(x - cx, z - cz) / radius;
          if (distance > 1 || variation(ix, iz, 3) > Math.min(0.92, (1 - distance) * 3.1)) continue;
          trees.push({ id: `woodland:${site}:${ix},${iz}`, x, z,
            height: 7.3 + 5.1 * variation(ix, iz, 4), crown: 7.2 + 4.2 * variation(ix, iz, 5),
            speciesName: 'camphor', appearanceSource: 'visual-estimate' });
        }
      }
    }
  }
  return trees;
}
