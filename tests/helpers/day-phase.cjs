const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

// 测试替身：用真实的通道曲线，接上各测试自己伪造的 night / interiorGlow uniform。
// 这样模块测试不必重抄曲线常数，昼夜行为只有 sz-day-phase.js 一份。
const source = readFileSync(join(__dirname, '../../js/sz-day-phase.js'), 'utf8');
const phaseModule = loadModule(source);

function dayPhaseStub(night = 0, glow = () => 0.48) {
  const readNight = typeof night === 'function' ? night : () => night;
  return { ...phaseModule, dayPhase: phaseModule.createDayPhase().wire({ night: readNight, glow }) };
}

module.exports = { dayPhaseStub };
