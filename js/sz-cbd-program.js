// 原创节目以山顶视线为取样基准。纹理颜色只由参与楼宇的真实玻璃片元读取。
import * as THREE from 'three/webgpu';
import { clamp, float, Fn, If, positionWorld, texture, uniform, vec2, vec3 } from 'three/tsl';

export const CBD_PROGRAM_DURATION = 108;
export const CBD_CUES = Object.freeze([0, 36, 69, 100]);
const WIDTH = 768;
const HEIGHT = 256;
const SAMPLE_RATE = 15;
const VIEW = { left: -0.54, right: 0.54, bottom: -0.085, top: 0.275 };

export function cbdCue(seconds) {
  const time = ((seconds % CBD_PROGRAM_DURATION) + CBD_PROGRAM_DURATION) % CBD_PROGRAM_DURATION;
  const index = CBD_CUES.findLastIndex(start => start <= time);
  return { index, time, local: time - CBD_CUES[index] };
}

export function isCbdProgramBuilding(building) {
  const { cx, cz, height, facade } = building;
  return (facade === 'glass_tower' || facade === 'office') && height >= 65
    && cx >= -1550 && cx <= 1475 && cz >= -545 && cz <= 1690;
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function ellipse(ctx, x, y, rx, ry, rotation, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}

function polygon(ctx, points, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
  ctx.fill();
}

function flower(ctx, x, y, size, hue, progress, spin) {
  const radius = Math.max(2, size * progress);
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4 + spin;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    ellipse(ctx, x + dx * radius * 0.62, y + dy * radius * 0.62, radius * 0.54,
      radius * 0.31, angle, `hsl(${hue + i * 7} 95% ${60 + (i % 3) * 6}%)`);
  }
  ellipse(ctx, x, y, radius * 0.31, radius * 0.31, 0, '#ffe08b');
  ellipse(ctx, x, y, radius * 0.12, radius * 0.12, 0, '#fff6cf');
}

function bloom(ctx, t) {
  const blooms = [[120, 163, 43, 345], [228, 139, 50, 10], [298, 178, 39, 43],
    [523, 111, 69, 214], [648, 169, 53, 193], [725, 153, 42, 302]];
  blooms.forEach(([x, y, size, hue], index) => {
    const growth = smooth(index * 1.35, 7 + index * 1.35, t);
    const wave = 0.93 + Math.sin(t * 0.47 + index) * 0.07;
    const drift = smooth(12, 29, t) * 90;
    flower(ctx, x, y, size, hue + drift, growth * wave, t * 0.019 + index);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsl(${hue + drift} 90% 65% / ${growth * 0.45})`;
    ctx.beginPath();
    ctx.arc(x, y, size * growth * (1.26 + 0.07 * Math.sin(t + index)), 0, Math.PI * 2);
    ctx.stroke();
  });
}

function launch(ctx, t) {
  const rise = smooth(0.5, 28, t);
  const x = 523 + 1 * Math.sin(rise * Math.PI);
  const y = 211 - rise * 144;
  const flame = 39 + Math.sin(t * 2.4) * 5 + rise * 17;
  const plume = ctx.createLinearGradient(0, y + 18, 0, y + flame + 42);
  plume.addColorStop(0, '#fff0a6');
  plume.addColorStop(0.29, '#ff9c38');
  plume.addColorStop(0.65, '#ff536f');
  plume.addColorStop(1, '#ba50ff00');
  polygon(ctx, [[x - 8, y + 20], [x + 8, y + 20], [x + 13, y + flame],
    [x, y + flame + 42], [x - 13, y + flame]], plume);
  polygon(ctx, [[x, y - 53], [x + 8, y - 28], [x + 8, y + 10], [x + 13, y + 25],
    [x + 6, y + 21], [x - 6, y + 21], [x - 13, y + 25], [x - 8, y + 10],
    [x - 8, y - 28]], '#eef9ff');
  polygon(ctx, [[x, y - 53], [x + 8, y - 28], [x - 8, y - 28]], '#ff6268');
  ellipse(ctx, x, y - 13, 5.2, 7.5, 0, '#259ddc');
  for (let i = 0; i < 17; i++) {
    const px = 74 + i * 38;
    const py = 228 - ((t * (14 + i % 3 * 4) + i * 41) % 230);
    ellipse(ctx, px, py, 2, 5 + i % 3 * 3, 0, '#6dcbff');
  }
}

function cooperation(ctx, t) {
  for (let i = 0; i < 5; i++) {
    const shift = t * 0.17 + i * 0.94;
    ctx.beginPath();
    ctx.lineWidth = 5;
    ctx.strokeStyle = ['#6ce2ff', '#3c86fa', '#8c7aff', '#ffae75', '#51efc4'][i];
    for (let x = 0; x <= WIDTH; x += 4) {
      const envelope = Math.sin(Math.PI * x / WIDTH);
      const y = 174 + i * 8 + Math.sin(x * 0.009 + shift) * envelope * 26;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 38px sans-serif';
  const tint = ctx.createLinearGradient(0, 56, 0, 157);
  tint.addColorStop(0, '#fff4cf');
  tint.addColorStop(0.55, '#83e8ff');
  tint.addColorStop(1, '#59b0ff');
  ctx.fillStyle = tint;
  // 字母逐栋布置，留出市民中心上方及写字楼之间的自然空隙。
  [[120, 161, 21], [226, 161, 17], [523, 161, 14], [647, 161, 24]].forEach(([x, y, width], i) => {
    ctx.fillText('APEC'[i], x, y, width);
  });
  ctx.font = '900 23px sans-serif';
  for (let i = 0; i < 4; i++) ctx.fillText('APEC'[i], 523, 57 + i * 21, 11);
}

function finale(ctx, t) {
  for (let i = 0; i < 4; i++) {
    const radius = 22 + 35 * t + i * 23;
    ctx.beginPath();
    ctx.strokeStyle = ['#ffb881', '#73dfff', '#ad9dff', '#72e3cf'][i];
    ctx.lineWidth = 5;
    ctx.ellipse(WIDTH / 2, HEIGHT * 0.72, radius * 1.8, radius * 0.43, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

const drawCue = [bloom, launch, cooperation, finale];

export function createCbdProgram(origin, night) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = false;
  atlas.flipY = false;
  atlas.minFilter = THREE.LinearFilter;
  atlas.magFilter = THREE.LinearFilter;

  const enabled = uniform(0);
  const x = positionWorld.x.sub(origin.x);
  const z = positionWorld.z.sub(origin.z);
  const depth = z.max(1);
  // 从南向看时屏幕右为西；世界空间取样不会跟随玩家相机。
  const u = x.negate().div(depth).sub(VIEW.left).div(VIEW.right - VIEW.left);
  const v = positionWorld.y.sub(origin.y).div(depth).sub(VIEW.bottom).div(VIEW.top - VIEW.bottom);

  function emission(base, pane) {
    return Fn(() => {
      const result = base.toVar();
      If(enabled.greaterThan(0).and(night.greaterThan(0.32)), () => {
        const inside = z.greaterThan(100).and(u.greaterThan(0)).and(u.lessThan(1))
          .and(v.greaterThan(0)).and(v.lessThan(1));
        const showMask = inside.select(1, 0).mul(clamp(night.sub(0.32).div(0.40), 0, 1));
        const picture = texture(atlas, vec2(u, float(1).sub(v))).rgb;
        const display = picture.mul(2.25).add(vec3(0.014, 0.028, 0.049));
        result.assign(base.mul(showMask.mul(-0.8).add(1)).add(display.mul(pane).mul(showMask)));
      });
      return result;
    })();
  }

  let total = 0;
  let paused = false;
  let lastFrame = -1;
  let visibleSince = null;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) visibleSince = performance.now();
  });
  function render(force = false) {
    const cue = cbdCue(total);
    const frame = Math.floor(cue.time * SAMPLE_RATE);
    if (!force && frame === lastFrame) return;
    lastFrame = frame;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const length = (CBD_CUES[cue.index + 1] ?? CBD_PROGRAM_DURATION) - CBD_CUES[cue.index];
    ctx.globalAlpha = smooth(0, 2.8, cue.local) * (1 - smooth(length - 3.4, length, cue.local));
    drawCue[cue.index](ctx, cue.local);
    ctx.globalAlpha = 1;
    atlas.needsUpdate = true;
  }

  render(true);
  return {
    emission,
    get active() { return enabled.value === 1; },
    get paused() { return paused; },
    get time() { return total; },
    get cue() { return cbdCue(total).index; },
    get statistics() { return { textures: 1, width: WIDTH, height: HEIGHT, updateHz: SAMPLE_RATE }; },
    start() { enabled.value = 1; this.replay(); },
    replay() { total = 0; paused = false; render(true); },
    togglePause() { paused = !paused; },
    stop() { enabled.value = 0; paused = false; },
    update(dt) {
      if (!this.active || paused || document.hidden) return;
      const visibleDt = visibleSince === null ? dt : (performance.now() - visibleSince) / 1000;
      visibleSince = null;
      total += Math.max(0, Math.min(dt, visibleDt));
      if (night.value > 0.32) render();
    }
  };
}
