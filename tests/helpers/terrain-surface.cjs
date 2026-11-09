// 小型测试格网的完整三角面；测试可显式删除三角形模拟未知地面。
function fixtureTerrainSurface(grid) {
  const chunks = [];
  const chunkSize = grid.step;
  for (let j = 0; j < grid.nz - 1; j++) {
    for (let i = 0; i < grid.nx - 1; i++) {
      const x = grid.x0 + i * grid.step, z = grid.z0 + j * grid.step;
      const height = (dx, dz) => grid.heights[(j + dz) * grid.nx + i + dx] * grid.heightScale;
      chunks.push({ id: `${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`,
        origin: [x, z], positions: [0, height(0, 0), 0, grid.step, height(1, 0), 0,
          0, height(0, 1), grid.step, grid.step, height(1, 1), grid.step],
        indices: [0, 2, 1, 1, 2, 3], kinds: [0, 0, 0, 0],
        cellRanges: [j * (grid.nx - 1) + i, 0, 6] });
    }
  }
  return { version: 1, chunkSize, diagonal: 'ne-sw', grid, chunks };
}

module.exports = { fixtureTerrainSurface };
