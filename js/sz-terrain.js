// 高度查询与网格共用东北—西南对角线，禁止用双线性插值替代三角面接触。
export function terrainHeight(grid, x, z) {
  if (!grid) return 0;
  const fx = (x - grid.x0) / grid.step;
  const fz = (z - grid.z0) / grid.step;
  if (fx < 0 || fz < 0 || fx > grid.nx - 1 || fz > grid.nz - 1) return 0;
  const i = Math.min(Math.floor(fx), grid.nx - 2);
  const j = Math.min(Math.floor(fz), grid.nz - 2);
  const u = fx - i;
  const v = fz - j;
  const a = grid.heights[j * grid.nx + i] * grid.heightScale;
  const b = grid.heights[j * grid.nx + i + 1] * grid.heightScale;
  const c = grid.heights[(j + 1) * grid.nx + i] * grid.heightScale;
  const d = grid.heights[(j + 1) * grid.nx + i + 1] * grid.heightScale;
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

export function terrainCellTriangles(grid, i, j) {
  const point = (col, row) => [grid.x0 + col * grid.step,
    grid.heights[row * grid.nx + col] * grid.heightScale, grid.z0 + row * grid.step];
  const a = point(i, j);
  const b = point(i + 1, j);
  const c = point(i, j + 1);
  const d = point(i + 1, j + 1);
  return [[a, c, b], [b, c, d]];
}
