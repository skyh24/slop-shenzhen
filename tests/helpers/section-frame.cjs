const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

// sz-section-frame 本身不 import 其他模块，可以直接整体加载。
module.exports = loadModule(readFileSync(join(__dirname, '../../js/sz-section-frame.js'), 'utf8'));
