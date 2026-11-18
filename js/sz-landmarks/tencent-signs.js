import * as THREE from 'three/webgpu';

// 两块楼顶招牌用透明底绘制，颜色与企鹅剪影按旧总部照片拟合。
export function tencentSignMaterial(style) {
  const badge = style === 'tencentBadge';
  const canvas = document.createElement('canvas');
  canvas.width = badge ? 256 : 768;
  canvas.height = badge ? 256 : 192;
  const ctx = canvas.getContext('2d');
  if (badge) {
    ctx.translate(128, 128);
    ctx.fillStyle = '#eef1ed';
    ctx.beginPath();
    ctx.arc(0, 0, 121, 0, 2 * Math.PI);
    ctx.fill();
    for (const [angle, color] of [[0, '#139168'], [120, '#cf405c'], [240, '#e6bc55']]) {
      ctx.save();
      ctx.rotate(angle * Math.PI / 180);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 121, -Math.PI / 2, Math.PI / 6);
      ctx.bezierCurveTo(109, -2, 65, -70, 12, -76);
      ctx.bezierCurveTo(-24, -79, -22, -112, 0, -121);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#0875b4';
    ctx.fill(new Path2D('M -35 8 Q -37 -37 -7 -42 Q 25 -49 32 -15 Q 34 -7 42 4 Q 49 15 37 14 L 32 13 Q 35 29 22 34 Q 37 45 9 42 Q -7 48 -26 41 Q -42 46 -39 36 L -31 25 Q -49 39 -45 22 Z'));
  } else {
    ctx.font = 'italic bold 152px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#198ab4';
    ctx.fillText('Tencent', 384, 102, 750);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map, alphaTest: 0.4, toneMapped: false });
  material.addEventListener('dispose', () => map.dispose());
  return material;
}
