const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

// sz-polygon.js 是不依赖其它模块的纯函数模块：测试直接加载真实实现，
// 运行时和单元测试因此共用同一份几何判定。
module.exports = loadModule(readFileSync(join(__dirname, '../../js/sz-polygon.js'), 'utf8'));
