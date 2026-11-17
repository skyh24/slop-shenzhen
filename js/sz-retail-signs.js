import * as THREE from 'three/webgpu';
import { attribute, mix, smoothstep, texture } from 'three/tsl';
import { cityUniforms } from './city-lighting-materials.js';
import { STR } from './sz-strings.js';

// 店招贴墙偏移、尺寸与图集容量：所有数值都是米或像素，保证同一街区每次生成一致。
export const SHOP_SIGN_OFFSET_M = 0.042;
export const SHOP_SIGN_BOTTOM_M = 2.9;
export const SHOP_SIGN_MIN_WIDTH_M = 2.0;
export const SHOP_SIGN_MAX_WIDTH_M = 3.2;
export const SHOP_SIGN_MIN_HEIGHT_M = 0.5;
export const SHOP_SIGN_MAX_HEIGHT_M = 0.72;
export const SHOP_SIGN_ATLAS_WIDTH = 2048;
export const SHOP_SIGN_ATLAS_HEIGHT = 1024;
export const SHOP_SIGN_PADDING = 2;

const ATLAS_SCALES = [64, 56, 48, 40, 32, 26];
const MIN_SLOT_WIDTH = 96;
const MIN_SLOT_HEIGHT = 34;
const SIGN_BACKGROUNDS = [0x24303a, 0x33241f, 0x1f3329, 0x2d2436, 0x3a2a1c, 0x1d2f33];
const SIGN_INKS = [0xf3e7cd, 0xffffff, 0xffd9a0, 0xcfe8ff];

const fractNumber = value => value - Math.floor(value);

// 店名只从通用示意词表里按 seed 取，禁止真实品牌。
export function shopSignName(seed) {
  const words = STR.retailShops;
  if (!words?.length) return '';
  const index = Math.floor(fractNumber(seed * 73.37 + 0.11) * words.length) % words.length;
  return words[index];
}

// 一栋楼夜间的发光店招占比：55%–75%，由楼栋 seed 决定后各开间再哈希。
export function shopSignLitShare(seed) {
  return 0.55 + 0.20 * fractNumber(seed * 0.731);
}

export function shopSignLit(seed, bayIndex) {
  return fractNumber(seed * 17.13 + bayIndex * 0.618 + 0.37) < shopSignLitShare(seed);
}

// 店招必须落在首层店招带（约 0.805–0.958 层高）内，且底面不低于 2.9m；
// 层高太矮时宁可不放，也不压低到人行上方。
export function shopSignRect(minY, storefrontHeight, bayWidth) {
  if (!(storefrontHeight >= 3.4) || !(bayWidth >= 2.4)) return null;
  const bottom = Math.max(minY + storefrontHeight * 0.805, minY + SHOP_SIGN_BOTTOM_M);
  const limitTop = minY + storefrontHeight * 0.958;
  const height = Math.min(SHOP_SIGN_MAX_HEIGHT_M, storefrontHeight * 0.145, limitTop - bottom);
  if (height < SHOP_SIGN_MIN_HEIGHT_M) return null;
  const width = Math.min(SHOP_SIGN_MAX_WIDTH_M, Math.max(SHOP_SIGN_MIN_WIDTH_M, bayWidth * 0.62), bayWidth - 0.4);
  if (width < SHOP_SIGN_MIN_WIDTH_M) return null;
  return { bottom, top: bottom + height, width, height };
}

// 货架式排版：一块 600m 块共用一张不超过 2048×1024 的图集，单元格互不重叠，
// 每个招牌的 uv 再内缩 padding，避免采样到相邻店铺的字；
// 排版完成后裁到实际占用尺寸，避免为十几块招牌分配 8MB 空图。
export function planShopSignAtlas(entries) {
  if (!entries?.length) return null;
  for (const scale of ATLAS_SCALES) {
    const tiles = [];
    let x = 0, y = 0, rowHeight = 0, overflow = false;
    for (const entry of entries) {
      const width = Math.max(MIN_SLOT_WIDTH, Math.round(entry.width * scale) + SHOP_SIGN_PADDING * 2);
      const height = Math.max(MIN_SLOT_HEIGHT, Math.round(entry.height * scale) + SHOP_SIGN_PADDING * 2);
      if (x + width > SHOP_SIGN_ATLAS_WIDTH) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      if (y + height > SHOP_SIGN_ATLAS_HEIGHT) {
        overflow = true;
        break;
      }
      const colorIndex = Math.floor(fractNumber((entry.seed ?? 0) * 5.13 + 0.27) * SIGN_BACKGROUNDS.length);
      tiles.push({
        x, y, width, height,
        name: entry.name,
        background: SIGN_BACKGROUNDS[colorIndex % SIGN_BACKGROUNDS.length],
        ink: SIGN_INKS[(colorIndex + 1) % SIGN_INKS.length]
      });
      x += width;
      rowHeight = Math.max(rowHeight, height);
    }
    if (!overflow) {
      let usedWidth = 0, usedHeight = 0;
      for (const tile of tiles) {
        usedWidth = Math.max(usedWidth, tile.x + tile.width);
        usedHeight = Math.max(usedHeight, tile.y + tile.height);
      }
      // 向上取到 2 的幂，保证 mipmap 完整、显存按块收敛（最小 64）。
      const pot = value => {
        let size = 64;
        while (size < value) size *= 2;
        return size;
      };
      return { width: pot(usedWidth), height: pot(usedHeight), scale, tiles };
    }
  }
  return null;
}

function drawShopSignPanel(ctx, tile) {
  const left = tile.x + SHOP_SIGN_PADDING, top = tile.y + SHOP_SIGN_PADDING;
  const width = tile.width - SHOP_SIGN_PADDING * 2, height = tile.height - SHOP_SIGN_PADDING * 2;
  ctx.fillStyle = `#${tile.background.toString(16).padStart(6, '0')}`;
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = `#${tile.ink.toString(16).padStart(6, '0')}`;
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = Math.max(2, Math.round(height * 0.06));
  ctx.strokeRect(left + ctx.lineWidth, top + ctx.lineWidth, width - ctx.lineWidth * 2, height - ctx.lineWidth * 2);
  ctx.globalAlpha = 1;
  const fontSize = Math.max(12, Math.round(height * 0.52));
  ctx.fillStyle = `#${tile.ink.toString(16).padStart(6, '0')}`;
  ctx.font = `700 ${fontSize}px 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tile.name, left + width / 2, top + height * 0.5, width * 0.92);
}

// 无 DOM（Node 测试）时返回 null，由调用方跳过店招 mesh，不影响建筑主体。
export function createShopSignTexture(layout) {
  if (!layout || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#15181a';
  ctx.fillRect(0, 0, layout.width, layout.height);
  for (const tile of layout.tiles) drawShopSignPanel(ctx, tile);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

// 纯数据几何：世界坐标四边形 + 图集 uv + 每个招牌的夜间发光标记，便于 Node 里直接断言。
export function buildShopSignGeometry(layout, entries) {
  const positions = [], normals = [], uvs = [], glows = [], indices = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tile = layout.tiles[i];
    const base = positions.length / 3;
    const u0 = (tile.x + SHOP_SIGN_PADDING) / layout.width;
    const u1 = (tile.x + tile.width - SHOP_SIGN_PADDING) / layout.width;
    const v0 = 1 - (tile.y + tile.height - SHOP_SIGN_PADDING) / layout.height;
    const v1 = 1 - (tile.y + SHOP_SIGN_PADDING) / layout.height;
    const corners = [
      [entry.ax, entry.y0, entry.az, u0, v0],
      [entry.bx, entry.y0, entry.bz, u1, v0],
      [entry.bx, entry.y1, entry.bz, u1, v1],
      [entry.ax, entry.y1, entry.az, u0, v1]
    ];
    for (const [x, y, z, u, v] of corners) {
      positions.push(x, y, z);
      normals.push(entry.nx, 0, entry.nz);
      uvs.push(u, v);
      glows.push(entry.glow ? 1 : 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, glows, indices };
}

export function createShopSignMaterial(map) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.54, metalness: 0.04 });
  const texel = texture(map);
  const glow = attribute('signGlow', 'float');
  const night = smoothstep(0.56, 1.45, cityUniforms.uInteriorGlow);
  material.colorNode = texel.rgb;
  material.roughnessNode = mix(0.74, 0.5, glow);
  // 只有被 seed 选中的店招夜里点亮，其余保持暗字，不再形成整条连续亮带。
  material.emissiveNode = texel.rgb.mul(glow).mul(night).mul(0.86);
  return material;
}
