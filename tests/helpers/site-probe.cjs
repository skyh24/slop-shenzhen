const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

// sz-site-probe 只依赖 building-collision：加载真实实现，运行期和测试共用一份探针口径。
const collision = loadModule(readFileSync(join(__dirname, '../../js/building-collision.js'), 'utf8'), {
  imports: { './sz-polygon.js': require('./polygon.cjs') }
});
module.exports = loadModule(readFileSync(join(__dirname, '../../js/sz-site-probe.js'), 'utf8'), {
  imports: { './building-collision.js': collision }
});
