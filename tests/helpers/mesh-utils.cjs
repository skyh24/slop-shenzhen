const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

const source = readFileSync(join(__dirname, '../../js/sz-mesh-utils.js'), 'utf8');

// three 版本由调用方决定：只测布点计划的用例传空 stub，真实构建的用例传 0.187.0。
// globals 透传被测模块用的假 canvas 环境：贴图在三个模块共用后，draw 调用发生在 mesh-utils 的上下文里。
module.exports = (THREE, globals = {}) => loadModule(source, { imports: { 'three/webgpu': THREE }, globals });
